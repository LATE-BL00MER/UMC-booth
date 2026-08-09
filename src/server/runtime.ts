import type { AppConfig } from "../shared/config";
import type { SessionStats } from "./session-store";
import type { RuntimeStatus, RuntimeStatusProvider } from "./types";
import type { TunnelStatus } from "./tunnel-supervisor";

const loopbackHost = "127.0.0.1";
const defaultSafetyStepTimeoutMs = 5_000;
const defaultTunnelStartupTimeoutMs = 30_000;

export interface RuntimeServer {
  listen(options: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
}

export interface RuntimeStore {
  initialize(): Promise<void>;
  sweep(): Promise<{ deletedPending: number; deletedExpired: number }>;
  purgeAll(): Promise<number>;
  stats(): Promise<SessionStats>;
}

export interface RuntimeTunnel {
  start(publicLoopbackUrl: string): Promise<void>;
  stop(): void | Promise<void>;
  status(): TunnelStatus;
}

export interface RuntimeTimers {
  setInterval(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearInterval(timer: unknown): void;
  setTimeout?(callback: () => void, delayMs: number): unknown;
  clearTimeout?(timer: unknown): void;
}

export interface RuntimeSignals {
  once(signal: NodeJS.Signals, listener: () => void): void;
  off(signal: NodeJS.Signals, listener: () => void): void;
}

export interface RuntimeMetrics {
  drainPersistence(): Promise<void>;
}

export interface RuntimeDependencies {
  config: AppConfig;
  store: RuntimeStore;
  createPublicServer(): RuntimeServer;
  createPrivateServer(runtimeStatus: RuntimeStatusProvider): RuntimeServer;
  tunnel?: RuntimeTunnel;
  metrics?: RuntimeMetrics;
  timers?: RuntimeTimers;
  signals?: RuntimeSignals;
  exit?: (code: number) => void;
  safetyStepTimeoutMs?: number;
  startupStepTimeoutMs?: number;
  tunnelStartupTimeoutMs?: number;
}

export interface EventRuntime extends RuntimeStatusProvider {
  start(): Promise<void>;
  stop(options: { purge: boolean }): Promise<void>;
}

interface StartupContext {
  generation: number;
  cancelled: Promise<void>;
  cancel(): void;
}

type OperationOutcome<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected" };

type PreflightOutcome<T> = OperationOutcome<T> | { status: "timeout" | "cancelled" };

const defaultTimers: RuntimeTimers = {
  setInterval: (callback, delayMs) => setInterval(() => void callback(), delayMs),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const defaultSignals: RuntimeSignals = {
  once: (signal, listener) => process.once(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};

export function createRuntime(deps: RuntimeDependencies): EventRuntime {
  const timers = deps.timers ?? defaultTimers;
  const signals = deps.signals ?? defaultSignals;
  const exit = deps.exit ?? ((code) => process.exit(code));
  const safetyStepTimeoutMs = deps.safetyStepTimeoutMs ?? defaultSafetyStepTimeoutMs;
  const startupStepTimeoutMs = deps.startupStepTimeoutMs
    ?? deps.tunnelStartupTimeoutMs
    ?? defaultTunnelStartupTimeoutMs;
  const tunnel = tunnelFor(deps);
  let publicServer: RuntimeServer | null = null;
  let privateServer: RuntimeServer | null = null;
  let sweepTimer: unknown = null;
  let sweepHealthy = false;
  let sweepQueue: Promise<void> = Promise.resolve();
  let sweepQueueOwner: { generation: number; promise: Promise<void> } | null = null;
  let runtimeGeneration = 0;
  let started = false;
  let acceptingCaptures = false;
  let shutdownRequested = false;
  let signalHandlersInstalled = false;
  let startupPromise: Promise<void> | null = null;
  let startupContext: StartupContext | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let tunnelCleanupRequired = false;
  const pendingLifecycleWork = new Set<Promise<unknown>>();
  const serverCloseOperations = new WeakMap<RuntimeServer, Promise<boolean>>();

  const runtime: EventRuntime = {
    start() {
      if (started) return Promise.resolve();
      if (startupPromise !== null) return startupPromise;
      if (sweepQueueOwner !== null || pendingLifecycleWork.size > 0) {
        return Promise.reject(new Error("Runtime lifecycle work is still pending"));
      }
      try {
        assertLocalMode(deps.config);
      } catch (error) {
        return Promise.reject(error);
      }
      shutdownRequested = false;
      acceptingCaptures = false;
      installSignalHandlers();
      const generation = ++runtimeGeneration;
      const context = createStartupContext(generation);
      startupContext = context;

      const starting = startRuntime(context).finally(() => {
        if (startupPromise === starting) startupPromise = null;
        if (startupContext === context) startupContext = null;
      });
      startupPromise = starting;
      return starting;
    },

    async getStatus(): Promise<RuntimeStatus> {
      const [stats, tunnelStatus] = await Promise.all([
        deps.store.stats(),
        Promise.resolve(tunnel.status()),
      ]);
      return {
        tunnel: tunnelStatus.state,
        publicUrl: tunnelStatus.publicUrl,
        publicLatencyMs: tunnelStatus.latencyMs,
        lastSweepAt: stats.lastSweepAt,
        pendingSessions: stats.pending,
        activeSessions: stats.active,
        encryptedBytes: stats.encryptedBytes,
        acceptingCaptures: acceptingCaptures
          && started
          && sweepHealthy
          && tunnelStatus.state === "healthy"
          && tunnelStatus.publicUrl !== null,
      };
    },

    async stop(options: { purge: boolean }): Promise<void> {
      startupContext?.cancel();
      runtimeGeneration += 1;
      shutdownRequested = true;
      acceptingCaptures = false;
      started = false;
      removeSignalHandlers();
      if (sweepTimer !== null) {
        timers.clearInterval(sweepTimer);
        sweepTimer = null;
      }
      await Promise.resolve();
      const inheritedLifecycleWork = [...pendingLifecycleWork];
      const errors: unknown[] = [];
      const ownedSweep = sweepQueueOwner;
      await attempt(() => ownedSweep?.promise ?? sweepQueue, "queued sweep", errors);
      if (options.purge) {
        await attempt(() => deps.store.purgeAll(), "initial purge", errors);
      }
      await stopTunnel("tunnel stop", errors);
      if (inheritedLifecycleWork.length > 0) {
        await attempt(
          () => Promise.all(inheritedLifecycleWork),
          "pending lifecycle work",
          errors,
        );
      }
      if (privateServer !== null) {
        await closeServer(privateServer, "private", "private listener close", errors);
      }
      if (options.purge) {
        await attempt(() => deps.store.purgeAll(), "definitive purge", errors);
      }
      if (publicServer !== null) {
        await closeServer(publicServer, "public", "public listener close", errors);
      }
      if (deps.metrics) {
        await attempt(() => deps.metrics!.drainPersistence(), "metrics drain", errors);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Runtime shutdown was incomplete");
      }
    },

    requestShutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        try {
          await runtime.stop({ purge: true });
          exit(0);
        } catch {
          exit(1);
        }
      })().finally(() => {
        shutdownPromise = null;
      });
      return shutdownPromise;
    },
  };

  async function startRuntime(context: StartupContext): Promise<void> {
    const retainedCleanupErrors: unknown[] = [];
    if (tunnelCleanupRequired) {
      await stopTunnel("retained tunnel stop", retainedCleanupErrors);
    }
    if (privateServer !== null) {
      await closeServer(privateServer, "private", "retained private listener close", retainedCleanupErrors);
    }
    if (publicServer !== null) {
      await closeServer(publicServer, "public", "retained public listener close", retainedCleanupErrors);
    }
    if (tunnelCleanupRequired || privateServer !== null || publicServer !== null || retainedCleanupErrors.length > 0) {
      removeSignalHandlers();
      throw new AggregateError(retainedCleanupErrors, "Runtime retained cleanup was incomplete");
    }

    try {
      await runPreflightStep(context, "store initialize", () => deps.store.initialize());
      if (deps.config.tunnelMode === "local") {
        await runPreflightStep(context, "local startup purge", () => deps.store.purgeAll());
      }
      await runPreflightStep(context, "initial sweep", async () => {
        if (!await enqueueSweep(context.generation)) throw new Error("Initial sweep failed");
      });
      sweepHealthy = true;

      const publicCandidate = deps.createPublicServer();
      await runPreflightStep(
        context,
        "public listener start",
        () => publicCandidate.listen({ host: loopbackHost, port: deps.config.publicPort }),
        () => closeLateServer(publicCandidate, "public"),
      );
      assertStartupActive(context.generation);
      publicServer = publicCandidate;

      const privateCandidate = deps.createPrivateServer(runtime);
      await runPreflightStep(
        context,
        "private listener start",
        () => privateCandidate.listen({ host: loopbackHost, port: deps.config.privatePort }),
        () => closeLateServer(privateCandidate, "private"),
      );
      assertStartupActive(context.generation);
      privateServer = privateCandidate;

      tunnelCleanupRequired = true;
      await runPreflightStep(
        context,
        "tunnel startup",
        () => tunnel.start(`http://${loopbackHost}:${deps.config.publicPort}`),
        closeLateTunnel,
      );
      assertStartupActive(context.generation);
      const tunnelStatus = tunnel.status();
      if (tunnelStatus.state !== "healthy" || tunnelStatus.publicUrl === null) {
        throw new Error("Public tunnel preflight failed");
      }

      started = true;
      acceptingCaptures = true;
      sweepTimer = timers.setInterval(() => runSweep(context.generation), deps.config.sweepIntervalMs);
    } catch {
      acceptingCaptures = false;
      started = false;
      sweepHealthy = false;
      if (shutdownRequested) {
        throw new Error("Runtime startup failed");
      }
      const cleanupErrors = await rollbackStartedComponents();
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [new Error("startup preflight failed"), ...cleanupErrors],
          "Runtime startup failed",
        );
      }
      throw new Error("Runtime startup failed");
    }
  }

  async function runPreflightStep<T>(
    context: StartupContext,
    label: string,
    operation: () => T | Promise<T>,
    onLateSuccess?: (value: T) => void | Promise<void>,
  ): Promise<T> {
    let settled = false;
    const observed = observeOperation(operation).then((outcome) => {
      settled = true;
      return outcome;
    });
    let timer: unknown;
    const timeout = new Promise<PreflightOutcome<T>>((resolve) => {
      timer = setRuntimeTimeout(() => resolve({ status: "timeout" }), startupStepTimeoutMs);
    });
    const cancellation = context.cancelled.then<PreflightOutcome<T>>(() => ({ status: "cancelled" }));

    try {
      const outcome = await Promise.race<PreflightOutcome<T>>([observed, timeout, cancellation]);
      if (outcome.status === "fulfilled") return outcome.value;
      if ((outcome.status === "timeout" || outcome.status === "cancelled") && !settled) {
        trackLateOperation(observed, onLateSuccess);
      }
      throw new Error(`${label} failed`);
    } finally {
      if (timer !== undefined) clearRuntimeTimeout(timer);
    }
  }

  function observeOperation<T>(operation: () => T | Promise<T>): Promise<OperationOutcome<T>> {
    return Promise.resolve().then(operation).then(
      (value) => ({ status: "fulfilled", value }),
      () => ({ status: "rejected" }),
    );
  }

  function trackLateOperation<T>(
    observed: Promise<OperationOutcome<T>>,
    onLateSuccess?: (value: T) => void | Promise<void>,
  ): void {
    let tracked!: Promise<void>;
    tracked = (async () => {
      const outcome = await observed;
      if (outcome.status === "fulfilled" && onLateSuccess) {
        await onLateSuccess(outcome.value);
      }
    })().catch(() => undefined).finally(() => {
      pendingLifecycleWork.delete(tracked);
    });
    pendingLifecycleWork.add(tracked);
  }

  async function closeLateServer(server: RuntimeServer, surface: "private" | "public"): Promise<void> {
    if (surface === "private") privateServer = server;
    else publicServer = server;
    const errors: unknown[] = [];
    await closeServer(server, surface, `late ${surface} listener close`, errors);
  }

  async function closeLateTunnel(): Promise<void> {
    if (!tunnelCleanupRequired) return;
    const errors: unknown[] = [];
    await stopTunnel("late tunnel stop", errors);
  }

  function runSweep(generation: number): Promise<void> {
    return enqueueSweep(generation).then((success) => {
      if (runtimeGeneration === generation && started) sweepHealthy = success;
    });
  }

  function enqueueSweep(generation: number): Promise<boolean> {
    const result = sweepQueue.then(() => deps.store.sweep()).then(
      () => true,
      () => false,
    );
    const queued = result.then(() => undefined);
    const owner = { generation, promise: queued };
    sweepQueue = queued;
    sweepQueueOwner = owner;
    void queued.finally(() => {
      if (sweepQueueOwner === owner) sweepQueueOwner = null;
    });
    return result;
  }

  function requestSignalShutdown(): void {
    void runtime.requestShutdown();
  }

  function installSignalHandlers(): void {
    if (signalHandlersInstalled) return;
    signals.once("SIGINT", requestSignalShutdown);
    signals.once("SIGTERM", requestSignalShutdown);
    signalHandlersInstalled = true;
  }

  function removeSignalHandlers(): void {
    if (!signalHandlersInstalled) return;
    signals.off("SIGINT", requestSignalShutdown);
    signals.off("SIGTERM", requestSignalShutdown);
    signalHandlersInstalled = false;
  }

  async function rollbackStartedComponents(): Promise<unknown[]> {
    if (sweepTimer !== null) {
      timers.clearInterval(sweepTimer);
      sweepTimer = null;
    }
    removeSignalHandlers();
    const errors: unknown[] = [];
    await attempt(() => deps.store.purgeAll(), "startup initial purge", errors);
    await stopTunnel("startup tunnel stop", errors);
    if (privateServer !== null) {
      await closeServer(privateServer, "private", "startup private listener close", errors);
    }
    await attempt(() => deps.store.purgeAll(), "startup definitive purge", errors);
    if (publicServer !== null) {
      await closeServer(publicServer, "public", "startup public listener close", errors);
    }
    return errors;
  }

  function assertStartupActive(generation: number): void {
    if (shutdownRequested || runtimeGeneration !== generation) throw new Error("Runtime startup cancelled");
  }

  async function attempt(
    operation: () => unknown | Promise<unknown>,
    label: string,
    errors: unknown[],
    onLateSuccess?: () => void | Promise<void>,
  ): Promise<boolean> {
    let settled = false;
    const observed = observeOperation(operation).then((outcome) => {
      settled = true;
      return outcome;
    });
    let timer: unknown;
    const timeout = new Promise<{ status: "timeout" }>((resolve) => {
      timer = setRuntimeTimeout(() => resolve({ status: "timeout" }), safetyStepTimeoutMs);
    });
    try {
      const outcome = await Promise.race([observed, timeout]);
      if (outcome.status === "fulfilled") return true;
      if (outcome.status === "timeout" && !settled) {
        trackLateOperation(observed, onLateSuccess ? () => onLateSuccess() : undefined);
      }
      errors.push(new Error(`${label} failed`));
      return false;
    } finally {
      if (timer !== undefined) clearRuntimeTimeout(timer);
    }
  }

  async function closeServer(
    server: RuntimeServer,
    surface: "private" | "public",
    label: string,
    errors: unknown[],
  ): Promise<boolean> {
    let closing = serverCloseOperations.get(server);
    if (!closing) {
      const observed = Promise.resolve()
        .then(() => server.close())
        .then(
          () => {
            if (surface === "private" && privateServer === server) privateServer = null;
            if (surface === "public" && publicServer === server) publicServer = null;
            return true;
          },
          () => false,
        );
      let tracked!: Promise<boolean>;
      tracked = observed.finally(() => {
        pendingLifecycleWork.delete(tracked);
        serverCloseOperations.delete(server);
      });
      pendingLifecycleWork.add(tracked);
      serverCloseOperations.set(server, tracked);
      closing = tracked;
    }

    try {
      const closed = await withDeadline(() => closing!, label, safetyStepTimeoutMs);
      if (!closed) errors.push(new Error(`${label} failed`));
      return closed;
    } catch {
      errors.push(new Error(`${label} failed`));
      return false;
    }
  }

  async function stopTunnel(label: string, errors: unknown[]): Promise<boolean> {
    tunnelCleanupRequired = false;
    const stopped = await attempt(
      () => tunnel.stop(),
      label,
      errors,
      () => { tunnelCleanupRequired = false; },
    );
    tunnelCleanupRequired = !stopped;
    return stopped;
  }

  async function withDeadline<T>(
    operation: () => T | Promise<T>,
    label: string,
    timeoutMs: number,
  ): Promise<T> {
    let timer: unknown;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setRuntimeTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(operation), timeout]);
    } finally {
      if (timer !== undefined) clearRuntimeTimeout(timer);
    }
  }

  function setRuntimeTimeout(callback: () => void, delayMs: number): unknown {
    return timers.setTimeout
      ? timers.setTimeout(callback, delayMs)
      : setTimeout(callback, delayMs);
  }

  function clearRuntimeTimeout(timer: unknown): void {
    if (timers.clearTimeout) {
      timers.clearTimeout(timer);
    } else {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    }
  }

  return runtime;
}

function assertLocalMode(config: AppConfig): void {
  if (config.tunnelMode !== "local") return;
  if (config.nodeEnv !== "test") {
    throw new Error("Local tunnel mode is test-only");
  }
  if (config.localPublicBaseUrl === null) {
    throw new Error("LOCAL_PUBLIC_BASE_URL is required in local tunnel mode");
  }
}

function createStartupContext(generation: number): StartupContext {
  let resolveCancellation!: () => void;
  let cancelled = false;
  const cancellation = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  return {
    generation,
    cancelled: cancellation,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      resolveCancellation();
    },
  };
}

function tunnelFor(deps: RuntimeDependencies): RuntimeTunnel {
  if (deps.config.tunnelMode === "local") {
    return new StaticTunnelSupervisor(deps.config.localPublicBaseUrl);
  }
  if (!deps.tunnel) {
    throw new Error("A tunnel supervisor is required in quick mode");
  }
  return deps.tunnel;
}

class StaticTunnelSupervisor implements RuntimeTunnel {
  private readonly publicUrl: string | null;
  private running = false;

  constructor(publicUrl: string | null) {
    this.publicUrl = publicUrl;
  }

  async start(): Promise<void> {
    if (this.publicUrl === null) {
      throw new Error("LOCAL_PUBLIC_BASE_URL is required in local tunnel mode");
    }
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  status(): TunnelStatus {
    return this.running
      ? { state: "healthy", publicUrl: this.publicUrl, latencyMs: 0, error: null }
      : { state: "down", publicUrl: null, latencyMs: null, error: null };
  }
}

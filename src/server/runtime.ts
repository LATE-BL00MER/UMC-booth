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
  tunnelStartupTimeoutMs?: number;
}

export interface EventRuntime extends RuntimeStatusProvider {
  start(): Promise<void>;
  stop(options: { purge: boolean }): Promise<void>;
}

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
  const tunnelStartupTimeoutMs = deps.tunnelStartupTimeoutMs ?? defaultTunnelStartupTimeoutMs;
  const tunnel = tunnelFor(deps);
  let publicServer: RuntimeServer | null = null;
  let privateServer: RuntimeServer | null = null;
  let sweepTimer: unknown = null;
  let sweepHealthy = false;
  let sweepQueue: Promise<void> = Promise.resolve();
  let started = false;
  let acceptingCaptures = false;
  let shutdownRequested = false;
  let signalHandlersInstalled = false;
  let startupPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const runtime: EventRuntime = {
    start() {
      if (started) return Promise.resolve();
      if (startupPromise !== null) return startupPromise;
      try {
        assertLocalMode(deps.config);
      } catch (error) {
        return Promise.reject(error);
      }
      shutdownRequested = false;
      acceptingCaptures = false;
      installSignalHandlers();

      const starting = startRuntime().finally(() => {
        if (startupPromise === starting) startupPromise = null;
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
      shutdownRequested = true;
      acceptingCaptures = false;
      started = false;
      removeSignalHandlers();
      if (sweepTimer !== null) {
        timers.clearInterval(sweepTimer);
        sweepTimer = null;
      }
      const errors: unknown[] = [];
      await attempt(() => sweepQueue, "queued sweep", errors);
      if (options.purge) {
        await attempt(() => deps.store.purgeAll(), "initial purge", errors);
      }
      await attempt(() => tunnel.stop(), "tunnel stop", errors);
      if (privateServer !== null) {
        const server = privateServer;
        if (await attempt(() => server.close(), "private listener close", errors)) {
          privateServer = null;
        }
      }
      if (options.purge) {
        await attempt(() => deps.store.purgeAll(), "definitive purge", errors);
      }
      if (publicServer !== null) {
        const server = publicServer;
        if (await attempt(() => server.close(), "public listener close", errors)) {
          publicServer = null;
        }
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

  async function startRuntime(): Promise<void> {
    try {
      await deps.store.initialize();
      assertStartupActive();
      if (deps.config.tunnelMode === "local") {
        await deps.store.purgeAll();
        assertStartupActive();
      }
      await deps.store.sweep();
      assertStartupActive();
      sweepHealthy = true;

      publicServer = deps.createPublicServer();
      await publicServer.listen({ host: loopbackHost, port: deps.config.publicPort });
      assertStartupActive();
      privateServer = deps.createPrivateServer(runtime);
      await privateServer.listen({ host: loopbackHost, port: deps.config.privatePort });
      assertStartupActive();

      await withDeadline(
        () => tunnel.start(`http://${loopbackHost}:${deps.config.publicPort}`),
        "tunnel startup",
        tunnelStartupTimeoutMs,
      );
      assertStartupActive();
      const tunnelStatus = tunnel.status();
      if (tunnelStatus.state !== "healthy" || tunnelStatus.publicUrl === null) {
        throw new Error("Public tunnel preflight failed");
      }

      started = true;
      acceptingCaptures = true;
      sweepTimer = timers.setInterval(runSweep, deps.config.sweepIntervalMs);
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

  function runSweep(): Promise<void> {
    const scheduled = sweepQueue.then(async () => {
      try {
        await deps.store.sweep();
        sweepHealthy = true;
      } catch {
        sweepHealthy = false;
      }
    });
    sweepQueue = scheduled.catch(() => undefined);
    return scheduled;
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
    await attempt(() => tunnel.stop(), "startup tunnel stop", errors);
    if (privateServer !== null) {
      const server = privateServer;
      if (await attempt(() => server.close(), "startup private listener close", errors)) {
        privateServer = null;
      }
    }
    await attempt(() => deps.store.purgeAll(), "startup definitive purge", errors);
    if (publicServer !== null) {
      const server = publicServer;
      if (await attempt(() => server.close(), "startup public listener close", errors)) {
        publicServer = null;
      }
    }
    return errors;
  }

  function assertStartupActive(): void {
    if (shutdownRequested) throw new Error("Runtime startup cancelled");
  }

  async function attempt(
    operation: () => unknown | Promise<unknown>,
    label: string,
    errors: unknown[],
  ): Promise<boolean> {
    try {
      await withDeadline(operation, label, safetyStepTimeoutMs);
      return true;
    } catch {
      errors.push(new Error(`${label} failed`));
      return false;
    }
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

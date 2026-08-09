import type { AppConfig } from "../shared/config";
import type { SessionStats } from "./session-store";
import type { RuntimeStatus, RuntimeStatusProvider } from "./types";
import type { TunnelStatus } from "./tunnel-supervisor";

const loopbackHost = "127.0.0.1";

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
}

export interface RuntimeSignals {
  once(signal: NodeJS.Signals, listener: () => void): void;
  off(signal: NodeJS.Signals, listener: () => void): void;
}

export interface RuntimeDependencies {
  config: AppConfig;
  store: RuntimeStore;
  createPublicServer(): RuntimeServer;
  createPrivateServer(runtimeStatus: RuntimeStatusProvider): RuntimeServer;
  tunnel?: RuntimeTunnel;
  timers?: RuntimeTimers;
  signals?: RuntimeSignals;
  exit?: (code: number) => void;
}

export interface EventRuntime extends RuntimeStatusProvider {
  start(): Promise<void>;
  stop(options: { purge: boolean }): Promise<void>;
}

const defaultTimers: RuntimeTimers = {
  setInterval: (callback, delayMs) => setInterval(() => void callback(), delayMs),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

const defaultSignals: RuntimeSignals = {
  once: (signal, listener) => process.once(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};

export function createRuntime(deps: RuntimeDependencies): EventRuntime {
  const timers = deps.timers ?? defaultTimers;
  const signals = deps.signals ?? defaultSignals;
  const exit = deps.exit ?? ((code) => process.exit(code));
  const tunnel = tunnelFor(deps);
  let publicServer: RuntimeServer | null = null;
  let privateServer: RuntimeServer | null = null;
  let sweepTimer: unknown = null;
  let sweepHealthy = false;
  let sweepQueue: Promise<void> = Promise.resolve();
  let started = false;
  let acceptingCaptures = false;
  let shutdownPromise: Promise<void> | null = null;

  const runtime: EventRuntime = {
    async start() {
      if (started) return;
      assertLocalMode(deps.config);
      acceptingCaptures = false;

      try {
        await deps.store.initialize();
        if (deps.config.tunnelMode === "local") {
          await deps.store.purgeAll();
        }
        await deps.store.sweep();
        sweepHealthy = true;

        publicServer = deps.createPublicServer();
        await publicServer.listen({ host: loopbackHost, port: deps.config.publicPort });
        privateServer = deps.createPrivateServer(runtime);
        await privateServer.listen({ host: loopbackHost, port: deps.config.privatePort });

        await tunnel.start(`http://${loopbackHost}:${deps.config.publicPort}`);
        const tunnelStatus = tunnel.status();
        if (tunnelStatus.state !== "healthy" || tunnelStatus.publicUrl === null) {
          throw new Error("Public tunnel preflight failed");
        }

        started = true;
        acceptingCaptures = true;
        sweepTimer = timers.setInterval(runSweep, deps.config.sweepIntervalMs);
        signals.once("SIGINT", requestSignalShutdown);
        signals.once("SIGTERM", requestSignalShutdown);
      } catch (error) {
        acceptingCaptures = false;
        sweepHealthy = false;
        await closeStartedComponents();
        throw error;
      }
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
      acceptingCaptures = false;
      started = false;
      removeSignalHandlers();
      if (sweepTimer !== null) {
        timers.clearInterval(sweepTimer);
        sweepTimer = null;
      }
      await sweepQueue;
      const errors: unknown[] = [];
      if (options.purge) {
        try {
          await deps.store.purgeAll();
        } catch {
          // The definitive purge runs after the private listener drains.
        }
      }
      await attempt(() => tunnel.stop(), errors);
      if (privateServer !== null) {
        const server = privateServer;
        if (await attempt(() => server.close(), errors)) {
          privateServer = null;
        }
      }
      if (options.purge) {
        await attempt(() => deps.store.purgeAll(), errors);
      }
      if (publicServer !== null) {
        const server = publicServer;
        if (await attempt(() => server.close(), errors)) {
          publicServer = null;
        }
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

  function removeSignalHandlers(): void {
    signals.off("SIGINT", requestSignalShutdown);
    signals.off("SIGTERM", requestSignalShutdown);
  }

  async function closeStartedComponents(): Promise<void> {
    if (sweepTimer !== null) {
      timers.clearInterval(sweepTimer);
      sweepTimer = null;
    }
    removeSignalHandlers();
    await tunnel.stop();
    if (privateServer !== null) {
      await privateServer.close();
      privateServer = null;
    }
    if (publicServer !== null) {
      await publicServer.close();
      publicServer = null;
    }
  }

  return runtime;
}

async function attempt(operation: () => unknown | Promise<unknown>, errors: unknown[]): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    errors.push(error);
    return false;
  }
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

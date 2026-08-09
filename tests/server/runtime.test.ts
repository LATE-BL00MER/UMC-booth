import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/shared/config";
import { AggregateMetrics, type MetricsFileSystem } from "../../src/server/metrics";
import { createRuntime, type RuntimeDependencies, type RuntimeServer, type RuntimeTimers } from "../../src/server/runtime";
import { FileSessionStore } from "../../src/server/session-store";
import type { RuntimeStatusProvider } from "../../src/server/types";
import type { TunnelStatus } from "../../src/server/tunnel-supervisor";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    joinSiteUrl: "https://join.example.test",
    privatePort: 4173,
    publicPort: 4174,
    sessionDir: "/tmp/umc-runtime-tests",
    framePackDir: "/tmp/umc-runtime-frames",
    poseConfigPath: "/tmp/umc-runtime-poses.json",
    tunnelMode: "quick",
    localPublicBaseUrl: null,
    countdownSeconds: 5,
    captureCount: 6,
    selectedCount: 4,
    activeTtlMs: 600_000,
    pendingTtlMs: 120_000,
    sweepIntervalMs: 30_000,
    countdownTickMs: 1_000,
    ...overrides,
  };
}

function createHarness(overrides: Partial<RuntimeDependencies> = {}) {
  const order: string[] = [];
  const listenCalls: Array<{ host: string; port: number; surface: "public" | "private" }> = [];
  let lastSweepAt: number | null = null;
  let sweepError: Error | null = null;
  let tunnelStatus: TunnelStatus = {
    state: "healthy",
    publicUrl: "https://booth.trycloudflare.com",
    latencyMs: 17,
    error: null,
  };
  let interval: (() => void | Promise<void>) | null = null;
  let intervalMs: number | null = null;
  let runtimeStatus: RuntimeStatusProvider | null = null;
  let acceptingAtPurge: boolean | null = null;
  const signalListeners = new Map<NodeJS.Signals, () => void>();

  const server = (surface: "public" | "private"): RuntimeServer => ({
    listen: async ({ host, port }) => {
      order.push(`${surface}:listen`);
      listenCalls.push({ host, port, surface });
      return `http://${host}:${port}`;
    },
    close: async () => {
      order.push(`${surface}:close`);
    },
  });
  const timers: RuntimeTimers = {
    setInterval(callback, delayMs) {
      interval = callback;
      intervalMs = delayMs;
      return callback;
    },
    clearInterval() {
      interval = null;
    },
  };
  const dependencies: RuntimeDependencies = {
    config: config(),
    store: {
      initialize: async () => {
        order.push("store:initialize");
      },
      sweep: async () => {
        order.push("store:sweep");
        if (sweepError) throw sweepError;
        lastSweepAt = 1_000;
        return { deletedPending: 0, deletedExpired: 0 };
      },
      purgeAll: async () => {
        acceptingAtPurge = runtimeStatus === null ? null : (await runtimeStatus.getStatus()).acceptingCaptures;
        order.push("store:purge-all");
        return 0;
      },
      stats: async () => ({ pending: 2, active: 3, encryptedBytes: 42, lastSweepAt }),
    },
    createPublicServer: () => server("public"),
    createPrivateServer: (status) => {
      runtimeStatus = status;
      return server("private");
    },
    tunnel: {
      start: async (url) => {
        order.push(`tunnel:start:${url}`);
      },
      stop: async () => {
        order.push("tunnel:stop");
      },
      status: () => ({ ...tunnelStatus }),
    },
    timers,
    signals: {
      once(signal, listener) {
        signalListeners.set(signal, listener);
      },
      off(signal, listener) {
        if (signalListeners.get(signal) === listener) signalListeners.delete(signal);
      },
    },
    exit: vi.fn(),
    ...overrides,
  };

  return {
    dependencies,
    order,
    listenCalls,
    intervalMs: () => intervalMs,
    fireSweep: async () => {
      if (interval === null) throw new Error("Sweep was not scheduled");
      await interval();
    },
    setSweepError(error: Error | null) {
      sweepError = error;
    },
    setTunnelStatus(status: TunnelStatus) {
      tunnelStatus = status;
    },
    signal(signal: NodeJS.Signals) {
      signalListeners.get(signal)?.();
    },
    acceptingAtPurge: () => acceptingAtPurge,
  };
}

describe("event runtime", () => {
  it("initializes and sweeps before binding loopback listeners, then tunnels only the public port", async () => {
    const harness = createHarness();
    const runtime = createRuntime(harness.dependencies);

    await runtime.start();

    expect(harness.order).toEqual([
      "store:initialize",
      "store:sweep",
      "public:listen",
      "private:listen",
      "tunnel:start:http://127.0.0.1:4174",
    ]);
    expect(harness.listenCalls).toEqual([
      { host: "127.0.0.1", port: 4174, surface: "public" },
      { host: "127.0.0.1", port: 4173, surface: "private" },
    ]);
    expect((await runtime.getStatus()).acceptingCaptures).toBe(true);
    expect(harness.intervalMs()).toBe(30_000);
  });

  it("purges local test sessions before startup and never starts the supplied process tunnel", async () => {
    const start = vi.fn(async () => undefined);
    const harness = createHarness({
      config: config({ tunnelMode: "local", localPublicBaseUrl: "http://127.0.0.1:4174" }),
      tunnel: {
        start,
        stop: vi.fn(),
        status: () => ({ state: "down", publicUrl: null, latencyMs: null, error: null }),
      },
    });
    const runtime = createRuntime(harness.dependencies);

    await runtime.start();

    expect(harness.order.slice(0, 3)).toEqual(["store:initialize", "store:purge-all", "store:sweep"]);
    expect(start).not.toHaveBeenCalled();
    expect(await runtime.getStatus()).toMatchObject({
      tunnel: "healthy",
      publicUrl: "http://127.0.0.1:4174",
      acceptingCaptures: true,
    });
  });

  it("rejects local tunnel mode outside tests before touching storage", async () => {
    const harness = createHarness({
      config: config({ nodeEnv: "production", tunnelMode: "local", localPublicBaseUrl: "http://127.0.0.1:4174" }),
    });

    await expect(createRuntime(harness.dependencies).start()).rejects.toThrow("test-only");
    expect(harness.order).toEqual([]);
  });

  it("denies captures after a scheduled sweep fails and restores them after the next success", async () => {
    const harness = createHarness();
    const runtime = createRuntime(harness.dependencies);
    await runtime.start();

    harness.setSweepError(new Error("disk unavailable"));
    await harness.fireSweep();
    expect((await runtime.getStatus()).acceptingCaptures).toBe(false);

    harness.setSweepError(null);
    await harness.fireSweep();
    expect((await runtime.getStatus()).acceptingCaptures).toBe(true);
  });

  it("returns current tunnel state and URL so polling can reissue active QR codes", async () => {
    const harness = createHarness();
    const runtime = createRuntime(harness.dependencies);
    await runtime.start();

    harness.setTunnelStatus({
      state: "healthy",
      publicUrl: "https://replacement.trycloudflare.com",
      latencyMs: 21,
      error: null,
    });

    expect(await runtime.getStatus()).toMatchObject({
      tunnel: "healthy",
      publicUrl: "https://replacement.trycloudflare.com",
      publicLatencyMs: 21,
    });
  });

  it("blocks captures, purges, stops the tunnel, then closes private and public listeners", async () => {
    const harness = createHarness();
    const runtime = createRuntime(harness.dependencies);
    await runtime.start();
    harness.order.splice(0);

    await runtime.stop({ purge: true });

    expect(harness.acceptingAtPurge()).toBe(false);
    expect(harness.order).toEqual(["store:purge-all", "tunnel:stop", "private:close", "store:purge-all", "public:close"]);
  });

  it("purges again after the private listener drains an in-flight ciphertext write", async () => {
    const order: string[] = [];
    let ciphertextPresent = false;
    const dependencies: RuntimeDependencies = {
      config: config(),
      store: {
        initialize: async () => undefined,
        sweep: async () => ({ deletedPending: 0, deletedExpired: 0 }),
        purgeAll: async () => {
          order.push("purge");
          ciphertextPresent = false;
          return 0;
        },
        stats: async () => ({ pending: 0, active: 0, encryptedBytes: 0, lastSweepAt: 1_000 }),
      },
      createPublicServer: () => ({
        listen: async () => "http://127.0.0.1:4174",
        close: async () => { order.push("public:close"); },
      }),
      createPrivateServer: () => ({
        listen: async () => "http://127.0.0.1:4173",
        close: async () => {
          order.push("private:close");
          ciphertextPresent = true;
        },
      }),
      tunnel: {
        start: async () => undefined,
        stop: async () => { order.push("tunnel:stop"); },
        status: () => ({ state: "healthy", publicUrl: "https://booth.example", latencyMs: 1, error: null }),
      },
      timers: { setInterval: () => 1, clearInterval: () => undefined },
      signals: { once: () => undefined, off: () => undefined },
      exit: vi.fn(),
    };
    const runtime = createRuntime(dependencies);
    await runtime.start();

    await runtime.stop({ purge: true });

    expect(ciphertextPresent).toBe(false);
    expect(order).toEqual(["purge", "tunnel:stop", "private:close", "purge", "public:close"]);
  });

  it("continues cleanup after failures, exits nonzero when purge cannot be verified, and permits retry", async () => {
    const order: string[] = [];
    let purgeFails = true;
    const exit = vi.fn();
    const dependencies: RuntimeDependencies = {
      config: config(),
      store: {
        initialize: async () => undefined,
        sweep: async () => ({ deletedPending: 0, deletedExpired: 0 }),
        purgeAll: async () => {
          order.push("purge");
          if (purgeFails) throw new Error("purge failed");
          return 0;
        },
        stats: async () => ({ pending: 0, active: 0, encryptedBytes: 0, lastSweepAt: 1_000 }),
      },
      createPublicServer: () => ({
        listen: async () => "http://127.0.0.1:4174",
        close: async () => { order.push("public:close"); },
      }),
      createPrivateServer: () => ({
        listen: async () => "http://127.0.0.1:4173",
        close: async () => { order.push("private:close"); },
      }),
      tunnel: {
        start: async () => undefined,
        stop: async () => { order.push("tunnel:stop"); },
        status: () => ({ state: "healthy", publicUrl: "https://booth.example", latencyMs: 1, error: null }),
      },
      timers: { setInterval: () => 1, clearInterval: () => undefined },
      signals: { once: () => undefined, off: () => undefined },
      exit,
    };
    const runtime = createRuntime(dependencies);
    await runtime.start();

    await expect(runtime.requestShutdown()).resolves.toBeUndefined();
    expect(order).toEqual(["purge", "tunnel:stop", "private:close", "purge", "public:close"]);
    expect(exit).toHaveBeenLastCalledWith(1);

    purgeFails = false;
    order.splice(0);
    await expect(runtime.requestShutdown()).resolves.toBeUndefined();
    expect(order).toEqual(["purge", "tunnel:stop", "purge"]);
    expect(exit).toHaveBeenLastCalledWith(0);
  });

  it("retains a listener whose close fails so a later shutdown can retry it", async () => {
    let privateCloseFails = true;
    let privateCloseCalls = 0;
    const exit = vi.fn();
    const harness = createHarness({
      createPrivateServer: () => ({
        listen: async () => "http://127.0.0.1:4173",
        close: async () => {
          privateCloseCalls += 1;
          if (privateCloseFails) throw new Error("private close failed");
        },
      }),
      exit,
    });
    const runtime = createRuntime(harness.dependencies);
    await runtime.start();

    await runtime.requestShutdown();
    expect(privateCloseCalls).toBe(1);
    expect(exit).toHaveBeenLastCalledWith(1);

    privateCloseFails = false;
    await runtime.requestShutdown();
    expect(privateCloseCalls).toBe(2);
    expect(exit).toHaveBeenLastCalledWith(0);
  });

  it("waits for accepted aggregate counters before requestShutdown exits zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-runtime-metrics-drain-"));
    const path = join(root, "metrics.json");
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    const fileSystem: MetricsFileSystem = {
      mkdir,
      readFile,
      rename,
      rm,
      writeFile: (async (...args: Parameters<typeof writeFile>) => {
        writeStarted.resolve();
        await releaseWrite.promise;
        return writeFile(...args);
      }) as typeof writeFile,
    };
    const metrics = new AggregateMetrics({ persistencePath: path, fileSystem, drainTimeoutMs: 1_000 });
    await metrics.initialize();
    const exit = vi.fn();
    const harness = createHarness({ metrics, exit });
    const runtime = createRuntime(harness.dependencies);
    await runtime.start();
    metrics.recordPage();
    await writeStarted.promise;

    const shutdown = runtime.requestShutdown();
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    releaseWrite.resolve();
    await shutdown;

    expect(exit).toHaveBeenCalledWith(0);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pages: 1 });
  });

  it("exits nonzero when accepted aggregate counters cannot drain within the bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-runtime-metrics-timeout-"));
    const writeStarted = deferred<void>();
    const fileSystem: MetricsFileSystem = {
      mkdir,
      readFile,
      rename,
      rm,
      writeFile: (() => {
        writeStarted.resolve();
        return new Promise<void>(() => undefined);
      }) as typeof writeFile,
    };
    const metrics = new AggregateMetrics({
      persistencePath: join(root, "metrics.json"),
      fileSystem,
      drainTimeoutMs: 10,
    });
    await metrics.initialize();
    const exit = vi.fn();
    const harness = createHarness({ metrics, exit });
    const runtime = createRuntime(harness.dependencies);
    await runtime.start();
    metrics.recordDownload();
    await writeStarted.promise;

    await runtime.requestShutdown();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("serializes scheduled sweeps so an older failure cannot overwrite a newer success", async () => {
    const firstScheduledSweep = deferred<void>();
    let sweepCalls = 0;
    const scheduled: { tick: (() => void | Promise<void>) | null } = { tick: null };
    const harness = createHarness({
      store: {
        initialize: async () => undefined,
        sweep: async () => {
          sweepCalls += 1;
          if (sweepCalls === 2) await firstScheduledSweep.promise;
          return { deletedPending: 0, deletedExpired: 0 };
        },
        purgeAll: async () => 0,
        stats: async () => ({ pending: 0, active: 0, encryptedBytes: 0, lastSweepAt: 1_000 }),
      },
      timers: {
        setInterval(callback) {
          scheduled.tick = callback;
          return callback;
        },
        clearInterval() { scheduled.tick = null; },
      },
    });
    const runtime = createRuntime(harness.dependencies);
    await runtime.start();
    if (scheduled.tick === null) throw new Error("Sweep was not scheduled");

    const first = scheduled.tick();
    const second = scheduled.tick();
    await Promise.resolve();
    expect(sweepCalls).toBe(2);
    firstScheduledSweep.resolve();
    await Promise.all([first, second]);

    expect(sweepCalls).toBe(3);
    expect((await runtime.getStatus()).acceptingCaptures).toBe(true);
  });

  it("routes SIGINT and SIGTERM through the same purge path and exits zero", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const harness = createHarness();
      const runtime = createRuntime(harness.dependencies);
      await runtime.start();
      harness.order.splice(0);

      harness.signal(signal);
      await runtime.requestShutdown();

      expect(harness.order).toEqual(["store:purge-all", "tunnel:stop", "private:close", "store:purge-all", "public:close"]);
      expect(harness.dependencies.exit).toHaveBeenCalledOnce();
      expect(harness.dependencies.exit).toHaveBeenCalledWith(0);
    }
  });

  it("denies access exactly at expiry and deletes files by the next scheduled sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const root = await mkdtemp(join(tmpdir(), "umc-runtime-expiry-"));
    const store = new FileSessionStore({
      root,
      clock: { now: Date.now },
      activeTtlMs: 600_000,
      pendingTtlMs: 120_000,
    });
    const harness = createHarness({
      store,
      timers: undefined,
    });
    const runtime = createRuntime(harness.dependencies);
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(1);
      const active = await store.activate((await store.createPending(new Uint8Array([1, 2, 3]))).id);

      vi.setSystemTime(active.expiresAt - 1);
      expect(Date.now()).toBe(active.expiresAt - 1);
      expect((await store.readActive(active.publicToken)).kind).toBe("active");
      vi.setSystemTime(active.expiresAt);
      expect((await store.readActive(active.publicToken)).kind).toBe("gone");
      expect(await readdir(root)).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(29_999);
      await runtime.stop({ purge: false });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await runtime.stop({ purge: false });
      vi.useRealTimers();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

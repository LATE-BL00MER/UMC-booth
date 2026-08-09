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

const controlledPreflightSteps = ["initialize", "initial sweep", "public listen", "private listen"] as const;
type ControlledPreflightStep = typeof controlledPreflightSteps[number];

function createControlledPreflightHarness(blockedStep: ControlledPreflightStep) {
  const reached = deferred<void>();
  const release = deferred<void>();
  let shouldBlock = true;
  let publicCloseCalls = 0;
  let privateCloseCalls = 0;
  let publicFactoryCalls = 0;
  let privateFactoryCalls = 0;
  const exit = vi.fn();

  async function pass(step: ControlledPreflightStep): Promise<void> {
    if (shouldBlock && blockedStep === step) {
      reached.resolve();
      await release.promise;
    }
  }

  const harness = createHarness({
    store: {
      initialize: async () => pass("initialize"),
      sweep: async () => {
        await pass("initial sweep");
        return { deletedPending: 0, deletedExpired: 0 };
      },
      purgeAll: async () => 0,
      stats: async () => ({ pending: 0, active: 0, encryptedBytes: 0, lastSweepAt: 1_000 }),
    },
    createPublicServer: () => {
      publicFactoryCalls += 1;
      return {
        listen: async () => {
          await pass("public listen");
          return "http://127.0.0.1:4174";
        },
        close: async () => { publicCloseCalls += 1; },
      };
    },
    createPrivateServer: () => {
      privateFactoryCalls += 1;
      return {
        listen: async () => {
          await pass("private listen");
          return "http://127.0.0.1:4173";
        },
        close: async () => { privateCloseCalls += 1; },
      };
    },
    timers: undefined,
    safetyStepTimeoutMs: 10,
    startupStepTimeoutMs: 20,
    exit,
  });

  return {
    harness,
    reached: reached.promise,
    exit,
    unblock() {
      shouldBlock = false;
      release.resolve();
    },
    publicCloseCalls: () => publicCloseCalls,
    privateCloseCalls: () => privateCloseCalls,
    publicFactoryCalls: () => publicFactoryCalls,
    privateFactoryCalls: () => privateFactoryCalls,
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

  it("times out a never-healthy tunnel startup and rolls back listeners and storage", async () => {
    vi.useFakeTimers();
    const tunnelStartCalled = deferred<void>();
    const order: string[] = [];
    const harness = createHarness({
      store: {
        initialize: async () => { order.push("store:initialize"); },
        sweep: async () => { order.push("store:sweep"); return { deletedPending: 0, deletedExpired: 0 }; },
        purgeAll: async () => { order.push("store:purge-all"); return 0; },
        stats: async () => ({ pending: 0, active: 0, encryptedBytes: 0, lastSweepAt: 1_000 }),
      },
      createPublicServer: () => ({
        listen: async () => { order.push("public:listen"); return "http://127.0.0.1:4174"; },
        close: async () => { order.push("public:close"); },
      }),
      createPrivateServer: () => ({
        listen: async () => { order.push("private:listen"); return "http://127.0.0.1:4173"; },
        close: async () => { order.push("private:close"); },
      }),
      tunnel: {
        start: async () => { order.push("tunnel:start"); tunnelStartCalled.resolve(); await new Promise(() => undefined); },
        stop: async () => { order.push("tunnel:stop"); },
        status: () => ({ state: "starting", publicUrl: null, latencyMs: null, error: null }),
      },
      timers: undefined,
      safetyStepTimeoutMs: 10,
      tunnelStartupTimeoutMs: 25,
    });
    const runtime = createRuntime(harness.dependencies);

    try {
      const starting = runtime.start();
      const startupFailure = starting.catch((error: unknown) => error);
      await tunnelStartCalled.promise;
      await vi.advanceTimersByTimeAsync(25);

      expect(await startupFailure).toMatchObject({ message: "Runtime startup failed" });
      expect(order).toEqual([
        "store:initialize",
        "store:sweep",
        "public:listen",
        "private:listen",
        "tunnel:start",
        "store:purge-all",
        "tunnel:stop",
        "private:close",
        "store:purge-all",
        "public:close",
      ]);
      expect((await runtime.getStatus()).acceptingCaptures).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns a late tunnel start until a new final stop for that exact start settles", async () => {
    vi.useFakeTimers();
    const releaseLateStart = deferred<void>();
    const releaseFinalStop = deferred<void>();
    let tunnelStartCalls = 0;
    let tunnelStopCalls = 0;
    let tunnelStatus: TunnelStatus = { state: "down", publicUrl: null, latencyMs: null, error: null };
    const harness = createHarness({
      tunnel: {
        start: async () => {
          tunnelStartCalls += 1;
          tunnelStatus = { state: "starting", publicUrl: null, latencyMs: null, error: null };
          if (tunnelStartCalls === 1) await releaseLateStart.promise;
          tunnelStatus = { state: "healthy", publicUrl: "https://booth.example", latencyMs: 1, error: null };
        },
        stop: async () => {
          tunnelStopCalls += 1;
          if (tunnelStopCalls === 2) await releaseFinalStop.promise;
          tunnelStatus = { state: "down", publicUrl: null, latencyMs: null, error: null };
        },
        status: () => ({ ...tunnelStatus }),
      },
      timers: undefined,
      safetyStepTimeoutMs: 10,
      startupStepTimeoutMs: 20,
    });
    const runtime = createRuntime(harness.dependencies);

    try {
      const starting = runtime.start();
      const startupFailure = starting.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      expect(await startupFailure).toMatchObject({ message: "Runtime startup failed" });
      expect(tunnelStopCalls).toBe(1);

      releaseLateStart.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(tunnelStopCalls).toBe(2);
      await expect(runtime.start()).rejects.toThrow("lifecycle work is still pending");

      releaseFinalStop.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await runtime.start();
      expect(tunnelStartCalls).toBe(2);
      expect((await runtime.getStatus()).acceptingCaptures).toBe(true);
      await runtime.stop({ purge: false });
    } finally {
      releaseLateStart.resolve();
      releaseFinalStop.resolve();
      vi.useRealTimers();
    }
  });

  it("does not let an older in-flight stop clear ownership after the required late stop fails", async () => {
    vi.useFakeTimers();
    const releaseLateStart = deferred<void>();
    const releaseOlderStop = deferred<void>();
    let tunnelStartCalls = 0;
    let tunnelStopCalls = 0;
    let tunnelStatus: TunnelStatus = { state: "down", publicUrl: null, latencyMs: null, error: null };
    const harness = createHarness({
      tunnel: {
        start: async () => {
          tunnelStartCalls += 1;
          if (tunnelStartCalls === 1) await releaseLateStart.promise;
          tunnelStatus = { state: "healthy", publicUrl: "https://booth.example", latencyMs: 1, error: null };
        },
        stop: async () => {
          tunnelStopCalls += 1;
          const call = tunnelStopCalls;
          if (call === 1) await releaseOlderStop.promise;
          if (call === 2 || call === 3) throw new Error("stop failed");
          tunnelStatus = { state: "down", publicUrl: null, latencyMs: null, error: null };
        },
        status: () => ({ ...tunnelStatus }),
      },
      timers: undefined,
      safetyStepTimeoutMs: 10,
      startupStepTimeoutMs: 20,
    });
    const runtime = createRuntime(harness.dependencies);

    try {
      const starting = runtime.start();
      const startupFailure = starting.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      expect(tunnelStopCalls).toBe(1);

      releaseLateStart.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(tunnelStopCalls).toBe(2);
      releaseOlderStop.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(await startupFailure).toMatchObject({ message: "Runtime startup failed" });

      await expect(runtime.start()).rejects.toThrow("retained cleanup was incomplete");
      expect(tunnelStopCalls).toBe(3);
      expect(tunnelStartCalls).toBe(1);

      await runtime.start();
      expect(tunnelStopCalls).toBe(4);
      expect(tunnelStartCalls).toBe(2);
    } finally {
      releaseLateStart.resolve();
      releaseOlderStop.resolve();
      vi.useRealTimers();
    }
  });

  it("routes a signal received during pending tunnel startup through purge and settles start", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const tunnelStartCalled = deferred<void>();
      const releaseTunnelStart = deferred<void>();
      const exit = vi.fn();
      const harness = createHarness({
        tunnel: {
          start: async () => {
            tunnelStartCalled.resolve();
            await releaseTunnelStart.promise;
          },
          stop: async () => {
            harness.order.push("tunnel:stop");
            releaseTunnelStart.resolve();
          },
          status: () => ({ state: "down", publicUrl: null, latencyMs: null, error: null }),
        },
        exit,
      });
      const runtime = createRuntime(harness.dependencies);
      const starting = runtime.start();
      const startupFailure = starting.catch((error: unknown) => error);
      await tunnelStartCalled.promise;
      harness.order.splice(0);

      harness.signal(signal);
      expect(await startupFailure).toMatchObject({ message: "Runtime startup failed" });
      await runtime.requestShutdown();

      expect(harness.order).toEqual([
        "store:purge-all",
        "tunnel:stop",
        "tunnel:stop",
        "private:close",
        "store:purge-all",
        "public:close",
      ]);
      expect(exit).toHaveBeenCalledWith(0);
      expect((await runtime.getStatus()).acceptingCaptures).toBe(false);
    }
  });

  it("attempts every bounded startup rollback step when earlier cleanup fails", async () => {
    vi.useFakeTimers();
    const privateCloseStarted = deferred<void>();
    const releasePrivateClose = deferred<void>();
    const order: string[] = [];
    let privateCloseCalls = 0;
    let tunnelStopFails = true;
    const harness = createHarness({
      store: {
        initialize: async () => undefined,
        sweep: async () => ({ deletedPending: 0, deletedExpired: 0 }),
        purgeAll: async () => { order.push("purge"); return 0; },
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
          privateCloseCalls += 1;
          privateCloseStarted.resolve();
          await releasePrivateClose.promise;
        },
      }),
      tunnel: {
        start: async () => { throw new Error("sensitive tunnel detail"); },
        stop: async () => {
          order.push("tunnel:stop");
          if (tunnelStopFails) throw new Error("sensitive stop detail");
        },
        status: () => ({ state: "down", publicUrl: null, latencyMs: null, error: "process-exit" }),
      },
      timers: undefined,
      safetyStepTimeoutMs: 10,
    });
    const runtime = createRuntime(harness.dependencies);

    try {
      const starting = runtime.start();
      const startupFailure = starting.catch((error: unknown) => error);
      await privateCloseStarted.promise;
      await vi.advanceTimersByTimeAsync(10);
      const failure = await startupFailure;

      expect(failure).toBeInstanceOf(AggregateError);
      expect(String(failure)).toBe("AggregateError: Runtime startup failed");
      expect(String(failure)).not.toContain("sensitive");
      expect(order).toEqual(["purge", "tunnel:stop", "private:close", "purge", "public:close"]);

      order.splice(0);
      tunnelStopFails = false;
      releasePrivateClose.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await runtime.stop({ purge: true });
      expect(privateCloseCalls).toBe(1);
      expect(order).toEqual(["purge", "tunnel:stop", "purge"]);
    } finally {
      releasePrivateClose.resolve();
      vi.useRealTimers();
    }
  });

  it("does not overwrite a listener whose startup rollback close is still pending", async () => {
    vi.useFakeTimers();
    const oldPrivateCloseStarted = deferred<void>();
    const releaseOldPrivateClose = deferred<void>();
    let publicFactoryCalls = 0;
    let privateFactoryCalls = 0;
    let privateListenCalls = 0;
    let oldPrivateCloseCalls = 0;
    let tunnelStartCalls = 0;
    const harness = createHarness({
      createPublicServer: () => {
        publicFactoryCalls += 1;
        return {
          listen: async () => "http://127.0.0.1:4174",
          close: async () => undefined,
        };
      },
      createPrivateServer: () => {
        privateFactoryCalls += 1;
        const oldServer = privateFactoryCalls === 1;
        return {
          listen: async () => {
            privateListenCalls += 1;
            return "http://127.0.0.1:4173";
          },
          close: async () => {
            if (!oldServer) return;
            oldPrivateCloseCalls += 1;
            oldPrivateCloseStarted.resolve();
            await releaseOldPrivateClose.promise;
          },
        };
      },
      tunnel: {
        start: async () => {
          tunnelStartCalls += 1;
          if (tunnelStartCalls === 1) throw new Error("startup failed");
        },
        stop: async () => undefined,
        status: () => ({ state: "healthy", publicUrl: "https://booth.example", latencyMs: 1, error: null }),
      },
      timers: undefined,
      safetyStepTimeoutMs: 10,
    });
    const runtime = createRuntime(harness.dependencies);

    try {
      const firstStart = runtime.start();
      const firstFailure = firstStart.catch((error: unknown) => error);
      await oldPrivateCloseStarted.promise;
      await vi.advanceTimersByTimeAsync(10);
      expect(await firstFailure).toBeInstanceOf(AggregateError);

      await expect(runtime.start()).rejects.toThrow("lifecycle work is still pending");
      expect(publicFactoryCalls).toBe(1);
      expect(privateFactoryCalls).toBe(1);
      expect(privateListenCalls).toBe(1);
      expect(oldPrivateCloseCalls).toBe(1);

      releaseOldPrivateClose.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await runtime.start();

      expect(publicFactoryCalls).toBe(2);
      expect(privateFactoryCalls).toBe(2);
      expect(privateListenCalls).toBe(2);
      expect(oldPrivateCloseCalls).toBe(1);
      expect((await runtime.getStatus()).acceptingCaptures).toBe(true);
    } finally {
      releaseOldPrivateClose.resolve();
      vi.useRealTimers();
    }
  });

  it("retries a failed rollback close before creating or binding any replacement listener", async () => {
    let closeFails = true;
    let publicFactoryCalls = 0;
    let privateFactoryCalls = 0;
    let oldPrivateCloseCalls = 0;
    let tunnelStartCalls = 0;
    const harness = createHarness({
      createPublicServer: () => {
        publicFactoryCalls += 1;
        return {
          listen: async () => "http://127.0.0.1:4174",
          close: async () => undefined,
        };
      },
      createPrivateServer: () => {
        privateFactoryCalls += 1;
        const oldServer = privateFactoryCalls === 1;
        return {
          listen: async () => "http://127.0.0.1:4173",
          close: async () => {
            if (!oldServer) return;
            oldPrivateCloseCalls += 1;
            if (closeFails) throw new Error("close failed");
          },
        };
      },
      tunnel: {
        start: async () => {
          tunnelStartCalls += 1;
          if (tunnelStartCalls === 1) throw new Error("startup failed");
        },
        stop: async () => undefined,
        status: () => ({ state: "healthy", publicUrl: "https://booth.example", latencyMs: 1, error: null }),
      },
    });
    const runtime = createRuntime(harness.dependencies);

    await expect(runtime.start()).rejects.toThrow("Runtime startup failed");
    await expect(runtime.start()).rejects.toThrow("retained cleanup was incomplete");
    expect(publicFactoryCalls).toBe(1);
    expect(privateFactoryCalls).toBe(1);
    expect(oldPrivateCloseCalls).toBe(2);

    closeFails = false;
    await runtime.start();
    expect(oldPrivateCloseCalls).toBe(3);
    expect(publicFactoryCalls).toBe(2);
    expect(privateFactoryCalls).toBe(2);
    expect((await runtime.getStatus()).acceptingCaptures).toBe(true);
  });

  for (const step of controlledPreflightSteps) {
    it(`bounds ${step}, blocks restart until late work is owned, and safely restarts`, async () => {
      vi.useFakeTimers();
      const controlled = createControlledPreflightHarness(step);
      const runtime = createRuntime(controlled.harness.dependencies);
      let startSettled = false;
      const starting = runtime.start();
      const startupOutcome = starting.then(
        () => { startSettled = true; return null; },
        (error: unknown) => { startSettled = true; return error; },
      );

      try {
        await controlled.reached;
        await vi.advanceTimersByTimeAsync(20);

        expect(startSettled).toBe(true);
        expect(await startupOutcome).toMatchObject({ message: "Runtime startup failed" });
        expect((await runtime.getStatus()).acceptingCaptures).toBe(false);
        await expect(runtime.start()).rejects.toThrow("lifecycle work is still pending");

        const publicCloseCallsBeforeLateSettlement = controlled.publicCloseCalls();
        const privateCloseCallsBeforeLateSettlement = controlled.privateCloseCalls();
        controlled.unblock();
        await vi.advanceTimersByTimeAsync(0);

        if (step === "public listen") {
          expect(controlled.publicCloseCalls()).toBe(publicCloseCallsBeforeLateSettlement + 1);
        }
        if (step === "private listen") {
          expect(controlled.privateCloseCalls()).toBe(privateCloseCallsBeforeLateSettlement + 1);
        }

        await runtime.start();
        expect(controlled.publicFactoryCalls()).toBe(step === "initialize" || step === "initial sweep" ? 1 : 2);
        expect(controlled.privateFactoryCalls()).toBe(step === "private listen" ? 2 : 1);
        expect((await runtime.getStatus()).acceptingCaptures).toBe(true);
        await runtime.stop({ purge: false });
      } finally {
        controlled.unblock();
        await vi.advanceTimersByTimeAsync(20);
        vi.useRealTimers();
      }
    });
  }

  for (const step of controlledPreflightSteps) {
    it(`cancels ${step} promptly on a signal and completes the shared cleanup path`, async () => {
      vi.useFakeTimers();
      const controlled = createControlledPreflightHarness(step);
      const runtime = createRuntime(controlled.harness.dependencies);
      let startSettled = false;
      const starting = runtime.start();
      const startupOutcome = starting.then(
        () => { startSettled = true; return null; },
        (error: unknown) => { startSettled = true; return error; },
      );

      try {
        await controlled.reached;
        controlled.harness.signal("SIGINT");
        const shutdown = runtime.requestShutdown();
        await vi.advanceTimersByTimeAsync(0);

        expect(startSettled).toBe(true);
        expect(await startupOutcome).toMatchObject({ message: "Runtime startup failed" });
        expect((await runtime.getStatus()).acceptingCaptures).toBe(false);

        controlled.unblock();
        await vi.advanceTimersByTimeAsync(0);
        await shutdown;
        expect(controlled.exit).toHaveBeenCalledWith(0);
      } finally {
        controlled.unblock();
        await vi.advanceTimersByTimeAsync(20);
        await Promise.allSettled([starting, runtime.requestShutdown()]);
        vi.useRealTimers();
      }
    });
  }

  it("retains a late public listener when its close fails and cleans it before any replacement bind", async () => {
    vi.useFakeTimers();
    const listenReached = deferred<void>();
    const releaseListen = deferred<void>();
    let blockListen = true;
    let closeFails = true;
    let publicFactoryCalls = 0;
    let oldCloseCalls = 0;
    const harness = createHarness({
      createPublicServer: () => {
        publicFactoryCalls += 1;
        const oldServer = publicFactoryCalls === 1;
        return {
          listen: async () => {
            if (oldServer && blockListen) {
              listenReached.resolve();
              await releaseListen.promise;
            }
            return "http://127.0.0.1:4174";
          },
          close: async () => {
            if (!oldServer) return;
            oldCloseCalls += 1;
            if (closeFails) throw new Error("close failed");
          },
        };
      },
      timers: undefined,
      safetyStepTimeoutMs: 10,
      startupStepTimeoutMs: 20,
    });
    const runtime = createRuntime(harness.dependencies);

    try {
      const starting = runtime.start();
      const startupFailure = starting.catch((error: unknown) => error);
      await listenReached.promise;
      await vi.advanceTimersByTimeAsync(20);
      expect(await startupFailure).toMatchObject({ message: "Runtime startup failed" });

      blockListen = false;
      releaseListen.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(oldCloseCalls).toBe(1);

      await expect(runtime.start()).rejects.toThrow("retained cleanup was incomplete");
      expect(publicFactoryCalls).toBe(1);
      expect(oldCloseCalls).toBe(2);

      closeFails = false;
      await runtime.start();
      expect(oldCloseCalls).toBe(3);
      expect(publicFactoryCalls).toBe(2);
      expect((await runtime.getStatus()).acceptingCaptures).toBe(true);
    } finally {
      blockListen = false;
      closeFails = false;
      releaseListen.resolve();
      vi.useRealTimers();
    }
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

  it("rejects start during an ordinary slow stop and permits a new generation only afterward", async () => {
    const purgeStarted = deferred<void>();
    const releasePurge = deferred<void>();
    let purgeCalls = 0;
    let initializeCalls = 0;
    let publicListenCalls = 0;
    let tunnelStartCalls = 0;
    const harness = createHarness({
      store: {
        initialize: async () => { initializeCalls += 1; },
        sweep: async () => ({ deletedPending: 0, deletedExpired: 0 }),
        purgeAll: async () => {
          purgeCalls += 1;
          if (purgeCalls === 1) {
            purgeStarted.resolve();
            await releasePurge.promise;
          }
          return 0;
        },
        stats: async () => ({ pending: 0, active: 0, encryptedBytes: 0, lastSweepAt: 1_000 }),
      },
      createPublicServer: () => ({
        listen: async () => { publicListenCalls += 1; return "http://127.0.0.1:4174"; },
        close: async () => undefined,
      }),
      tunnel: {
        start: async () => { tunnelStartCalls += 1; },
        stop: async () => undefined,
        status: () => ({ state: "healthy", publicUrl: "https://booth.example", latencyMs: 1, error: null }),
      },
    });
    const runtime = createRuntime(harness.dependencies);

    try {
      await runtime.start();
      const stopping = runtime.stop({ purge: true });
      await purgeStarted.promise;

      await expect(runtime.start()).rejects.toThrow("stop is in progress");
      expect(initializeCalls).toBe(1);
      expect(publicListenCalls).toBe(1);
      expect(tunnelStartCalls).toBe(1);

      releasePurge.resolve();
      await stopping;
      await runtime.start();
      expect(initializeCalls).toBe(2);
      expect(publicListenCalls).toBe(2);
      expect(tunnelStartCalls).toBe(2);
    } finally {
      releasePurge.resolve();
    }
  });

  it("coalesces concurrent direct stops without duplicate purge or component cleanup", async () => {
    const purgeStarted = deferred<void>();
    const releasePurge = deferred<void>();
    let purgeCalls = 0;
    let tunnelStopCalls = 0;
    let privateCloseCalls = 0;
    let publicCloseCalls = 0;
    const harness = createHarness({
      store: {
        initialize: async () => undefined,
        sweep: async () => ({ deletedPending: 0, deletedExpired: 0 }),
        purgeAll: async () => {
          purgeCalls += 1;
          if (purgeCalls === 1) {
            purgeStarted.resolve();
            await releasePurge.promise;
          }
          return 0;
        },
        stats: async () => ({ pending: 0, active: 0, encryptedBytes: 0, lastSweepAt: 1_000 }),
      },
      createPublicServer: () => ({
        listen: async () => "http://127.0.0.1:4174",
        close: async () => { publicCloseCalls += 1; },
      }),
      createPrivateServer: () => ({
        listen: async () => "http://127.0.0.1:4173",
        close: async () => { privateCloseCalls += 1; },
      }),
      tunnel: {
        start: async () => undefined,
        stop: async () => { tunnelStopCalls += 1; },
        status: () => ({ state: "healthy", publicUrl: "https://booth.example", latencyMs: 1, error: null }),
      },
    });
    const runtime = createRuntime(harness.dependencies);

    try {
      await runtime.start();
      const firstStop = runtime.stop({ purge: true });
      await purgeStarted.promise;
      const secondStop = runtime.stop({ purge: true });
      releasePurge.resolve();
      await Promise.all([firstStop, secondStop]);

      expect(purgeCalls).toBe(2);
      expect(tunnelStopCalls).toBe(1);
      expect(privateCloseCalls).toBe(1);
      expect(publicCloseCalls).toBe(1);
    } finally {
      releasePurge.resolve();
    }
  });

  it("shares a single startup transition across concurrent start calls", async () => {
    const initializeStarted = deferred<void>();
    const releaseInitialize = deferred<void>();
    let initializeCalls = 0;
    let publicFactoryCalls = 0;
    const harness = createHarness({
      store: {
        initialize: async () => {
          initializeCalls += 1;
          initializeStarted.resolve();
          await releaseInitialize.promise;
        },
        sweep: async () => ({ deletedPending: 0, deletedExpired: 0 }),
        purgeAll: async () => 0,
        stats: async () => ({ pending: 0, active: 0, encryptedBytes: 0, lastSweepAt: 1_000 }),
      },
      createPublicServer: () => {
        publicFactoryCalls += 1;
        return {
          listen: async () => "http://127.0.0.1:4174",
          close: async () => undefined,
        };
      },
    });
    const runtime = createRuntime(harness.dependencies);

    try {
      const firstStart = runtime.start();
      await initializeStarted.promise;
      const secondStart = runtime.start();

      expect(secondStart).toBe(firstStart);
      releaseInitialize.resolve();
      await Promise.all([firstStart, secondStart]);
      expect(initializeCalls).toBe(1);
      expect(publicFactoryCalls).toBe(1);
    } finally {
      releaseInitialize.resolve();
      await runtime.stop({ purge: true }).catch(() => undefined);
    }
  });

  it("lets stop cancel an in-progress start and permits a safe later restart", async () => {
    const controlled = createControlledPreflightHarness("initialize");
    const runtime = createRuntime(controlled.harness.dependencies);

    const starting = runtime.start();
    await controlled.reached;
    const stopping = runtime.stop({ purge: true });

    await expect(starting).rejects.toThrow("Runtime startup failed");
    expect((await runtime.getStatus()).acceptingCaptures).toBe(false);
    controlled.unblock();
    await stopping;

    await runtime.start();
    expect(controlled.publicFactoryCalls()).toBe(1);
    expect((await runtime.getStatus()).acceptingCaptures).toBe(true);
  });

  it("makes requestShutdown join an in-progress stop without duplicating cleanup", async () => {
    const purgeStarted = deferred<void>();
    const releasePurge = deferred<void>();
    let purgeCalls = 0;
    let tunnelStopCalls = 0;
    let privateCloseCalls = 0;
    let publicCloseCalls = 0;
    const exit = vi.fn();
    const harness = createHarness({
      store: {
        initialize: async () => undefined,
        sweep: async () => ({ deletedPending: 0, deletedExpired: 0 }),
        purgeAll: async () => {
          purgeCalls += 1;
          if (purgeCalls === 1) {
            purgeStarted.resolve();
            await releasePurge.promise;
          }
          return 0;
        },
        stats: async () => ({ pending: 0, active: 0, encryptedBytes: 0, lastSweepAt: 1_000 }),
      },
      createPublicServer: () => ({
        listen: async () => "http://127.0.0.1:4174",
        close: async () => { publicCloseCalls += 1; },
      }),
      createPrivateServer: () => ({
        listen: async () => "http://127.0.0.1:4173",
        close: async () => { privateCloseCalls += 1; },
      }),
      tunnel: {
        start: async () => undefined,
        stop: async () => { tunnelStopCalls += 1; },
        status: () => ({ state: "healthy", publicUrl: "https://booth.example", latencyMs: 1, error: null }),
      },
      exit,
    });
    const runtime = createRuntime(harness.dependencies);

    try {
      await runtime.start();
      const stopping = runtime.stop({ purge: true });
      await purgeStarted.promise;
      const shutdown = runtime.requestShutdown();
      releasePurge.resolve();
      await Promise.all([stopping, shutdown]);

      expect(purgeCalls).toBe(2);
      expect(tunnelStopCalls).toBe(1);
      expect(privateCloseCalls).toBe(1);
      expect(publicCloseCalls).toBe(1);
      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      releasePurge.resolve();
    }
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

  it("blocks restart until a timed-out tunnel stop settles instead of starting overlapping cleanup", async () => {
    vi.useFakeTimers();
    const releaseTunnelStop = deferred<void>();
    let tunnelStartCalls = 0;
    let tunnelStopCalls = 0;
    const harness = createHarness({
      tunnel: {
        start: async () => { tunnelStartCalls += 1; },
        stop: async () => {
          tunnelStopCalls += 1;
          if (tunnelStopCalls === 1) await releaseTunnelStop.promise;
        },
        status: () => ({ state: "healthy", publicUrl: "https://booth.example", latencyMs: 1, error: null }),
      },
      timers: undefined,
      safetyStepTimeoutMs: 10,
    });
    const runtime = createRuntime(harness.dependencies);

    try {
      await runtime.start();
      const stopping = runtime.stop({ purge: true });
      const stopFailure = stopping.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(await stopFailure).toBeInstanceOf(AggregateError);

      await expect(runtime.start()).rejects.toThrow("lifecycle work is still pending");
      expect(tunnelStartCalls).toBe(1);
      expect(tunnelStopCalls).toBe(1);

      releaseTunnelStop.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await runtime.start();
      expect(tunnelStartCalls).toBe(2);
      expect(tunnelStopCalls).toBe(1);
    } finally {
      releaseTunnelStop.resolve();
      vi.useRealTimers();
    }
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

  it("bounds a hung queued sweep, completes every shutdown safety step, and exits nonzero", async () => {
    vi.useFakeTimers();
    const hungSweep = deferred<void>();
    const order: string[] = [];
    let sweepCalls = 0;
    const exit = vi.fn();
    const harness = createHarness({
      store: {
        initialize: async () => undefined,
        sweep: async () => {
          sweepCalls += 1;
          if (sweepCalls > 1) await hungSweep.promise;
          return { deletedPending: 0, deletedExpired: 0 };
        },
        purgeAll: async () => { order.push("purge"); return 0; },
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
      timers: undefined,
      safetyStepTimeoutMs: 10,
      exit,
    });
    const runtime = createRuntime(harness.dependencies);

    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sweepCalls).toBe(2);

      const shutdown = runtime.requestShutdown();
      await Promise.resolve();
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      await shutdown;

      expect(order).toEqual(["purge", "tunnel:stop", "private:close", "purge", "public:close"]);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      hungSweep.resolve();
      vi.useRealTimers();
    }
  });

  it("blocks restart until a timed-out scheduled sweep settles and never overlaps or applies stale health", async () => {
    vi.useFakeTimers();
    const releaseOldSweep = deferred<void>();
    let sweepCalls = 0;
    let concurrentSweeps = 0;
    let maximumConcurrentSweeps = 0;
    let initializeCalls = 0;
    let publicListenCalls = 0;
    const harness = createHarness({
      store: {
        initialize: async () => { initializeCalls += 1; },
        sweep: async () => {
          sweepCalls += 1;
          concurrentSweeps += 1;
          maximumConcurrentSweeps = Math.max(maximumConcurrentSweeps, concurrentSweeps);
          try {
            if (sweepCalls === 2) {
              await releaseOldSweep.promise;
              throw new Error("stale scheduled failure");
            }
            return { deletedPending: 0, deletedExpired: 0 };
          } finally {
            concurrentSweeps -= 1;
          }
        },
        purgeAll: async () => 0,
        stats: async () => ({ pending: 0, active: 0, encryptedBytes: 0, lastSweepAt: 1_000 }),
      },
      createPublicServer: () => ({
        listen: async () => { publicListenCalls += 1; return "http://127.0.0.1:4174"; },
        close: async () => undefined,
      }),
      timers: undefined,
      safetyStepTimeoutMs: 10,
    });
    const runtime = createRuntime(harness.dependencies);

    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sweepCalls).toBe(2);

      const stopping = runtime.stop({ purge: true });
      const stopFailure = stopping.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(await stopFailure).toBeInstanceOf(AggregateError);

      await expect(runtime.start()).rejects.toThrow("lifecycle work is still pending");
      expect(sweepCalls).toBe(2);
      expect(initializeCalls).toBe(1);
      expect(publicListenCalls).toBe(1);
      expect((await runtime.getStatus()).acceptingCaptures).toBe(false);

      releaseOldSweep.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect((await runtime.getStatus()).acceptingCaptures).toBe(false);

      await runtime.start();
      expect(sweepCalls).toBe(3);
      expect(maximumConcurrentSweeps).toBe(1);
      expect(initializeCalls).toBe(2);
      expect(publicListenCalls).toBe(2);
      expect((await runtime.getStatus()).acceptingCaptures).toBe(true);
    } finally {
      releaseOldSweep.resolve();
      vi.useRealTimers();
    }
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

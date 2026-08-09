import { describe, expect, it } from "vitest";

import {
  parseQuickTunnelUrl,
  TunnelSupervisor,
  type TimerAdapter,
  type TunnelChild,
} from "../../src/server/tunnel-supervisor.js";

class TestStream {
  private readonly listeners: Array<(chunk: Uint8Array | string) => void> = [];

  on(_event: "data", listener: (chunk: Uint8Array | string) => void): void {
    this.listeners.push(listener);
  }

  emit(text: string): void {
    for (const listener of this.listeners) listener(text);
  }
}

class TestChild implements TunnelChild {
  readonly stdout = new TestStream();
  readonly stderr = new TestStream();
  killed = 0;
  private readonly exits: Array<() => void> = [];
  private readonly errors: Array<(error: Error) => void> = [];

  on(event: "exit" | "error", listener: (() => void) | ((error: Error) => void)): void {
    if (event === "exit") this.exits.push(listener as () => void);
    else this.errors.push(listener as (error: Error) => void);
  }

  kill(): boolean {
    this.killed += 1;
    return true;
  }

  emitLine(line: string, stream: "stdout" | "stderr" = "stdout"): void {
    this[stream].emit(`${line}\n`);
  }

  exit(): void {
    for (const listener of this.exits) listener();
  }

  error(error: Error): void {
    for (const listener of this.errors) listener(error);
  }
}

class TestTimers implements TimerAdapter {
  nowValue = 1_000;
  readonly delays: number[] = [];
  private readonly timers = new Map<number, { callback: () => void; delay: number }>();
  private nextId = 1;

  now = (): number => this.nowValue;

  setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.delays.push(delayMs);
    this.timers.set(id, { callback, delay: delayMs });
    return id;
  };

  clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };

  runNext(delay: number): void {
    const entry = [...this.timers.entries()].find(([, timer]) => timer.delay === delay);
    if (!entry) throw new Error(`No timer scheduled for ${delay}`);
    this.timers.delete(entry[0]);
    entry[1].callback();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const children: TestChild[] = [];
  const timers = new TestTimers();
  const health = deferred<Response>();
  const spawnCalls: Array<[string, string[]]> = [];
  const healthCalls: Array<[string, RequestInit | undefined]> = [];
  const supervisor = new TunnelSupervisor({
    spawn(command, args) {
      spawnCalls.push([command, args]);
      const child = new TestChild();
      children.push(child);
      return child;
    },
    fetch(url, init) {
      healthCalls.push([url, init]);
      return health.promise;
    },
    timers,
  });
  return {
    supervisor,
    children,
    timers,
    health,
    spawnCalls,
    healthCalls,
  };
}

describe("parseQuickTunnelUrl", () => {
  it("extracts only an HTTPS trycloudflare URL", () => {
    expect(parseQuickTunnelUrl("Visit https://calm-river.trycloudflare.com now")).toBe(
      "https://calm-river.trycloudflare.com",
    );
    expect(parseQuickTunnelUrl("http://unsafe.example.test")).toBeNull();
    expect(parseQuickTunnelUrl("https://calm-river.trycloudflare.com.attacker.test")).toBeNull();
  });
});

describe("TunnelSupervisor", () => {
  it("spawns cloudflared with the public loopback port and publishes only after public health", async () => {
    const harness = createHarness();
    const reissueAll = (url: string) => reissued.push(url);
    const reissued: string[] = [];
    harness.supervisor.onUrlChange(reissueAll);

    const start = harness.supervisor.start("http://127.0.0.1:4174");
    expect(harness.spawnCalls).toEqual([
      ["cloudflared", ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4174"]],
    ]);
    harness.children[0]!.stderr.emit("notice\nhttps://calm-river.trycloudflare.com\n");
    expect(harness.supervisor.status()).toMatchObject({ state: "starting", publicUrl: null });
    expect(harness.healthCalls[0]![0]).toBe("https://calm-river.trycloudflare.com/health");

    harness.timers.nowValue = 1_042;
    harness.health.resolve(new Response("ok"));
    await start;

    expect(harness.supervisor.status()).toEqual({
      state: "healthy",
      publicUrl: "https://calm-river.trycloudflare.com",
      latencyMs: 42,
      error: null,
    });
    expect(reissued).toEqual(["https://calm-river.trycloudflare.com"]);
  });

  it("marks a failed health check down and restarts with capped backoff", async () => {
    const harness = createHarness();
    void harness.supervisor.start("http://127.0.0.1:4174");
    harness.children[0]!.emitLine("https://calm-river.trycloudflare.com");
    harness.health.resolve(new Response("not ready", { status: 503 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.supervisor.status()).toEqual({
      state: "down",
      publicUrl: null,
      latencyMs: null,
      error: "health-failed",
    });
    expect(harness.timers.delays).toContain(1_000);

    harness.timers.runNext(1_000);
    harness.children[1]!.exit();
    expect(harness.timers.delays).toContain(2_000);
    harness.timers.runNext(2_000);
    harness.children[2]!.exit();
    expect(harness.timers.delays).toContain(5_000);
  });

  it("does not busy-loop when cloudflared is missing", () => {
    const timers = new TestTimers();
    const missingBinary = Object.assign(new Error("missing"), { code: "ENOENT" });
    const supervisor = new TunnelSupervisor({
      spawn: () => {
        throw missingBinary;
      },
      fetch: async () => new Response("ok"),
      timers,
    });

    void supervisor.start("http://127.0.0.1:4174");

    expect(supervisor.status()).toEqual({
      state: "down",
      publicUrl: null,
      latencyMs: null,
      error: "missing-binary",
    });
    expect(timers.delays).toEqual([]);
  });

  it("stops idempotently and ignores stale child output", async () => {
    const harness = createHarness();
    void harness.supervisor.start("http://127.0.0.1:4174");
    const staleChild = harness.children[0]!;
    harness.supervisor.stop();
    harness.supervisor.stop();
    staleChild.emitLine("https://calm-river.trycloudflare.com");
    staleChild.exit();
    await Promise.resolve();

    expect(staleChild.killed).toBe(1);
    expect(harness.supervisor.status()).toEqual({
      state: "down",
      publicUrl: null,
      latencyMs: null,
      error: null,
    });
    expect(harness.timers.delays).toEqual([]);
  });
});

import { spawn as spawnProcess } from "node:child_process";

export interface TunnelStatus {
  state: "starting" | "healthy" | "down";
  publicUrl: string | null;
  latencyMs: number | null;
  error: "missing-binary" | "process-exit" | "health-failed" | null;
}

export interface TunnelStream {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): void;
}

export interface TunnelChild {
  stdout: TunnelStream;
  stderr: TunnelStream;
  on(event: "exit", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  kill(): boolean;
}

export interface TimerAdapter {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface TunnelSupervisorDependencies {
  spawn?(command: string, args: string[]): TunnelChild;
  fetch?(url: string, init?: RequestInit): Promise<Response>;
  timers?: TimerAdapter;
}

const HEALTH_TIMEOUT_MS = 5_000;
const RESTART_DELAYS_MS = [1_000, 2_000, 5_000] as const;

const defaultTimers: TimerAdapter = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class TunnelSupervisor {
  private readonly spawn: (command: string, args: string[]) => TunnelChild;
  private readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly timers: TimerAdapter;
  private readonly urlListeners = new Set<(url: string) => void>();
  private readonly startResolvers = new Map<number, () => void>();
  private activeRun = 0;
  private child: TunnelChild | null = null;
  private healthAbortController: AbortController | null = null;
  private restartTimer: unknown = null;
  private restartAttempt = 0;
  private stopped = true;
  private loopbackUrl: string | null = null;
  private statusValue: TunnelStatus = downStatus(null);

  constructor(dependencies: TunnelSupervisorDependencies = {}) {
    this.spawn = dependencies.spawn ?? ((command, args) => spawnProcess(command, args) as unknown as TunnelChild);
    this.fetch = dependencies.fetch ?? ((url, init) => fetch(url, init));
    this.timers = dependencies.timers ?? defaultTimers;
  }

  start(publicLoopbackUrl: string): Promise<void> {
    const loopbackUrl = normalizeLoopbackUrl(publicLoopbackUrl);
    this.stop();
    this.stopped = false;
    this.loopbackUrl = loopbackUrl;
    const run = ++this.activeRun;
    this.restartAttempt = 0;
    this.statusValue = startingStatus();

    const started = new Promise<void>((resolve) => this.startResolvers.set(run, resolve));
    this.launch(run);
    return started;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    ++this.activeRun;
    this.loopbackUrl = null;
    this.cancelRestart();
    this.healthAbortController?.abort();
    this.healthAbortController = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.statusValue = downStatus(null);
    for (const resolve of this.startResolvers.values()) resolve();
    this.startResolvers.clear();
  }

  status(): TunnelStatus {
    return { ...this.statusValue };
  }

  onUrlChange(listener: (url: string) => void): () => void {
    this.urlListeners.add(listener);
    return () => this.urlListeners.delete(listener);
  }

  private launch(run: number): void {
    if (!this.isCurrent(run) || !this.loopbackUrl) return;
    this.statusValue = startingStatus();

    let child: TunnelChild;
    try {
      child = this.spawn("cloudflared", [
        "tunnel",
        "--no-autoupdate",
        "--url",
        this.loopbackUrl,
      ]);
    } catch (error) {
      if (errorCode(error) === "ENOENT") this.markMissingBinary(run);
      else this.fail(run, "process-exit");
      return;
    }

    if (!this.isCurrent(run)) {
      child.kill();
      return;
    }

    this.child = child;
    const stdout = lineReader((line) => this.beginHealthCheck(run, child, line));
    const stderr = lineReader((line) => this.beginHealthCheck(run, child, line));
    child.stdout.on("data", stdout);
    child.stderr.on("data", stderr);
    child.on("exit", () => {
      if (this.isCurrentChild(run, child)) this.fail(run, "process-exit");
    });
    child.on("error", (error) => {
      if (!this.isCurrentChild(run, child)) return;
      if (errorCode(error) === "ENOENT") this.markMissingBinary(run);
      else this.fail(run, "process-exit");
    });
  }

  private beginHealthCheck(run: number, child: TunnelChild, line: string): void {
    if (!this.isCurrentChild(run, child) || this.healthAbortController) return;
    const publicUrl = parseQuickTunnelUrl(line);
    if (!publicUrl) return;
    void this.probeHealth(run, child, publicUrl);
  }

  private async probeHealth(run: number, child: TunnelChild, publicUrl: string): Promise<void> {
    const controller = new AbortController();
    this.healthAbortController = controller;
    const startedAt = this.timers.now();
    let timeout: unknown;
    const healthTimeout = new Promise<never>((_resolve, reject) => {
      timeout = this.timers.setTimeout(() => {
        controller.abort();
        reject(new Error("Tunnel health check timed out"));
      }, HEALTH_TIMEOUT_MS);
    });

    try {
      const response = await Promise.race([
        this.fetch(`${publicUrl}/health`, { signal: controller.signal }),
        healthTimeout,
      ]);
      if (!response.ok) throw new Error("Tunnel health check failed");
      if (!this.isCurrentChild(run, child) || this.healthAbortController !== controller) return;

      this.healthAbortController = null;
      this.restartAttempt = 0;
      this.statusValue = {
        state: "healthy",
        publicUrl,
        latencyMs: this.timers.now() - startedAt,
        error: null,
      };
      for (const listener of this.urlListeners) listener(publicUrl);
      const resolve = this.startResolvers.get(run);
      if (resolve) resolve();
      this.startResolvers.delete(run);
    } catch {
      if (this.isCurrentChild(run, child) && this.healthAbortController === controller) {
        this.healthAbortController = null;
        this.fail(run, "health-failed");
      }
    } finally {
      if (timeout !== undefined) this.timers.clearTimeout(timeout);
    }
  }

  private fail(run: number, error: "process-exit" | "health-failed"): void {
    if (!this.isCurrent(run)) return;
    this.healthAbortController?.abort();
    this.healthAbortController = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.statusValue = downStatus(error);
    this.scheduleRestart(run);
  }

  private markMissingBinary(run: number): void {
    if (!this.isCurrent(run)) return;
    this.healthAbortController?.abort();
    this.healthAbortController = null;
    this.child = null;
    this.statusValue = downStatus("missing-binary");
  }

  private scheduleRestart(run: number): void {
    this.cancelRestart();
    const delay = RESTART_DELAYS_MS[Math.min(this.restartAttempt, RESTART_DELAYS_MS.length - 1)] ?? 5_000;
    this.restartAttempt += 1;
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = null;
      this.launch(run);
    }, delay);
  }

  private cancelRestart(): void {
    if (this.restartTimer === null) return;
    this.timers.clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private isCurrent(run: number): boolean {
    return !this.stopped && this.activeRun === run;
  }

  private isCurrentChild(run: number, child: TunnelChild): boolean {
    return this.isCurrent(run) && this.child === child;
  }
}

export function parseQuickTunnelUrl(line: string): string | null {
  const match = /https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.trycloudflare\.com(?=$|[\s/,:;\])}>"'])/i.exec(line);
  return match ? `https://${match[1]?.toLowerCase()}.trycloudflare.com` : null;
}

function lineReader(onLine: (line: string) => void): (chunk: Uint8Array | string) => void {
  let remainder = "";
  return (chunk) => {
    remainder += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    const lines = remainder.split(/\r?\n/);
    remainder = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
}

function normalizeLoopbackUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("publicLoopbackUrl must be a 127.0.0.1 HTTP origin with an explicit port");
  }
  return `http://127.0.0.1:${url.port}`;
}

function startingStatus(): TunnelStatus {
  return { state: "starting", publicUrl: null, latencyMs: null, error: null };
}

function downStatus(error: TunnelStatus["error"]): TunnelStatus {
  return { state: "down", publicUrl: null, latencyMs: null, error };
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

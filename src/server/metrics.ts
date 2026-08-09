import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AggregateEvent = "decrypt_success" | "save_intent" | "join_click";

export interface AggregateMetricsSnapshot {
  teamStarts: number;
  completedQrIssuances: number;
  pages: number;
  downloads: number;
  decryptSuccess: number;
  saveIntent: number;
  joinClick: number;
}

export interface AggregateMetricsOptions {
  now?: () => number;
  persistencePath?: string;
  fileSystem?: MetricsFileSystem;
  drainTimeoutMs?: number;
  timers?: MetricsTimers;
}

export interface MetricsFileSystem {
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
}

export interface MetricsTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

const nodeFileSystem: MetricsFileSystem = { mkdir, readFile, rename, rm, writeFile };
const defaultTimers: MetricsTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

const emptySnapshot = (): AggregateMetricsSnapshot => ({
  teamStarts: 0,
  completedQrIssuances: 0,
  pages: 0,
  downloads: 0,
  decryptSuccess: 0,
  saveIntent: 0,
  joinClick: 0,
});

export class AggregateMetrics {
  private readonly now: () => number;
  private readonly persistencePath: string | null;
  private readonly fileSystem: MetricsFileSystem;
  private readonly drainTimeoutMs: number;
  private readonly timers: MetricsTimers;
  private readonly counters = emptySnapshot();
  private eventSecond: number | null = null;
  private acceptedEvents = 0;
  private loadPromise: Promise<void> | null = null;
  private initialized = false;
  private revision = 0;
  private persistedRevision = 0;
  private persistencePump: Promise<void> | null = null;
  private persistenceError: unknown = null;

  constructor(options: AggregateMetricsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.persistencePath = options.persistencePath ?? null;
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.timers = options.timers ?? defaultTimers;
    this.initialized = this.persistencePath === null;
  }

  initialize(): Promise<void> {
    this.loadPromise ??= this.loadPersisted().then(() => {
      this.initialized = true;
    });
    return this.loadPromise;
  }

  record(event: AggregateEvent): boolean {
    this.assertInitialized();
    const second = Math.floor(this.now() / 1_000);
    if (second !== this.eventSecond) {
      this.eventSecond = second;
      this.acceptedEvents = 0;
    }
    if (this.acceptedEvents >= 10) {
      return false;
    }
    this.acceptedEvents += 1;
    if (event === "decrypt_success") {
      this.counters.decryptSuccess += 1;
    } else if (event === "save_intent") {
      this.counters.saveIntent += 1;
    } else {
      this.counters.joinClick += 1;
    }
    this.markDirty();
    return true;
  }

  recordPage(): void {
    this.assertInitialized();
    this.counters.pages += 1;
    this.markDirty();
  }

  recordDownload(): void {
    this.assertInitialized();
    this.counters.downloads += 1;
    this.markDirty();
  }

  recordTeamStart(): void {
    this.assertInitialized();
    this.counters.teamStarts += 1;
    this.markDirty();
  }

  recordCompletedQr(): void {
    this.assertInitialized();
    this.counters.completedQrIssuances += 1;
    this.markDirty();
  }

  snapshot(): AggregateMetricsSnapshot {
    return { ...this.counters };
  }

  persistenceStatus(): { dirty: boolean; inFlight: boolean } {
    return {
      dirty: this.revision > this.persistedRevision,
      inFlight: this.persistencePump !== null,
    };
  }

  async drainPersistence(): Promise<void> {
    this.assertInitialized();
    if (this.persistencePath === null || this.revision === this.persistedRevision) return;
    await this.withDrainTimeout(this.drainUntilClean());
  }

  private markDirty(): void {
    this.revision += 1;
    if (this.persistencePath === null) {
      this.persistedRevision = this.revision;
      return;
    }
    this.ensurePump();
  }

  private ensurePump(): Promise<void> {
    if (this.persistencePump !== null) return this.persistencePump;
    this.persistenceError = null;
    const pump = this.runPersistencePump();
    this.persistencePump = pump;
    void pump.catch((error: unknown) => {
      this.persistenceError = error;
    }).finally(() => {
      if (this.persistencePump !== pump) return;
      this.persistencePump = null;
      if (this.persistenceError === null && this.revision > this.persistedRevision) {
        this.ensurePump();
      }
    });
    return pump;
  }

  private async runPersistencePump(): Promise<void> {
    while (this.persistedRevision < this.revision) {
      const targetRevision = this.revision;
      const snapshot = { ...this.counters, updatedAt: this.now() };
      await this.writeAtomically(JSON.stringify(snapshot));
      this.persistedRevision = targetRevision;
    }
  }

  private async drainUntilClean(): Promise<void> {
    while (this.persistedRevision < this.revision) {
      const pump = this.persistencePump ?? this.ensurePump();
      await pump;
    }
    if (this.persistenceError !== null) throw this.persistenceError;
  }

  private async withDrainTimeout(operation: Promise<void>): Promise<void> {
    let timer: unknown;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.timers.setTimeout(() => reject(new Error("Metrics persistence drain timed out")), this.drainTimeoutMs);
    });
    try {
      await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) this.timers.clearTimeout(timer);
    }
  }

  private async loadPersisted(): Promise<void> {
    if (this.persistencePath === null) return;
    let raw: string;
    try {
      raw = await this.fileSystem.readFile(this.persistencePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("Invalid aggregate metrics");
    }
    const snapshot = parsePersistedMetrics(value);
    Object.assign(this.counters, snapshot);
  }

  private async writeAtomically(contents: string): Promise<void> {
    const destination = this.persistencePath;
    if (destination === null) return;
    const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
    await this.fileSystem.mkdir(dirname(destination), { recursive: true });
    try {
      await this.fileSystem.writeFile(temporary, contents);
      await this.fileSystem.rename(temporary, destination);
    } catch (error) {
      await this.fileSystem.rm(temporary, { force: true });
      throw error;
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("Aggregate metrics are not initialized");
  }
}

const persistedKeys = ["completedQrIssuances", "decryptSuccess", "downloads", "joinClick", "pages", "saveIntent", "teamStarts", "updatedAt"] as const;
const legacyPersistedKeys = ["decryptSuccess", "downloads", "joinClick", "pages", "saveIntent", "updatedAt"] as const;

function parsePersistedMetrics(value: unknown): AggregateMetricsSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid aggregate metrics");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  const currentKeys = [...persistedKeys].sort().join(",");
  const legacyKeys = [...legacyPersistedKeys].sort().join(",");
  if (keys !== currentKeys && keys !== legacyKeys) {
    throw new Error("Invalid aggregate metrics");
  }
  for (const key of legacyPersistedKeys) {
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0) {
      throw new Error("Invalid aggregate metrics");
    }
  }
  return {
    teamStarts: (record.teamStarts as number | undefined) ?? 0,
    completedQrIssuances: (record.completedQrIssuances as number | undefined) ?? 0,
    pages: record.pages as number,
    downloads: record.downloads as number,
    decryptSuccess: record.decryptSuccess as number,
    saveIntent: record.saveIntent as number,
    joinClick: record.joinClick as number,
  };
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

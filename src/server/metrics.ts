import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AggregateEvent = "decrypt_success" | "save_intent" | "join_click";

export interface AggregateMetricsSnapshot {
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
}

export interface MetricsFileSystem {
  mkdir: typeof mkdir;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
}

const nodeFileSystem: MetricsFileSystem = { mkdir, rename, rm, writeFile };

const emptySnapshot = (): AggregateMetricsSnapshot => ({
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
  private readonly counters = emptySnapshot();
  private eventSecond: number | null = null;
  private acceptedEvents = 0;
  private pendingPersistence: Promise<void> = Promise.resolve();

  constructor(options: AggregateMetricsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.persistencePath = options.persistencePath ?? null;
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
  }

  async record(event: AggregateEvent): Promise<boolean> {
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
    await this.persist();
    return true;
  }

  async recordPage(): Promise<void> {
    this.counters.pages += 1;
    await this.persist();
  }

  async recordDownload(): Promise<void> {
    this.counters.downloads += 1;
    await this.persist();
  }

  snapshot(): AggregateMetricsSnapshot {
    return { ...this.counters };
  }

  private persist(): Promise<void> {
    if (this.persistencePath === null) return Promise.resolve();
    const snapshot = { ...this.counters, updatedAt: this.now() };
    const write = this.pendingPersistence
      .catch(() => undefined)
      .then(() => this.writeAtomically(JSON.stringify(snapshot)));
    this.pendingPersistence = write;
    return write;
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
}

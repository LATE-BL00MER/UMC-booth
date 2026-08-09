import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clock, SessionRecord, SessionStatus } from "../shared/contracts";
import { formatPublicToken, parsePublicToken } from "../shared/public-token";

export type SessionLookup =
  | { kind: "active"; record: SessionRecord; bytes: Uint8Array }
  | { kind: "gone" }
  | { kind: "not-found" };

export interface SessionStats {
  pending: number;
  active: number;
  encryptedBytes: number;
  lastSweepAt: number | null;
}

export interface FileSessionStoreOptions {
  root: string;
  clock: Clock;
  activeTtlMs: number;
  pendingTtlMs: number;
}

const sessionIdPattern = /^[A-Za-z0-9_-]{22}$/;

export class FileSessionStore {
  private readonly root: string;
  private readonly clock: Clock;
  private readonly activeTtlMs: number;
  private readonly pendingTtlMs: number;
  private readonly writesInProgress = new Set<string>();
  private lastSweepAt: number | null = null;

  constructor(options: FileSessionStoreOptions) {
    this.root = options.root;
    this.clock = options.clock;
    this.activeTtlMs = options.activeTtlMs;
    this.pendingTtlMs = options.pendingTtlMs;
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.cleanupInterruptedArtifacts();
  }

  async createPending(bytes: Uint8Array): Promise<{ id: string; createdAt: number }> {
    const id = randomBytes(16).toString("base64url");
    const createdAt = this.clock.now();
    const record: SessionRecord = {
      id,
      createdAt,
      expiresAt: null,
      status: "pending",
      encryptedFile: `${id}.bin`,
    };

    this.writesInProgress.add(id);
    try {
      await this.writeAtomically(`${id}.bin`, bytes);
      await this.writeAtomically(`${id}.json`, JSON.stringify(record));
    } finally {
      this.writesInProgress.delete(id);
    }
    return { id, createdAt };
  }

  async activate(id: string): Promise<{ id: string; publicToken: string; expiresAt: number }> {
    this.assertSessionId(id);
    const record = await this.requireRecord(id);
    if (record.status !== "pending") {
      throw new Error("Session is not pending");
    }

    const now = this.clock.now();
    if (record.createdAt + this.pendingTtlMs <= now) {
      await this.deleteSession(id);
      throw new Error("Session expired");
    }

    const expiresAt = now + this.activeTtlMs;
    const activeRecord: SessionRecord = {
      ...record,
      status: "active",
      expiresAt,
    };
    this.writesInProgress.add(id);
    try {
      await this.writeAtomically(`${id}.json`, JSON.stringify(activeRecord));
    } finally {
      this.writesInProgress.delete(id);
    }
    return { id, expiresAt, publicToken: formatPublicToken({ id, expiresAt }) };
  }

  async inspectById(id: string): Promise<SessionRecord> {
    this.assertSessionId(id);
    return this.requireRecord(id);
  }

  async readActive(publicToken: string): Promise<SessionLookup> {
    const parsed = parsePublicToken(publicToken);
    if (!parsed) {
      return { kind: "not-found" };
    }
    if (parsed.expiresAt <= this.clock.now()) {
      return { kind: "gone" };
    }

    const record = await this.readRecord(parsed.id);
    if (!record || record.expiresAt !== parsed.expiresAt || record.status !== "active") {
      return { kind: "not-found" };
    }

    try {
      const bytes = new Uint8Array(await readFile(this.binPath(parsed.id)));
      if (parsed.expiresAt <= this.clock.now()) {
        return { kind: "gone" };
      }
      return { kind: "active", record, bytes };
    } catch (error) {
      if (isNotFound(error)) {
        return { kind: "not-found" };
      }
      throw error;
    }
  }

  async deletePending(id: string): Promise<boolean> {
    if (!this.isSessionId(id)) {
      return false;
    }
    const record = await this.readRecord(id);
    if (!record || record.status !== "pending") {
      return false;
    }
    await this.deleteSession(id);
    return true;
  }

  async sweep(): Promise<{ deletedPending: number; deletedExpired: number }> {
    const now = this.clock.now();
    let deletedPending = 0;
    let deletedExpired = 0;

    await this.cleanupInterruptedArtifacts();
    for (const id of await this.sessionIds()) {
      const record = await this.readRecord(id);
      if (!record) {
        continue;
      }
      if (record.status === "pending" && record.createdAt + this.pendingTtlMs <= now) {
        await this.deleteSession(id);
        deletedPending += 1;
      } else if (record.status !== "pending" && record.expiresAt !== null && record.expiresAt <= now) {
        await this.deleteSession(id);
        deletedExpired += 1;
      }
    }

    this.lastSweepAt = now;
    return { deletedPending, deletedExpired };
  }

  async purgeAll(): Promise<number> {
    const entries = await readdir(this.root);
    const ids = entries.flatMap((entry) => {
      const match = /^([A-Za-z0-9_-]{22})\.json$/.exec(entry);
      return match ? [match[1]!] : [];
    });
    await Promise.all(
      entries
        .filter((entry) => /^[A-Za-z0-9_-]{22}\.(?:bin|json)(?:\.[0-9a-f]+\.tmp)?$/.test(entry))
        .map((entry) => rm(join(this.root, entry), { force: true })),
    );
    return ids.length;
  }

  async stats(): Promise<SessionStats> {
    let pending = 0;
    let active = 0;
    let encryptedBytes = 0;

    for (const id of await this.sessionIds()) {
      const record = await this.readRecord(id);
      if (!record) {
        continue;
      }
      if (record.status === "pending") {
        pending += 1;
      } else if (record.status === "active") {
        active += 1;
      } else {
        continue;
      }
      try {
        encryptedBytes += (await stat(this.binPath(id))).size;
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    }

    return { pending, active, encryptedBytes, lastSweepAt: this.lastSweepAt };
  }

  private async sessionIds(): Promise<string[]> {
    const entries = await readdir(this.root);
    return entries.flatMap((entry) => {
      const match = /^([A-Za-z0-9_-]{22})\.json$/.exec(entry);
      return match ? [match[1]!] : [];
    });
  }

  private async cleanupInterruptedArtifacts(): Promise<void> {
    const entries = await readdir(this.root);
    const completeIds = new Set(
      entries.flatMap((entry) => {
        const match = /^([A-Za-z0-9_-]{22})\.json$/.exec(entry);
        return match ? [match[1]!] : [];
      }),
    );
    await Promise.all(
      entries.flatMap((entry) => {
        const bin = /^([A-Za-z0-9_-]{22})\.bin$/.exec(entry);
        const temporary = /^([A-Za-z0-9_-]{22})\.(?:bin|json)\.[0-9a-f]+\.tmp$/.exec(entry);
        const id = bin?.[1] ?? temporary?.[1];
        if (!id || this.writesInProgress.has(id)) {
          return [];
        }
        if (temporary || !completeIds.has(id)) {
          return [rm(join(this.root, entry), { force: true })];
        }
        return [];
      }),
    );
  }

  private async requireRecord(id: string): Promise<SessionRecord> {
    const record = await this.readRecord(id);
    if (!record) {
      throw new Error("Session not found");
    }
    return record;
  }

  private async readRecord(id: string): Promise<SessionRecord | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.jsonPath(id), "utf8"));
      return this.parseRecord(value, id);
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  private parseRecord(value: unknown, id: string): SessionRecord {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid session metadata");
    }
    const record = value as Partial<SessionRecord>;
    const validStatus: SessionStatus[] = ["pending", "active", "expired"];
    if (
      record.id !== id
      || !Number.isSafeInteger(record.createdAt)
      || !validStatus.includes(record.status as SessionStatus)
      || (record.expiresAt !== null && !Number.isSafeInteger(record.expiresAt))
      || record.encryptedFile !== `${id}.bin`
    ) {
      throw new Error("Invalid session metadata");
    }
    return record as SessionRecord;
  }

  private async writeAtomically(filename: string, contents: Uint8Array | string): Promise<void> {
    const destination = join(this.root, filename);
    const temporary = join(this.root, `${filename}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, contents);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async deleteSession(id: string): Promise<void> {
    await Promise.all([
      rm(this.binPath(id), { force: true }),
      rm(this.jsonPath(id), { force: true }),
    ]);
  }

  private binPath(id: string): string {
    this.assertSessionId(id);
    return join(this.root, `${id}.bin`);
  }

  private jsonPath(id: string): string {
    this.assertSessionId(id);
    return join(this.root, `${id}.json`);
  }

  private isSessionId(id: string): boolean {
    return sessionIdPattern.test(id);
  }

  private assertSessionId(id: string): void {
    if (!this.isSessionId(id)) {
      throw new TypeError("Invalid session ID");
    }
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

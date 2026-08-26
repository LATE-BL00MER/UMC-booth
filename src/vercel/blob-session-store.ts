import { randomBytes } from "node:crypto";
import {
  BlobNotFoundError,
  copy,
  del,
  get,
  head,
  list,
  put,
} from "@vercel/blob";

import { formatPublicToken, parsePublicToken } from "../shared/public-token.js";

const rootPrefix = "umc-photo-booth/sessions";
const pendingPrefix = `${rootPrefix}/pending/`;
const activePrefix = `${rootPrefix}/active/`;
const ciphertextContentType = "application/octet-stream";

export interface BlobListEntry {
  pathname: string;
  size: number;
  uploadedAt: Date;
}

export interface BlobStorageAdapter {
  put(pathname: string, body: Uint8Array): Promise<void>;
  copy(fromPathname: string, toPathname: string): Promise<void>;
  delete(pathnames: string | string[]): Promise<void>;
  get(pathname: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | null>;
  exists(pathname: string): Promise<boolean>;
  list(prefix: string, cursor?: string): Promise<{
    blobs: BlobListEntry[];
    cursor?: string;
    hasMore: boolean;
  }>;
}

export interface BlobSessionStoreOptions {
  activeTtlMs: number;
  pendingTtlMs: number;
  clock?: { now(): number };
  storage?: BlobStorageAdapter;
}

export interface CloudSessionStats {
  pending: number;
  active: number;
  encryptedBytes: number;
  deletedPending: number;
  deletedExpired: number;
}

export type CloudSessionLookup =
  | { kind: "active"; stream: ReadableStream<Uint8Array>; size: number }
  | { kind: "gone" }
  | { kind: "not-found" };

interface ActiveEntry extends BlobListEntry {
  id: string;
  expiresAt: number;
}

export class BlobSessionStore {
  private readonly activeTtlMs: number;
  private readonly pendingTtlMs: number;
  private readonly clock: { now(): number };
  private readonly storage: BlobStorageAdapter;

  constructor(options: BlobSessionStoreOptions) {
    this.activeTtlMs = options.activeTtlMs;
    this.pendingTtlMs = options.pendingTtlMs;
    this.clock = options.clock ?? { now: Date.now };
    this.storage = options.storage ?? vercelBlobStorage;
  }

  async createPending(ciphertext: Uint8Array): Promise<{ id: string; createdAt: number }> {
    const id = randomBytes(16).toString("base64url");
    const createdAt = this.clock.now();
    await this.storage.put(pendingPath(id), ciphertext);
    return { id, createdAt };
  }

  async activate(id: string): Promise<{ id: string; publicToken: string; expiresAt: number }> {
    assertSessionId(id);
    const source = pendingPath(id);
    if (!await this.storage.exists(source)) {
      const existing = await this.findActive(id);
      if (existing) return issued(existing);
      throw new CloudSessionNotFoundError();
    }

    // Quantizing to one second gives concurrent retries the same destination while
    // preserving the user-visible TTL from the activation moment.
    const expiresAt = Math.ceil(this.clock.now() / 1_000) * 1_000 + this.activeTtlMs;
    const destination = activePath(id, expiresAt);
    try {
      await this.storage.copy(source, destination);
    } catch (error) {
      const activatedByAnotherRequest = await this.findActive(id);
      if (!activatedByAnotherRequest) throw error;
      await this.storage.delete(source);
      return issued(activatedByAnotherRequest);
    }
    await this.storage.delete(source);
    return issued({ id, expiresAt });
  }

  async resolveActivationOrDelete(id: string): Promise<
    | { status: "active"; publicToken: string; expiresAt: number }
    | { status: "deleted" }
  > {
    if (!isSessionId(id)) return { status: "deleted" };
    const active = await this.findActive(id);
    if (active && active.expiresAt > this.clock.now()) {
      return { status: "active", publicToken: formatPublicToken(active), expiresAt: active.expiresAt };
    }
    await this.storage.delete([
      pendingPath(id),
      ...(active ? [active.pathname] : []),
    ]);
    return { status: "deleted" };
  }

  async deletePending(id: string): Promise<void> {
    if (!isSessionId(id)) return;
    if (await this.findActive(id)) {
      throw new CloudSessionConflictError();
    }
    await this.storage.delete(pendingPath(id));
  }

  async inspectActive(publicToken: string): Promise<"active" | "gone" | "not-found"> {
    const parsed = parsePublicToken(publicToken);
    if (!parsed) return "not-found";
    const pathname = activePath(parsed.id, parsed.expiresAt);
    if (parsed.expiresAt <= this.clock.now()) {
      await this.storage.delete(pathname);
      return "gone";
    }
    return await this.storage.exists(pathname) ? "active" : "not-found";
  }

  async readActive(publicToken: string): Promise<CloudSessionLookup> {
    const parsed = parsePublicToken(publicToken);
    if (!parsed) return { kind: "not-found" };
    const pathname = activePath(parsed.id, parsed.expiresAt);
    if (parsed.expiresAt <= this.clock.now()) {
      await this.storage.delete(pathname);
      return { kind: "gone" };
    }
    const blob = await this.storage.get(pathname);
    return blob ? { kind: "active", ...blob } : { kind: "not-found" };
  }

  async sweep(): Promise<CloudSessionStats> {
    const now = this.clock.now();
    const blobs = await this.listAll(`${rootPrefix}/`);
    const pending = blobs.filter((blob) => blob.pathname.startsWith(pendingPrefix));
    const active = blobs.filter((blob) => blob.pathname.startsWith(activePrefix));
    const stalePending = pending.filter((blob) => blob.uploadedAt.getTime() + this.pendingTtlMs <= now);
    const parsedActive = active
      .map(parseActiveEntry)
      .filter((entry): entry is ActiveEntry => entry !== null);
    const expired = parsedActive.filter((entry) => entry.expiresAt <= now);
    const toDelete = [...stalePending, ...expired].map((blob) => blob.pathname);
    if (toDelete.length > 0) await this.storage.delete(toDelete);

    const retainedPending = pending.length - stalePending.length;
    const retainedActive = parsedActive.filter((entry) => entry.expiresAt > now);
    return {
      pending: retainedPending,
      active: retainedActive.length,
      encryptedBytes: pending
        .filter((blob) => !stalePending.includes(blob))
        .reduce((total, blob) => total + blob.size, 0)
        + retainedActive.reduce((total, blob) => total + blob.size, 0),
      deletedPending: stalePending.length,
      deletedExpired: expired.length,
    };
  }

  private async findActive(id: string): Promise<ActiveEntry | null> {
    const entries = (await this.listAll(`${activePrefix}${id}/`))
      .map(parseActiveEntry)
      .filter((entry): entry is ActiveEntry => entry !== null)
      .sort((left, right) => left.expiresAt - right.expiresAt);
    return entries[0] ?? null;
  }

  private async listAll(prefix: string): Promise<BlobListEntry[]> {
    const blobs: BlobListEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.storage.list(prefix, cursor);
      blobs.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
  }
}

export class CloudSessionNotFoundError extends Error {}
export class CloudSessionConflictError extends Error {}

const vercelBlobStorage: BlobStorageAdapter = {
  async put(pathname, body) {
    await put(pathname, Buffer.from(body), {
      access: "private",
      addRandomSuffix: false,
      cacheControlMaxAge: 60,
      contentType: ciphertextContentType,
    });
  },
  async copy(fromPathname, toPathname) {
    await copy(fromPathname, toPathname, {
      access: "private",
      addRandomSuffix: false,
      cacheControlMaxAge: 60,
      contentType: ciphertextContentType,
    });
  },
  async delete(pathnames) {
    await del(pathnames);
  },
  async get(pathname) {
    const result = await get(pathname, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return { stream: result.stream, size: result.blob.size };
  },
  async exists(pathname) {
    try {
      await head(pathname);
      return true;
    } catch (error) {
      if (error instanceof BlobNotFoundError) return false;
      throw error;
    }
  },
  async list(prefix, cursor) {
    const page = await list({ prefix, cursor, limit: 1_000 });
    return {
      blobs: page.blobs.map((blob) => ({
        pathname: blob.pathname,
        size: blob.size,
        uploadedAt: blob.uploadedAt,
      })),
      cursor: page.cursor,
      hasMore: page.hasMore,
    };
  },
};

function pendingPath(id: string): string {
  assertSessionId(id);
  return `${pendingPrefix}${id}.bin`;
}

function activePath(id: string, expiresAt: number): string {
  assertSessionId(id);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) throw new TypeError("Invalid expiry");
  return `${activePrefix}${id}/${expiresAt.toString(36)}.bin`;
}

function parseActiveEntry(blob: BlobListEntry): ActiveEntry | null {
  const match = new RegExp(`^${escapeRegExp(activePrefix)}([A-Za-z0-9_-]{22})/([0-9a-z]+)\\.bin$`).exec(blob.pathname);
  if (!match || !isSessionId(match[1]!)) return null;
  const expiresAt = Number.parseInt(match[2]!, 36);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0 || expiresAt.toString(36) !== match[2]) return null;
  return { ...blob, id: match[1]!, expiresAt };
}

function issued(entry: Pick<ActiveEntry, "id" | "expiresAt">) {
  return {
    id: entry.id,
    expiresAt: entry.expiresAt,
    publicToken: formatPublicToken(entry),
  };
}

function isSessionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(value);
}

function assertSessionId(value: string): void {
  if (!isSessionId(value)) throw new TypeError("Invalid session ID");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

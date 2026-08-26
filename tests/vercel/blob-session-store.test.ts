import { describe, expect, it } from "vitest";

import {
  BlobSessionStore,
  type BlobStorageAdapter,
} from "../../src/vercel/blob-session-store";

class MemoryBlobStorage implements BlobStorageAdapter {
  readonly objects = new Map<string, { bytes: Uint8Array; uploadedAt: Date }>();
  readonly listCalls: string[] = [];

  constructor(private readonly now: () => number) {}

  async put(pathname: string, body: Uint8Array): Promise<void> {
    if (this.objects.has(pathname)) throw new Error("already exists");
    this.objects.set(pathname, { bytes: Uint8Array.from(body), uploadedAt: new Date(this.now()) });
  }

  async copy(fromPathname: string, toPathname: string): Promise<void> {
    const source = this.objects.get(fromPathname);
    if (!source) throw new Error("not found");
    if (this.objects.has(toPathname)) throw new Error("already exists");
    this.objects.set(toPathname, { bytes: Uint8Array.from(source.bytes), uploadedAt: new Date(this.now()) });
  }

  async delete(pathnames: string | string[]): Promise<void> {
    for (const pathname of Array.isArray(pathnames) ? pathnames : [pathnames]) {
      this.objects.delete(pathname);
    }
  }

  async get(pathname: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | null> {
    const object = this.objects.get(pathname);
    if (!object) return null;
    const bytes = Uint8Array.from(object.bytes);
    return {
      size: bytes.byteLength,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  }

  async exists(pathname: string): Promise<boolean> {
    return this.objects.has(pathname);
  }

  async list(prefix: string): Promise<{ blobs: Array<{ pathname: string; size: number; uploadedAt: Date }>; hasMore: boolean }> {
    this.listCalls.push(prefix);
    return {
      blobs: [...this.objects.entries()]
        .filter(([pathname]) => pathname.startsWith(prefix))
        .map(([pathname, object]) => ({
          pathname,
          size: object.bytes.byteLength,
          uploadedAt: object.uploadedAt,
        })),
      hasMore: false,
    };
  }
}

function harness() {
  const time = { value: 1_000 };
  const storage = new MemoryBlobStorage(() => time.value);
  const store = new BlobSessionStore({
    activeTtlMs: 300_000,
    pendingTtlMs: 120_000,
    clock: { now: () => time.value },
    storage,
  });
  return { store, storage, time };
}

describe("BlobSessionStore", () => {
  it("moves ciphertext from pending to active and blocks it immediately at expiry", async () => {
    const { store, storage, time } = harness();
    const pending = await store.createPending(new Uint8Array([9, 8, 7]));

    const activated = await store.activate(pending.id);
    const lookup = await store.readActive(activated.publicToken);

    expect(lookup.kind).toBe("active");
    if (lookup.kind !== "active") throw new Error("expected active lookup");
    expect(new Uint8Array(await new Response(lookup.stream).arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    expect([...storage.objects.keys()]).toEqual([
      `umc-photo-booth/sessions/active/${pending.id}/${activated.expiresAt.toString(36)}.bin`,
    ]);
    expect(storage.listCalls).toEqual([]);

    time.value = activated.expiresAt;
    expect(await store.readActive(activated.publicToken)).toEqual({ kind: "gone" });
    expect(storage.objects.size).toBe(0);
  });

  it("resolves an activation retry only after the pending object is gone", async () => {
    const { store, storage } = harness();
    const pending = await store.createPending(new Uint8Array([6]));
    const activated = await store.activate(pending.id);

    await expect(store.activate(pending.id)).resolves.toEqual(activated);
    expect(storage.listCalls).toEqual([
      `umc-photo-booth/sessions/active/${pending.id}/`,
    ]);
  });

  it("rejects a forged token whose expiry does not match the stored pathname", async () => {
    const { store } = harness();
    const pending = await store.createPending(new Uint8Array([1]));
    const activated = await store.activate(pending.id);
    const forged = `${(activated.expiresAt + 60_000).toString(36)}.${pending.id}`;

    expect(await store.inspectActive(forged)).toBe("not-found");
    expect(await store.inspectActive(activated.publicToken)).toBe("active");
  });

  it("resolves an ambiguous activation without creating a replacement", async () => {
    const { store } = harness();
    const pending = await store.createPending(new Uint8Array([2]));
    const activated = await store.activate(pending.id);

    expect(await store.resolveActivationOrDelete(pending.id)).toEqual({
      status: "active",
      publicToken: activated.publicToken,
      expiresAt: activated.expiresAt,
    });
  });

  it("sweeps abandoned pending ciphertext and expired active ciphertext", async () => {
    const { store, storage, time } = harness();
    const abandoned = await store.createPending(new Uint8Array([3]));
    const activePending = await store.createPending(new Uint8Array([4, 5]));
    const active = await store.activate(activePending.id);

    time.value = active.expiresAt + 1;
    const stats = await store.sweep();

    expect(stats).toMatchObject({ pending: 0, active: 0, deletedPending: 1, deletedExpired: 1 });
    expect(storage.objects.size).toBe(0);
    expect(abandoned.id).not.toBe(activePending.id);
    expect(storage.listCalls.at(-1)).toBe("umc-photo-booth/sessions/");
  });
});

import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatPublicToken } from "../../src/shared/public-token";
import { FileSessionStore, type SessionStoreFileSystem } from "../../src/server/session-store";

async function createStore(now = 1_000) {
  const root = await mkdtemp(join(tmpdir(), "umc-store-"));
  const time = { value: now };
  const store = new FileSessionStore({
    root,
    clock: { now: () => time.value },
    activeTtlMs: 600_000,
    pendingTtlMs: 120_000,
  });
  await store.initialize();
  return { root, store, time };
}

describe("FileSessionStore", () => {
  it("keeps pending sessions private, activates for ten minutes, then returns gone", async () => {
    const { root, store, time } = await createStore();
    const ciphertext = new Uint8Array([1, 2, 3]);

    const pending = await store.createPending(ciphertext);
    expect((await store.inspectById(pending.id)).status).toBe("pending");
    const storedFiles = await readdir(root);
    expect(storedFiles).toEqual([`${pending.id}.bin`, `${pending.id}.json`]);
    for (const file of storedFiles.filter((entry) => entry.endsWith(".bin"))) {
      await expect(readFile(join(root, file))).resolves.toEqual(Buffer.from(ciphertext));
    }

    const active = await store.activate(pending.id);
    expect(active.expiresAt).toBe(601_000);
    await expect(store.readActive(active.publicToken)).resolves.toMatchObject({
      kind: "active",
      bytes: ciphertext,
    });

    time.value = 601_000;
    expect((await store.readActive(active.publicToken)).kind).toBe("gone");
    await expect(store.sweep()).resolves.toEqual({ deletedPending: 0, deletedExpired: 1 });
    expect(await readdir(root)).toEqual([]);
  });

  it("removes unactivated sessions after two minutes", async () => {
    const { root, store, time } = await createStore(10);
    await store.createPending(new Uint8Array([4]));

    time.value = 120_010;
    await expect(store.sweep()).resolves.toEqual({ deletedPending: 1, deletedExpired: 0 });
    expect(await readdir(root)).toEqual([]);
  });

  it("does not activate a pending session after its two-minute lifetime", async () => {
    const { root, store, time } = await createStore(10);
    const pending = await store.createPending(new Uint8Array([4]));

    time.value = 120_010;
    await expect(store.activate(pending.id)).rejects.toThrow("Session expired");
    expect(await readdir(root)).toEqual([]);
  });

  it("removes interrupted-write artifacts at startup and during sweeps without removing an active pair", async () => {
    const { root, store } = await createStore();
    const active = await store.activate((await store.createPending(new Uint8Array([1]))).id);
    const startupOrphan = "AAAAAAAAAAAAAAAAAAAAAA";
    await writeFile(join(root, `${startupOrphan}.bin`), new Uint8Array([2]));
    await writeFile(join(root, `${startupOrphan}.bin.deadbeef.tmp`), new Uint8Array([3]));
    await writeFile(join(root, `${startupOrphan}.json.deadbeef.tmp`), "partial metadata");

    const restarted = new FileSessionStore({
      root,
      clock: { now: () => 1_000 },
      activeTtlMs: 600_000,
      pendingTtlMs: 120_000,
    });
    await restarted.initialize();
    expect(await readdir(root)).toEqual([`${active.id}.bin`, `${active.id}.json`]);
    expect((await restarted.readActive(active.publicToken)).kind).toBe("active");

    const sweepOrphan = "_____________________w";
    await writeFile(join(root, `${sweepOrphan}.bin`), new Uint8Array([4]));
    await writeFile(join(root, `${sweepOrphan}.json.deadbeef.tmp`), "partial metadata");
    await restarted.sweep();
    expect(await readdir(root)).toEqual([`${active.id}.bin`, `${active.id}.json`]);
  });

  it("does not expose pending, mismatched, or malformed public tokens", async () => {
    const { store } = await createStore();
    const pending = await store.createPending(new Uint8Array([4]));

    expect((await store.readActive("bad-token")).kind).toBe("not-found");
    expect((await store.readActive(formatPublicToken({ id: pending.id, expiresAt: 601_000 }))).kind).toBe("not-found");

    const active = await store.activate(pending.id);
    const mismatched = formatPublicToken({ id: active.id, expiresAt: active.expiresAt + 1 });
    expect((await store.readActive(mismatched)).kind).toBe("not-found");
  });

  it("returns gone when the clock advances while the ciphertext read is pending", async () => {
    const { store, time } = await createStore();
    const active = await store.activate((await store.createPending(new Uint8Array([4]))).id);

    const lookup = store.readActive(active.publicToken);
    time.value = active.expiresAt;
    expect((await lookup).kind).toBe("gone");
  });

  it("deletes only pending sessions and reports current aggregate storage", async () => {
    const { root, store } = await createStore();
    const pending = await store.createPending(new Uint8Array([8, 9]));
    const activePending = await store.createPending(new Uint8Array([10, 11, 12]));
    await store.activate(activePending.id);

    expect(await store.deletePending(pending.id)).toBe(true);
    expect(await store.deletePending(pending.id)).toBe(false);
    expect(await store.deletePending(activePending.id)).toBe(false);
    expect(await store.stats()).toEqual({
      pending: 0,
      active: 1,
      encryptedBytes: 3,
      lastSweepAt: null,
    });
    expect(await store.purgeAll()).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });

  it("atomically resolves an activation already in flight without deleting its ciphertext", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-store-resolve-race-"));
    const activationWriteStarted = deferred<void>();
    const allowActivationWrite = deferred<void>();
    let activeMetadataWrite = false;
    let pendingId = "";
    const fileSystem: SessionStoreFileSystem = {
      mkdir,
      readdir,
      rename,
      rm,
      stat,
      readFile,
      writeFile: ((...args: Parameters<typeof writeFile>) => {
        if (activeMetadataWrite && String(args[0]).startsWith(join(root, `${pendingId}.json.`))) {
          activationWriteStarted.resolve();
          return allowActivationWrite.promise.then(() => writeFile(...args));
        }
        return writeFile(...args);
      }) as typeof writeFile,
    };
    const store = new FileSessionStore({
      root,
      clock: { now: () => 1_000 },
      activeTtlMs: 600_000,
      pendingTtlMs: 120_000,
      fileSystem,
    });
    await store.initialize();
    const pending = await store.createPending(new Uint8Array([7, 8, 9]));
    pendingId = pending.id;
    activeMetadataWrite = true;

    try {
      const activating = store.activate(pending.id);
      await activationWriteStarted.promise;
      const resolving = store.resolveActivationOrDelete(pending.id);
      await expect(settlesWithin(resolving, 20)).rejects.toThrow("Timed out waiting for sweep read");
      allowActivationWrite.resolve();

      const [activated, resolved] = await Promise.all([activating, resolving]);
      expect(resolved).toEqual({ status: "active", publicToken: activated.publicToken, expiresAt: 601_000 });
      await expect(store.readActive(activated.publicToken)).resolves.toMatchObject({ kind: "active", bytes: new Uint8Array([7, 8, 9]) });
    } finally {
      allowActivationWrite.resolve();
    }
  });

  it("deletes a still-pending session when atomic resolution finds no activation", async () => {
    const { root, store } = await createStore();
    const pending = await store.createPending(new Uint8Array([7, 8, 9]));

    await expect(store.resolveActivationOrDelete(pending.id)).resolves.toEqual({ status: "deleted" });
    expect(await readdir(root)).toEqual([]);
  });

  it("treats corrupt activation metadata as unreadable and removes every session artifact", async () => {
    const { root, store } = await createStore();
    const pending = await store.createPending(new Uint8Array([7, 8, 9]));
    await writeFile(join(root, `${pending.id}.json`), "{private parse detail");
    await writeFile(join(root, `${pending.id}.json.deadbeef.tmp`), "partial metadata");
    await writeFile(join(root, `${pending.id}.bin.deadbeef.tmp`), new Uint8Array([1]));

    await expect(store.resolveActivationOrDelete(pending.id)).resolves.toEqual({ status: "deleted" });
    expect(await readdir(root)).toEqual([]);
  });

  it("removes orphan ciphertext and temporary artifacts when activation metadata is missing", async () => {
    const { root, store } = await createStore();
    const pending = await store.createPending(new Uint8Array([7, 8, 9]));
    await rm(join(root, `${pending.id}.json`));
    await writeFile(join(root, `${pending.id}.json.deadbeef.tmp`), "partial metadata");
    await writeFile(join(root, `${pending.id}.bin.deadbeef.tmp`), new Uint8Array([1]));

    await expect(store.resolveActivationOrDelete(pending.id)).resolves.toEqual({ status: "deleted" });
    expect(await readdir(root)).toEqual([]);
  });

  it("does not recover an active session when its ciphertext is missing", async () => {
    const { root, store } = await createStore();
    const pending = await store.createPending(new Uint8Array([7, 8, 9]));
    await store.activate(pending.id);
    await rm(join(root, `${pending.id}.bin`));

    await expect(store.getActivated(pending.id)).resolves.toBeNull();
  });

  it("does not leave active metadata without ciphertext when sweep interleaves activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-store-sweep-race-"));
    const time = { value: 1_000 };
    const stalePendingRead = deferred<void>();
    const continueSweep = deferred<void>();
    let metadataPath = "";
    let interceptPendingMetadataRead = true;
    const fileSystem: SessionStoreFileSystem = {
      mkdir,
      readdir,
      rename,
      rm,
      stat,
      writeFile,
      readFile: ((...args: Parameters<typeof readFile>) => readFile(...args).then(async (value) => {
        if (interceptPendingMetadataRead && String(args[0]) === metadataPath) {
          interceptPendingMetadataRead = false;
          stalePendingRead.resolve();
          await continueSweep.promise;
        }
        return value;
      })) as typeof readFile,
    };
    const store = new FileSessionStore({
      root,
      clock: { now: () => time.value },
      activeTtlMs: 600_000,
      pendingTtlMs: 120_000,
      fileSystem,
    });
    await store.initialize();
    const pending = await store.createPending(new Uint8Array([4, 5, 6]));
    time.value = 121_000;
    metadataPath = join(root, `${pending.id}.json`);

    try {
      const sweeping = store.sweep();
      await expect(settlesWithin(stalePendingRead.promise, 50)).resolves.toBeUndefined();
      time.value = 120_999;
      const activating = store.activate(pending.id);
      continueSweep.resolve();

      await expect(sweeping).resolves.toEqual({ deletedPending: 1, deletedExpired: 0 });
      await expect(activating).rejects.toThrow("Session not found");
      expect(await readdir(root)).toEqual([]);
    } finally {
      continueSweep.resolve();
    }
  });

  it("purges orphaned session artifacts left by interrupted atomic writes", async () => {
    const { root, store } = await createStore();
    const id = "AAAAAAAAAAAAAAAAAAAAAA";
    await writeFile(join(root, `${id}.bin`), new Uint8Array([1]));
    await writeFile(join(root, `${id}.json.deadbeef.tmp`), "partial metadata");

    expect(await store.purgeAll()).toBe(0);
    expect(await readdir(root)).toEqual([]);
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

function settlesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for sweep read")), milliseconds);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

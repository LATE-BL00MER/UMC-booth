import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatPublicToken } from "../../src/shared/public-token";
import { FileSessionStore } from "../../src/server/session-store";

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

  it("linearizes reset deletion behind a committed activation without losing ciphertext", async () => {
    const { store } = await createStore();
    const pending = await store.createPending(new Uint8Array([7, 8, 9]));

    const [activated, deleted] = await Promise.all([
      store.activate(pending.id),
      store.deletePending(pending.id),
    ]);

    expect(deleted).toBe(false);
    expect((await store.readActive(activated.publicToken)).kind).toBe("active");
    await expect(store.getActivated(pending.id)).resolves.toEqual(activated);
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

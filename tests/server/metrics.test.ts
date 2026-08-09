import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AggregateMetrics, type MetricsFileSystem } from "../../src/server/metrics";

describe("aggregate metrics persistence", () => {
  it("persists aggregate team starts and completed QR issuances without session identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-metrics-operator-"));
    const path = join(root, "metrics.json");
    const metrics = new AggregateMetrics({ now: () => 7, persistencePath: path });
    await metrics.initialize();

    metrics.recordTeamStart();
    metrics.recordCompletedQr();
    await metrics.drainPersistence();

    expect(metrics.snapshot()).toMatchObject({ teamStarts: 1, completedQrIssuances: 1 });
    expect(await readFile(path, "utf8")).not.toMatch(/session|token|key|id/i);
    const restarted = new AggregateMetrics({ persistencePath: path });
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject({ teamStarts: 1, completedQrIssuances: 1 });
  });
  it("atomically persists only aggregate counters and updatedAt after every accepted metric", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-metrics-"));
    const path = join(root, "runtime-data", "metrics.json");
    const time = { value: 1_234 };
    const metrics = new AggregateMetrics({ now: () => time.value, persistencePath: path });
    await metrics.initialize();

    metrics.recordPage();
    time.value = 1_235;
    metrics.record("save_intent");
    await metrics.drainPersistence();

    const persisted: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(persisted).toEqual({
      teamStarts: 0,
      completedQrIssuances: 0,
      pages: 1,
      downloads: 0,
      decryptSuccess: 0,
      saveIntent: 1,
      joinClick: 0,
      updatedAt: 1_235,
    });
    expect(Object.keys(persisted as object).sort()).toEqual([
      "completedQrIssuances",
      "decryptSuccess",
      "downloads",
      "joinClick",
      "pages",
      "saveIntent",
      "teamStarts",
      "updatedAt",
    ]);
    expect(await readdir(join(root, "runtime-data"))).toEqual(["metrics.json"]);
  });

  it("keeps the previous metrics file intact when the atomic rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-metrics-failure-"));
    const path = join(root, "metrics.json");
    const previous = '{"pages":7,"downloads":0,"decryptSuccess":0,"saveIntent":0,"joinClick":0,"updatedAt":100}';
    await writeFile(path, previous);
    const fileSystem: MetricsFileSystem = {
      mkdir,
      readFile,
      writeFile,
      rm,
      rename: async () => {
        throw new Error("rename failed");
      },
    };
    const metrics = new AggregateMetrics({ now: () => 200, persistencePath: path, fileSystem });
    await metrics.initialize();

    metrics.recordDownload();
    await expect(metrics.drainPersistence()).rejects.toThrow("rename failed");

    expect(await readFile(path, "utf8")).toBe(previous);
    expect(await readdir(root)).toEqual(["metrics.json"]);
  });

  it("does not persist throttled public events", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-metrics-throttle-"));
    const path = join(root, "metrics.json");
    const metrics = new AggregateMetrics({ now: () => 5_000, persistencePath: path });
    await metrics.initialize();

    for (let count = 0; count < 10; count += 1) {
      expect(metrics.record("decrypt_success")).toBe(true);
    }
    expect(metrics.record("decrypt_success")).toBe(false);
    await metrics.drainPersistence();

    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ decryptSuccess: 10 });
  });

  it("loads valid aggregate counters before recording the first event after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-metrics-restart-"));
    const path = join(root, "metrics.json");
    await writeFile(path, JSON.stringify({
      pages: 7,
      downloads: 6,
      decryptSuccess: 5,
      saveIntent: 4,
      joinClick: 3,
      updatedAt: 100,
    }));
    const metrics = new AggregateMetrics({ now: () => 200, persistencePath: path });

    await metrics.initialize();
    metrics.record("join_click");
    await metrics.drainPersistence();

    expect(metrics.snapshot()).toEqual({ teamStarts: 0, completedQrIssuances: 0, pages: 7, downloads: 6, decryptSuccess: 5, saveIntent: 4, joinClick: 4 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      teamStarts: 0,
      completedQrIssuances: 0,
      pages: 7,
      downloads: 6,
      decryptSuccess: 5,
      saveIntent: 4,
      joinClick: 4,
      updatedAt: 200,
    });
  });

  it("rejects persisted metrics containing unknown or identifier fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-metrics-invalid-"));
    const path = join(root, "metrics.json");
    await writeFile(path, JSON.stringify({
      pages: 1,
      downloads: 0,
      decryptSuccess: 0,
      saveIntent: 0,
      joinClick: 0,
      updatedAt: 100,
      sessionId: "must-not-load",
    }));
    const metrics = new AggregateMetrics({ persistencePath: path });

    await expect(metrics.initialize()).rejects.toThrow("Invalid aggregate metrics");
    expect(metrics.snapshot()).toEqual({ teamStarts: 0, completedQrIssuances: 0, pages: 0, downloads: 0, decryptSuccess: 0, saveIntent: 0, joinClick: 0 });
  });

  it("coalesces accepted counters behind one bounded persistence pump while a write stalls", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-metrics-coalesce-"));
    const path = join(root, "metrics.json");
    const writeStarted = deferred<void>();
    const releaseFirstWrite = deferred<void>();
    let writeCalls = 0;
    const fileSystem: MetricsFileSystem = {
      mkdir,
      readFile,
      rename,
      rm,
      writeFile: (async (...args: Parameters<typeof writeFile>) => {
        writeCalls += 1;
        if (writeCalls === 1) {
          writeStarted.resolve();
          await releaseFirstWrite.promise;
        }
        return writeFile(...args);
      }) as typeof writeFile,
    };
    const metrics = new AggregateMetrics({ persistencePath: path, fileSystem });
    await metrics.initialize();

    for (let count = 0; count < 1_000; count += 1) metrics.recordPage();
    await writeStarted.promise;

    expect(metrics.persistenceStatus()).toEqual({ dirty: true, inFlight: true });
    expect(writeCalls).toBe(1);
    releaseFirstWrite.resolve();
    await metrics.drainPersistence();

    expect(writeCalls).toBeLessThanOrEqual(2);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pages: 1_000 });
    expect(metrics.persistenceStatus()).toEqual({ dirty: false, inFlight: false });
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

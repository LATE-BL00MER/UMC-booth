import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AggregateMetrics, type MetricsFileSystem } from "../../src/server/metrics";

describe("aggregate metrics persistence", () => {
  it("atomically persists only aggregate counters and updatedAt after every accepted metric", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-metrics-"));
    const path = join(root, "runtime-data", "metrics.json");
    const time = { value: 1_234 };
    const metrics = new AggregateMetrics({ now: () => time.value, persistencePath: path });

    await metrics.recordPage();
    time.value = 1_235;
    await metrics.record("save_intent");

    const persisted: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(persisted).toEqual({
      pages: 1,
      downloads: 0,
      decryptSuccess: 0,
      saveIntent: 1,
      joinClick: 0,
      updatedAt: 1_235,
    });
    expect(Object.keys(persisted as object).sort()).toEqual([
      "decryptSuccess",
      "downloads",
      "joinClick",
      "pages",
      "saveIntent",
      "updatedAt",
    ]);
    expect(await readdir(join(root, "runtime-data"))).toEqual(["metrics.json"]);
  });

  it("keeps the previous metrics file intact when the atomic rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-metrics-failure-"));
    const path = join(root, "metrics.json");
    const previous = '{"pages":7,"updatedAt":100}';
    await writeFile(path, previous);
    const fileSystem: MetricsFileSystem = {
      mkdir,
      writeFile,
      rm,
      rename: async () => {
        throw new Error("rename failed");
      },
    };
    const metrics = new AggregateMetrics({ now: () => 200, persistencePath: path, fileSystem });

    await expect(metrics.recordDownload()).rejects.toThrow("rename failed");

    expect(await readFile(path, "utf8")).toBe(previous);
    expect(await readdir(root)).toEqual(["metrics.json"]);
  });

  it("does not persist throttled public events", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-metrics-throttle-"));
    const path = join(root, "metrics.json");
    const metrics = new AggregateMetrics({ now: () => 5_000, persistencePath: path });

    for (let count = 0; count < 10; count += 1) {
      await expect(metrics.record("decrypt_success")).resolves.toBe(true);
    }
    await expect(metrics.record("decrypt_success")).resolves.toBe(false);

    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ decryptSuccess: 10 });
  });
});

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/shared/config";
import { buildPrivateServer } from "../../src/server/private-server";
import { FileSessionStore } from "../../src/server/session-store";
import type { RuntimeStatusProvider } from "../../src/server/types";

async function createAppWithAssets(relativeAssetPaths = false) {
  const root = await mkdtemp(join(tmpdir(), "umc-static-"));
  const operatorBuildDir = join(root, "operator");
  const framePackDir = join(root, "frames");
  const poseConfigPath = join(root, "poses.json");
  await mkdir(join(operatorBuildDir, "assets"), { recursive: true });
  await mkdir(framePackDir, { recursive: true });
  await writeFile(join(operatorBuildDir, "index.html"), "<!doctype html><title>Operator</title>");
  await writeFile(join(operatorBuildDir, "assets", "app.js"), "console.log('operator')");
  await writeFile(join(framePackDir, "frame.svg"), "<svg></svg>");
  await writeFile(poseConfigPath, '["one", "two", "three", "four", "five", "six"]');
  const store = new FileSessionStore({ root: join(root, "sessions"), clock: { now: () => 1_000 }, activeTtlMs: 600_000, pendingTtlMs: 120_000 });
  await store.initialize();
  const config: AppConfig = {
    nodeEnv: "test", joinSiteUrl: "https://join.example.test", privatePort: 4173, publicPort: 4174,
    sessionDir: join(root, "sessions"),
    framePackDir: relativeAssetPaths ? relative(process.cwd(), framePackDir) : framePackDir,
    poseConfigPath: relativeAssetPaths ? relative(process.cwd(), poseConfigPath) : poseConfigPath,
    tunnelMode: "local", localPublicBaseUrl: "http://127.0.0.1:4174",
    countdownSeconds: 5, captureCount: 6, selectedCount: 4, activeTtlMs: 600_000, pendingTtlMs: 120_000, sweepIntervalMs: 30_000, countdownTickMs: 1_000,
  };
  const runtimeStatus: RuntimeStatusProvider = { getStatus: async () => ({ tunnel: "starting", publicUrl: null, publicLatencyMs: null, lastSweepAt: null, pendingSessions: 0, activeSessions: 0, encryptedBytes: 0, acceptingCaptures: false }), requestShutdown: async () => undefined };
  const app = buildPrivateServer({ store, config, runtimeStatus, operatorBuildDir });
  await app.ready();
  return app;
}

describe("private static assets", () => {
  const apps: Awaited<ReturnType<typeof createAppWithAssets>>[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  it("serves only the configured operator build, frame pack, and poses", async () => {
    const app = await createAppWithAssets();
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/" })).body).toContain("Operator");
    expect((await app.inject({ method: "GET", url: "/assets/app.js" })).body).toContain("operator");
    expect((await app.inject({ method: "GET", url: "/frame-pack/frame.svg" })).body).toContain("svg");
    expect((await app.inject({ method: "GET", url: "/poses.json" })).json()).toHaveLength(6);
  });

  it("accepts relative asset paths produced by the default runtime configuration", async () => {
    const app = await createAppWithAssets(true);
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/frame-pack/frame.svg" })).body).toContain("svg");
    expect((await app.inject({ method: "GET", url: "/poses.json" })).json()).toHaveLength(6);
  });

  it("rejects traversal, directories, dotfiles, and unrelated filesystem paths", async () => {
    const app = await createAppWithAssets();
    apps.push(app);
    for (const url of ["/frame-pack/..%2Fposes.json", "/frame-pack/", "/frame-pack/.secret", "/etc/passwd"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
  });
});

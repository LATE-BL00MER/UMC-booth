import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parseFrameManifest } from "../operator/frames/frame-repository";
import { loadConfig } from "../shared/config";
import { AggregateMetrics } from "./metrics";
import { buildPrivateServer } from "./private-server";
import { buildPublicServer } from "./public-server";
import { createRuntime } from "./runtime";
import { FileSessionStore } from "./session-store";
import { TunnelSupervisor } from "./tunnel-supervisor";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const operatorBuildDir = resolve("dist/operator");
  const recipientTemplatePath = resolve("dist/recipient/index.html");
  const recipientHtml = await readFile(recipientTemplatePath, "utf8");
  await validatePrebuiltAssets(operatorBuildDir, config.framePackDir, config.poseConfigPath);

  const store = new FileSessionStore({
    root: config.sessionDir,
    clock: { now: Date.now },
    activeTtlMs: config.activeTtlMs,
    pendingTtlMs: config.pendingTtlMs,
  });
  const metrics = new AggregateMetrics({
    persistencePath: resolve("runtime-data/metrics.json"),
  });
  await metrics.initialize();
  const runtime = createRuntime({
    config,
    store,
    createPublicServer: () => buildPublicServer({ store, config, recipientHtml, metrics }),
    createPrivateServer: (runtimeStatus) => buildPrivateServer({
      store,
      config,
      runtimeStatus,
      operatorBuildDir,
      metrics,
    }),
    tunnel: new TunnelSupervisor(),
    metrics,
  });

  await runtime.start();
  const status = await runtime.getStatus();
  console.log(`Operator: http://127.0.0.1:${config.privatePort}`);
  console.log(`Health: private=healthy public=healthy tunnel=${status.tunnel} cleanup=${status.lastSweepAt === null ? "down" : "healthy"}`);
}

async function validatePrebuiltAssets(operatorBuildDir: string, framePackDir: string, poseConfigPath: string): Promise<void> {
  const [, manifestText, posesText] = await Promise.all([
    readFile(resolve(operatorBuildDir, "operator.html"), "utf8"),
    readFile(resolve(framePackDir, "manifest.json"), "utf8"),
    readFile(poseConfigPath, "utf8"),
  ]);
  const manifest = parseFrameManifest(JSON.parse(manifestText));
  const poses: unknown = JSON.parse(posesText);
  if (!Array.isArray(poses) || poses.length !== 6 || poses.some((pose) => typeof pose !== "string" || pose.trim().length === 0)) {
    throw new Error("Pose prompts must contain six non-empty strings");
  }
  await Promise.all([
    readFile(resolve(dirname(resolve(framePackDir, "manifest.json")), basename(manifest.thumbnail))),
    readFile(resolve(dirname(resolve(framePackDir, "manifest.json")), basename(manifest.overlay))),
  ]);
}

void main().catch(() => {
  console.error("Runtime startup failed");
  process.exitCode = 1;
});

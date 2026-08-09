import { createRoot } from "react-dom/client";

import { App, type AppServices, type RuntimePreflightStatus } from "./App.js";
import { BrowserCameraPort } from "./camera/camera-port.js";
import { MemoryIssuedSessionRegistry } from "./delivery/issued-session-registry.js";
import { EncryptedDeliveryCoordinator } from "./delivery/delivery-coordinator.js";
import { FetchPrivateApiClient } from "./delivery/private-api-client.js";
import { BrowserCompositor } from "./frames/browser-compositor.js";
import { loadFramePack } from "./frames/frame-repository.js";

const root = document.querySelector("#root");

if (!root) {
  throw new Error("Operator root is missing");
}

void bootstrap(root).catch(() => {
  createRoot(root).render(<p role="alert">운영 화면을 준비하지 못했습니다</p>);
});

async function bootstrap(rootElement: Element): Promise<void> {
  const [frames, prompts] = await Promise.all([
    loadOperatorFrames(),
    loadOperatorPrompts(),
  ]);
  createRoot(rootElement).render(<App services={createBrowserServices(frames, prompts)} />);
}

async function loadOperatorFrames() {
  return [await loadFramePack("/frame-pack")];
}

async function loadOperatorPrompts(): Promise<[string, string, string, string, string, string]> {
  const response = await fetch("/poses.json");
  if (!response.ok) throw new Error("Could not load pose prompts");
  const prompts: unknown = await response.json();
  if (!Array.isArray(prompts) || prompts.length !== 6 || prompts.some((prompt) => typeof prompt !== "string" || prompt.trim().length === 0)) {
    throw new Error("Pose prompts must contain six non-empty strings");
  }
  return prompts as [string, string, string, string, string, string];
}

function createBrowserServices(
  frames: Awaited<ReturnType<typeof loadOperatorFrames>>,
  prompts: [string, string, string, string, string, string],
): AppServices {
  const registry = new MemoryIssuedSessionRegistry();
  const api = new FetchPrivateApiClient();
  let publicUrl: string | null = null;

  return {
    camera: new BrowserCameraPort(),
    compositor: new BrowserCompositor(),
    delivery: new EncryptedDeliveryCoordinator(api, registry),
    registry,
    api,
    frames,
    prompts,
    countdownTickMs: 1_000,
    getPublicUrl: () => publicUrl,
    preflight: {
      readStatus: async (signal) => {
        const response = await fetch("/api/status", { signal });
        if (!response.ok) throw new Error("Could not read runtime status");
        const status = parseRuntimeStatus(await response.json());
        publicUrl = status.publicUrl;
        return {
          tunnel: {
            state: status.tunnel,
            publicUrl: status.publicUrl,
            latencyMs: status.publicLatencyMs,
            error: null,
          },
          lastSuccessfulSweepAt: status.lastSweepAt,
          activeCiphertextCount: status.pendingSessions + status.activeSessions,
        };
      },
    },
  };
}

interface RuntimeStatusResponse {
  tunnel: RuntimePreflightStatus["tunnel"]["state"];
  publicUrl: string | null;
  publicLatencyMs: number | null;
  lastSweepAt: number | null;
  pendingSessions: number;
  activeSessions: number;
}

function parseRuntimeStatus(value: unknown): RuntimeStatusResponse {
  if (!isRecord(value) ||
    !isTunnelState(value.tunnel) ||
    !isNullableString(value.publicUrl) ||
    !isNullableNumber(value.publicLatencyMs) ||
    !isNullableNumber(value.lastSweepAt) ||
    !isNonNegativeInteger(value.pendingSessions) ||
    !isNonNegativeInteger(value.activeSessions)) {
    throw new Error("Runtime status response is malformed");
  }
  return {
    tunnel: value.tunnel,
    publicUrl: value.publicUrl,
    publicLatencyMs: value.publicLatencyMs,
    lastSweepAt: value.lastSweepAt,
    pendingSessions: value.pendingSessions,
    activeSessions: value.activeSessions,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTunnelState(value: unknown): value is RuntimeStatusResponse["tunnel"] {
  return value === "starting" || value === "healthy" || value === "down";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

import { createRoot } from "react-dom/client";

import "./styles/index.css";

import { App, type AppServices, type RuntimePreflightStatus } from "./App.js";
import { BrowserCameraPort } from "./camera/camera-port.js";
import { BootstrapShell } from "./components/BootstrapShell.js";
import { OperatorLogin } from "./components/OperatorLogin.js";
import { MemoryIssuedSessionRegistry } from "./delivery/issued-session-registry.js";
import { EncryptedDeliveryCoordinator } from "./delivery/delivery-coordinator.js";
import { FetchPrivateApiClient } from "./delivery/private-api-client.js";
import { BrowserCompositor } from "./frames/browser-compositor.js";
import { getCaptureAspectRatio } from "./frames/frame-contract.js";
import { loadFramePacks } from "./frames/frame-repository.js";

const root = document.querySelector("#root");

if (!root) {
  throw new Error("Operator root is missing");
}

const applicationRoot = createRoot(root);
const initialOperatorKey = readOperatorKey();

if (initialOperatorKey) {
  renderBootstrap(initialOperatorKey);
} else {
  applicationRoot.render(
    <OperatorLogin
      authenticate={authenticateOperatorPin}
      onAuthenticated={(operatorKey) => {
        retainOperatorKey(operatorKey);
        renderBootstrap(operatorKey);
      }}
    />,
  );
}

function renderBootstrap(operatorKey: string): void {
  applicationRoot.render(
    <BootstrapShell
      load={() => loadBrowserServices(operatorKey)}
      onReady={(services) => applicationRoot.render(<App services={services} />)}
    />,
  );
}

async function loadBrowserServices(operatorKey: string): Promise<AppServices> {
  const [frames, prompts, runtimeConfig] = await Promise.all([
    loadOperatorFrames(),
    loadOperatorPrompts(),
    loadOperatorRuntimeConfig(operatorKey),
  ]);
  return createBrowserServices(frames, prompts, runtimeConfig, operatorKey);
}

async function loadOperatorFrames() {
  return loadFramePacks("/frame-pack");
}

async function authenticateOperatorPin(pin: string): Promise<string> {
  const response = await fetch("/api/operator-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin }),
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("Operator PIN was rejected");
  const value: unknown = await response.json();
  if (!isRecord(value) || typeof value.operatorKey !== "string" || value.operatorKey.length < 32) {
    throw new Error("Operator login response is malformed");
  }
  return value.operatorKey;
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

async function loadOperatorRuntimeConfig(operatorKey: string | null): Promise<{ countdownTickMs: number; exposeDeliveryUrl: boolean }> {
  const response = await fetch("/api/operator-config", { headers: operatorHeaders(operatorKey) });
  if (!response.ok) throw new Error("Could not load operator runtime config");
  const value: unknown = await response.json();
  if (!isRecord(value) || !isPositiveInteger(value.countdownTickMs) || typeof value.exposeDeliveryUrl !== "boolean") {
    throw new Error("Operator runtime config is malformed");
  }
  return { countdownTickMs: value.countdownTickMs, exposeDeliveryUrl: value.exposeDeliveryUrl };
}

function createBrowserServices(
  frames: Awaited<ReturnType<typeof loadOperatorFrames>>,
  prompts: [string, string, string, string, string, string],
  runtimeConfig: { countdownTickMs: number; exposeDeliveryUrl: boolean },
  operatorKey: string | null,
): AppServices {
  const registry = new MemoryIssuedSessionRegistry();
  const api = new FetchPrivateApiClient(fetch.bind(globalThis), operatorKey);
  let lastCleanupRequestAt = 0;

  return {
    camera: new BrowserCameraPort(getCaptureAspectRatio(frames)),
    compositor: new BrowserCompositor(),
    delivery: new EncryptedDeliveryCoordinator(api, registry),
    registry,
    api,
    frames,
    prompts,
    countdownTickMs: runtimeConfig.countdownTickMs,
    exposeDeliveryUrl: runtimeConfig.exposeDeliveryUrl,
    // Delivery consumes App's controller-validated preflight URL. This retained member keeps
    // the injected service shape backwards-compatible without storing a stale closure here.
    getPublicUrl: () => null,
    preflight: {
      readStatus: async (signal) => {
        const now = Date.now();
        const requestCleanup = now - lastCleanupRequestAt >= 30_000;
        const response = await fetch(`/api/status${requestCleanup ? "?cleanup=1" : ""}`, {
          signal,
          headers: operatorHeaders(operatorKey),
        });
        if (!response.ok) throw new Error("Could not read runtime status");
        if (requestCleanup) lastCleanupRequestAt = now;
        const status = parseRuntimeStatus(await response.json());
        return {
          tunnel: {
            state: status.tunnel,
            publicUrl: status.publicUrl,
            latencyMs: status.publicLatencyMs,
            error: null,
          },
          acceptingCaptures: status.acceptingCaptures,
          lastSuccessfulSweepAt: status.lastSweepAt,
          activeCiphertextCount: status.pendingSessions + status.activeSessions,
        };
      },
    },
    metrics: {
      async record(event) {
        const response = await fetch("/api/metrics", {
          method: "POST",
          ...operatorRequestHeaders(operatorKey),
          body: JSON.stringify({ event }),
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error("Could not record aggregate operator metric");
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
  acceptingCaptures: boolean;
}

function parseRuntimeStatus(value: unknown): RuntimeStatusResponse {
  if (!isRecord(value) ||
    !isTunnelState(value.tunnel) ||
    !isNullableString(value.publicUrl) ||
    !isNullableNumber(value.publicLatencyMs) ||
    !isNullableNumber(value.lastSweepAt) ||
    !isNonNegativeInteger(value.pendingSessions) ||
    !isNonNegativeInteger(value.activeSessions) ||
    typeof value.acceptingCaptures !== "boolean") {
    throw new Error("Runtime status response is malformed");
  }
  return {
    tunnel: value.tunnel,
    publicUrl: value.publicUrl,
    publicLatencyMs: value.publicLatencyMs,
    lastSweepAt: value.lastSweepAt,
    pendingSessions: value.pendingSessions,
    activeSessions: value.activeSessions,
    acceptingCaptures: value.acceptingCaptures,
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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readOperatorKey(): string | null {
  const storageKey = "umc-photo-booth-operator-key";
  const parameters = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "");
  const supplied = parameters.get("operator")?.trim() || null;
  try {
    if (supplied) window.sessionStorage.setItem(storageKey, supplied);
    const retained = supplied ?? window.sessionStorage.getItem(storageKey)?.trim() ?? null;
    if (supplied) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    return retained || null;
  } catch {
    return supplied;
  }
}

function retainOperatorKey(operatorKey: string): void {
  try {
    window.sessionStorage.setItem("umc-photo-booth-operator-key", operatorKey);
  } catch {
    // The current page can still use the key when storage is unavailable.
  }
}

function operatorHeaders(key: string | null): Record<string, string> {
  return key ? { "x-operator-key": key } : {};
}

function operatorRequestHeaders(key: string | null): Pick<RequestInit, "headers"> {
  return {
    headers: {
      "content-type": "application/json",
      ...operatorHeaders(key),
    },
  };
}

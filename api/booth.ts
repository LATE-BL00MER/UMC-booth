import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";

import {
  BlobSessionStore,
  CloudSessionConflictError,
  CloudSessionNotFoundError,
} from "../src/vercel/blob-session-store.js";

const activeTtlMs = 5 * 60 * 1_000;
const pendingTtlMs = 2 * 60 * 1_000;
const maxCiphertextBytes = 4_000_000;
const operatorEvents = new Set(["team_start", "completed_qr"]);
const recipientEvents = new Set(["decrypt_success", "save_intent", "join_click"]);
const store = new BlobSessionStore({ activeTtlMs, pendingTtlMs });

let recipientTemplate: string | null = null;

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await routeRequest(request);
    } catch (error) {
      if (error instanceof CloudSessionNotFoundError) return safeError(404);
      if (error instanceof CloudSessionConflictError) return safeError(409);
      if (error instanceof TypeError) return safeError(400);
      return safeError(500);
    }
  },
};

async function routeRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const route = url.searchParams.get("route");

  if (route === "delivery") return deliveryPage(request, url.searchParams.get("token"));
  if (route === "file") return encryptedFile(request, url.searchParams.get("token"));
  if (route === "events") return recipientMetric(request);
  if (route === "cleanup") return scheduledCleanup(request);
  if (route === "operator-login") return operatorLogin(request);

  if (!hasOperatorAccess(request)) return safeError(404);
  if (route === "status") return runtimeStatus(request, url);
  if (route === "operator-config") return operatorConfig(request);
  if (route === "metrics") return operatorMetric(request);
  if (route === "sessions") return createSession(request);
  if (route === "activate") return activateSession(request, url.searchParams.get("id"));
  if (route === "resolve") return resolveSession(request, url.searchParams.get("id"));
  if (route === "delete") return deleteSession(request, url.searchParams.get("id"));
  return safeError(404);
}

async function operatorLogin(request: Request): Promise<Response> {
  if (request.method !== "POST") return safeError(405);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() !== "application/json") {
    return safeError(415);
  }
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > 128) return safeError(413);

  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return safeError(404);
  }
  const configuredPin = process.env.OPERATOR_PIN;
  const operatorSecret = process.env.OPERATOR_SECRET;
  if (!configuredPin || !operatorSecret || !exactPin(value) || !safeEqual(configuredPin, value.pin)) {
    return safeError(404);
  }
  return json({ operatorKey: operatorSecret });
}

function exactPin(value: unknown): value is { pin: string } {
  return Boolean(
    value
    && typeof value === "object"
    && Object.keys(value).length === 1
    && "pin" in value
    && typeof value.pin === "string"
    && /^\d{4}$/.test(value.pin),
  );
}

async function runtimeStatus(request: Request, url: URL): Promise<Response> {
  if (request.method !== "GET") return safeError(405);
  const now = Date.now();
  const stats = url.searchParams.get("cleanup") === "1"
    ? await store.sweep()
    : { pending: 0, active: 0, encryptedBytes: 0 };
  return json({
    tunnel: "healthy",
    publicUrl: url.origin,
    publicLatencyMs: 0,
    lastSweepAt: now,
    pendingSessions: stats.pending,
    activeSessions: stats.active,
    encryptedBytes: stats.encryptedBytes,
    acceptingCaptures: true,
  });
}

function operatorConfig(request: Request): Response {
  if (request.method !== "GET") return safeError(405);
  return json({ countdownTickMs: 1_000, exposeDeliveryUrl: false });
}

async function createSession(request: Request): Promise<Response> {
  if (request.method !== "POST") return safeError(405);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() !== "application/octet-stream") {
    return safeError(415);
  }
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxCiphertextBytes) return safeError(413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return safeError(400);
  if (bytes.byteLength > maxCiphertextBytes) return safeError(413);
  const session = await store.createPending(bytes);
  return json(session, 201);
}

async function activateSession(request: Request, id: string | null): Promise<Response> {
  if (request.method !== "POST") return safeError(405);
  if (!id) return safeError(404);
  return json(await store.activate(id));
}

async function resolveSession(request: Request, id: string | null): Promise<Response> {
  if (request.method !== "POST") return safeError(405);
  if (!id) return safeError(404);
  return json(await store.resolveActivationOrDelete(id));
}

async function deleteSession(request: Request, id: string | null): Promise<Response> {
  if (request.method !== "DELETE") return safeError(405);
  if (!id) return safeError(404);
  await store.deletePending(id);
  return new Response(null, { status: 204 });
}

async function deliveryPage(request: Request, token: string | null): Promise<Response> {
  if (request.method !== "GET") return safeError(405);
  if (!token) return safeError(404);
  const status = await store.inspectActive(token);
  if (status === "gone") return safeError(410);
  if (status !== "active") return safeError(404);
  return new Response(loadRecipientHtml(), {
    headers: {
      ...privacyHeaders(),
      "content-type": "text/html; charset=utf-8",
    },
  });
}

async function encryptedFile(request: Request, token: string | null): Promise<Response> {
  if (request.method !== "GET") return safeError(405);
  if (!token) return safeError(404);
  const lookup = await store.readActive(token);
  if (lookup.kind === "gone") return safeError(410);
  if (lookup.kind !== "active") return safeError(404);
  return encryptedStreamResponse(lookup.stream);
}

export function encryptedStreamResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      ...privacyHeaders(),
      "content-type": "application/octet-stream",
    },
  });
}

async function operatorMetric(request: Request): Promise<Response> {
  if (request.method === "GET") {
    return json({
      teamStarts: 0,
      completedQrIssuances: 0,
      recipientPages: 0,
      ciphertextDownloads: 0,
      decryptSuccesses: 0,
      saveIntents: 0,
      joinClicks: 0,
      updatedAt: Date.now(),
    });
  }
  if (request.method !== "POST") return safeError(405);
  const event = await exactEvent(request, operatorEvents);
  return event ? new Response(null, { status: 204 }) : safeError(400);
}

async function recipientMetric(request: Request): Promise<Response> {
  if (request.method !== "POST") return safeError(405);
  const event = await exactEvent(request, recipientEvents);
  return event ? new Response(null, { status: 204 }) : safeError(400);
}

async function scheduledCleanup(request: Request): Promise<Response> {
  if (request.method !== "GET") return safeError(405);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${cronSecret}`)) {
    return safeError(404);
  }
  return json(await store.sweep());
}

function hasOperatorAccess(request: Request): boolean {
  const configured = process.env.OPERATOR_SECRET;
  const supplied = request.headers.get("x-operator-key");
  return Boolean(configured && supplied && safeEqual(configured, supplied));
}

function safeEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

async function exactEvent(request: Request, allowed: ReadonlySet<string>): Promise<string | null> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Object.keys(value).length !== 1 || !("event" in value)) return null;
  return typeof value.event === "string" && allowed.has(value.event) ? value.event : null;
}

function loadRecipientHtml(): string {
  if (recipientTemplate === null) {
    recipientTemplate = readFileSync(resolve(process.cwd(), "dist/recipient/index.html"), "utf8");
  }
  const joinSiteUrl = validJoinSiteUrl(process.env.JOIN_SITE_URL)
    ?? "https://university.neordinary.com/about";
  const serialized = JSON.stringify(joinSiteUrl).replaceAll("<", "\\u003c");
  return recipientTemplate.replace(
    "__JOIN_CONFIG_SCRIPT__",
    `<script>window.__UMC_JOIN_SITE_URL__=${serialized}</script>`,
  );
}

function validJoinSiteUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function privacyHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'self'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function safeError(status: 400 | 404 | 405 | 409 | 410 | 413 | 415 | 500): Response {
  const messages = {
    400: "Bad request",
    404: "Not found",
    405: "Method not allowed",
    409: "Conflict",
    410: "Gone",
    413: "Payload too large",
    415: "Unsupported media type",
    500: "Internal server error",
  } as const;
  return json({ error: messages[status] }, status);
}

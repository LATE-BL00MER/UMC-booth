import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/shared/config";
import { buildPrivateServer } from "../../src/server/private-server";
import { FileSessionStore } from "../../src/server/session-store";
import type { RuntimeStatus, RuntimeStatusProvider } from "../../src/server/types";

const twelveMiB = 12 * 1024 * 1024;

async function createPrivateApp() {
  const root = await mkdtemp(join(tmpdir(), "umc-private-"));
  const time = { value: 1_000 };
  const store = new FileSessionStore({
    root: join(root, "sessions"),
    clock: { now: () => time.value },
    activeTtlMs: 600_000,
    pendingTtlMs: 120_000,
  });
  await store.initialize();
  const availability = { acceptingCaptures: true };
  const runtimeStatus: RuntimeStatusProvider = {
    getStatus: vi.fn(async (): Promise<RuntimeStatus> => ({
      tunnel: "healthy",
      publicUrl: "https://example.test",
      publicLatencyMs: 23,
      lastSweepAt: 900,
      pendingSessions: 2,
      activeSessions: 3,
      encryptedBytes: 42,
      acceptingCaptures: availability.acceptingCaptures,
    })),
    requestShutdown: vi.fn(async () => undefined),
  };
  const config: AppConfig = {
    nodeEnv: "test",
    joinSiteUrl: "https://join.example.test",
    privatePort: 4173,
    publicPort: 4174,
    sessionDir: join(root, "sessions"),
    framePackDir: join(root, "frames"),
    poseConfigPath: join(root, "poses.json"),
    tunnelMode: "local",
    localPublicBaseUrl: "http://127.0.0.1:4174",
    countdownSeconds: 5,
    captureCount: 6,
    selectedCount: 4,
    activeTtlMs: 600_000,
    pendingTtlMs: 120_000,
    sweepIntervalMs: 30_000,
    countdownTickMs: 1_000,
  };
  const app = buildPrivateServer({ store, config, runtimeStatus, operatorBuildDir: join(root, "operator") });
  await app.ready();
  return { app, availability, runtimeStatus, store };
}

describe("private server", () => {
  const apps: Array<Awaited<ReturnType<typeof createPrivateApp>>["app"]> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("stores ciphertext only through the private listener", async () => {
    const context = await createPrivateApp();
    apps.push(context.app);

    const response = await context.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from([9, 8, 7]),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: expect.any(String), createdAt: 1_000 });
  });

  it("rejects new ciphertext while runtime cleanup health is unavailable", async () => {
    const context = await createPrivateApp();
    apps.push(context.app);
    context.availability.acceptingCaptures = false;

    const response = await context.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from([9, 8, 7]),
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"error":"Service unavailable"}');
    expect(await context.store.stats()).toMatchObject({ pending: 0, active: 0 });
  });

  it("exposes runtime status without session details", async () => {
    const context = await createPrivateApp();
    apps.push(context.app);

    const response = await context.app.inject({ method: "GET", url: "/api/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tunnel: "healthy",
      publicUrl: "https://example.test",
      publicLatencyMs: 23,
      lastSweepAt: 900,
      pendingSessions: 2,
      activeSessions: 3,
      encryptedBytes: 42,
      acceptingCaptures: true,
    });
  });

  it("rejects non-binary and oversized session payloads", async () => {
    const context = await createPrivateApp();
    apps.push(context.app);

    const nonBinary = await context.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "content-type": "application/json" },
      payload: { ciphertext: "not allowed" },
    });
    const oversized = await context.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.alloc(twelveMiB + 1),
    });

    expect(nonBinary.statusCode).toBe(415);
    expect(oversized.statusCode).toBe(413);
  });

  it("activates pending sessions but never leaks a public URL", async () => {
    const context = await createPrivateApp();
    apps.push(context.app);
    const created = await context.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from([1]),
    });
    const { id } = created.json() as { id: string };

    const activated = await context.app.inject({ method: "POST", url: `/api/sessions/${id}/activate` });

    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toEqual({ id, publicToken: expect.any(String), expiresAt: 601_000 });
    expect(activated.body).not.toContain("http");
  });

  it("atomically resolves or deletes only on the private listener with a fixed response", async () => {
    const context = await createPrivateApp();
    apps.push(context.app);
    const pending = await context.store.createPending(new Uint8Array([1]));

    const deleted = await context.app.inject({ method: "POST", url: `/api/sessions/${pending.id}/resolve` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ status: "deleted" });
    expect(deleted.body).not.toContain(pending.id);

    const activePending = await context.store.createPending(new Uint8Array([2]));
    const active = await context.store.activate(activePending.id);
    const resolved = await context.app.inject({ method: "POST", url: `/api/sessions/${activePending.id}/resolve` });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual({ status: "active", publicToken: active.publicToken, expiresAt: active.expiresAt });
  });

  it("does not retain the replaced activation lookup endpoint", async () => {
    const context = await createPrivateApp();
    apps.push(context.app);
    const pending = await context.store.createPending(new Uint8Array([1]));

    expect((await context.app.inject({ method: "GET", url: `/api/sessions/${pending.id}/activation` })).statusCode).toBe(404);
  });

  it("deletes pending sessions idempotently and refuses active session deletion", async () => {
    const context = await createPrivateApp();
    apps.push(context.app);
    const pending = await context.store.createPending(new Uint8Array([1]));
    const active = await context.store.createPending(new Uint8Array([2]));
    await context.store.activate(active.id);

    expect((await context.app.inject({ method: "DELETE", url: `/api/sessions/${pending.id}` })).statusCode).toBe(204);
    expect((await context.app.inject({ method: "DELETE", url: `/api/sessions/${pending.id}` })).statusCode).toBe(204);
    const activeDeletion = await context.app.inject({ method: "DELETE", url: `/api/sessions/${active.id}` });
    expect(activeDeletion.statusCode).toBe(409);
    expect(activeDeletion.body).toBe('{"error":"Conflict"}');
  });

  it("requires the exact shutdown confirmation and schedules shutdown after accepting it", async () => {
    const context = await createPrivateApp();
    apps.push(context.app);

    expect((await context.app.inject({ method: "POST", url: "/api/shutdown", payload: { confirm: "no" } })).statusCode).toBe(400);
    expect((await context.app.inject({ method: "POST", url: "/api/shutdown", payload: { confirm: "DELETE_ALL" } })).statusCode).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));

    expect(context.runtimeStatus.requestShutdown).toHaveBeenCalledOnce();
  });

  it("does not reflect identifiers from unmatched private paths", async () => {
    const context = await createPrivateApp();
    apps.push(context.app);

    const response = await context.app.inject({
      method: "GET",
      url: "/api/unknown-private-identifier",
      headers: { cookie: "operator=private-cookie", "x-forwarded-for": "198.51.100.7" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('{"error":"Not found"}');
    expect(response.body).not.toContain("unknown-private-identifier");
    expect(response.body).not.toContain("private-cookie");
    expect(response.body).not.toContain("198.51.100.7");
  });

  it("returns a sanitized 404 or 405 for forbidden private methods", async () => {
    const context = await createPrivateApp();
    apps.push(context.app);

    const response = await context.app.inject({ method: "GET", url: "/api/sessions" });

    expect([404, 405]).toContain(response.statusCode);
    expect(response.body).toMatch(/^\{"error":"(?:Not found|Method not allowed)"\}$/);
  });

  it("returns a fixed unsupported-media error without request data", async () => {
    const context = await createPrivateApp();
    apps.push(context.app);

    const response = await context.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "content-type": "application/json" },
      payload: { ciphertext: "private-identifier" },
    });

    expect(response.statusCode).toBe(415);
    expect(response.body).toBe('{"error":"Unsupported media type"}');
    expect(response.body).not.toContain("private-identifier");
  });
});

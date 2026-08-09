import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AggregateMetrics } from "../../src/server/metrics";
import { buildPublicServer } from "../../src/server/public-server";
import { FileSessionStore } from "../../src/server/session-store";

async function createPublicApp() {
  const root = await mkdtemp(join(tmpdir(), "umc-public-"));
  const time = { value: 1_000 };
  const store = new FileSessionStore({
    root,
    clock: { now: () => time.value },
    activeTtlMs: 600_000,
    pendingTtlMs: 120_000,
  });
  await store.initialize();
  const metrics = new AggregateMetrics({ now: () => time.value });
  const app = buildPublicServer({ store, recipientHtml: "<!doctype html><title>Download</title>", metrics });
  await app.ready();
  return { app, metrics, store, time };
}

const privacyHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'self'",
};

describe("public server", () => {
  const apps: Array<Awaited<ReturnType<typeof createPublicApp>>["app"]> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("never exposes private mutation routes on the public listener", async () => {
    const context = await createPublicApp();
    apps.push(context.app);

    const response = await context.app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: Buffer.from([1, 2]),
    });

    expect(response.statusCode).toBe(404);
  });

  it("marks public health responses as non-cacheable", async () => {
    const context = await createPublicApp();
    apps.push(context.app);

    const response = await context.app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("serves the recipient document with privacy headers for an active token", async () => {
    const context = await createPublicApp();
    apps.push(context.app);
    const active = await context.store.activate((await context.store.createPending(new Uint8Array([9]))).id);

    const response = await context.app.inject({ method: "GET", url: `/d/${active.publicToken}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Download");
    expect(response.headers).toMatchObject(privacyHeaders);
    expect(context.metrics.snapshot()).toEqual({ pages: 1, downloads: 0, decryptSuccess: 0, saveIntent: 0, joinClick: 0 });
  });

  it("returns no-store ciphertext and 410 at expiry", async () => {
    const context = await createPublicApp();
    apps.push(context.app);
    const ciphertext = new Uint8Array([3, 2, 1]);
    const active = await context.store.activate((await context.store.createPending(ciphertext)).id);

    const activeResponse = await context.app.inject({ method: "GET", url: `/f/${active.publicToken}` });
    expect(activeResponse.statusCode).toBe(200);
    expect(activeResponse.headers).toMatchObject(privacyHeaders);
    expect(activeResponse.headers["content-type"]).toContain("application/octet-stream");
    expect(activeResponse.rawPayload).toEqual(Buffer.from(ciphertext));
    context.time.value = active.expiresAt;
    const expiredResponse = await context.app.inject({ method: "GET", url: `/f/${active.publicToken}` });
    expect(expiredResponse.statusCode).toBe(410);
    expect(expiredResponse.headers).toMatchObject(privacyHeaders);
  });

  it("counts only allowed aggregate events and throttles after ten per second", async () => {
    const context = await createPublicApp();
    apps.push(context.app);

    for (let count = 0; count < 11; count += 1) {
      expect((await context.app.inject({ method: "POST", url: "/events", payload: { event: "decrypt_success" } })).statusCode).toBe(204);
    }
    expect((await context.app.inject({ method: "POST", url: "/events", payload: { event: "unknown" } })).statusCode).toBe(400);

    expect(context.metrics.snapshot()).toEqual({ pages: 0, downloads: 0, decryptSuccess: 10, saveIntent: 0, joinClick: 0 });
  });

  it("returns 404 for unknown paths and never reflects request headers", async () => {
    const context = await createPublicApp();
    apps.push(context.app);

    const response = await context.app.inject({
      method: "GET",
      url: "/api/status",
      headers: { "x-forwarded-for": "198.51.100.7", cookie: "secret=value", referer: "https://private.example" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("198.51.100.7");
    expect(response.body).not.toContain("secret=value");
    expect(response.body).not.toContain("private.example");
  });
});

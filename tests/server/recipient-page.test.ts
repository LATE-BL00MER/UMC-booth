import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPublicServer } from "../../src/server/public-server";
import { FileSessionStore } from "../../src/server/session-store";

describe("recipient page delivery", () => {
  const apps: ReturnType<typeof buildPublicServer>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("injects an escaped HTTPS join URL only after the delivery token is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-recipient-page-"));
    const templatePath = join(root, "recipient.html");
    await writeFile(templatePath, "<!doctype html>__JOIN_CONFIG_SCRIPT__<script>recipient()</script>");
    const store = new FileSessionStore({
      root,
      clock: { now: () => 1_000 },
      activeTtlMs: 600_000,
      pendingTtlMs: 120_000,
    });
    await store.initialize();
    const app = buildPublicServer({
      config: { joinSiteUrl: "https://join.example.test/?q=<tag>" },
      recipientTemplatePath: templatePath,
      store,
    });
    apps.push(app);
    await app.ready();
    const active = await store.activate((await store.createPending(new Uint8Array([1]))).id);

    const response = await app.inject({ method: "GET", url: `/d/${active.publicToken}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('window.__UMC_JOIN_SITE_URL__="https://join.example.test/?q=\\u003ctag>"');
    expect(response.body).not.toContain("__JOIN_CONFIG_SCRIPT__");
    expect((await app.inject({ method: "GET", url: "/d/not-a-token" })).statusCode).toBe(404);
  });

  it("injects the join URL when the entrypoint supplies a preloaded recipient template", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-recipient-preloaded-"));
    const store = new FileSessionStore({
      root,
      clock: { now: () => 1_000 },
      activeTtlMs: 600_000,
      pendingTtlMs: 120_000,
    });
    await store.initialize();
    const app = buildPublicServer({
      config: { joinSiteUrl: "https://join.example.test/apply?utm_source=booth" },
      recipientHtml: "<!doctype html>__JOIN_CONFIG_SCRIPT__<script>recipient()</script>",
      store,
    });
    apps.push(app);
    await app.ready();
    const active = await store.activate((await store.createPending(new Uint8Array([1]))).id);

    const response = await app.inject({ method: "GET", url: `/d/${active.publicToken}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('window.__UMC_JOIN_SITE_URL__="https://join.example.test/apply?utm_source=booth"');
    expect(response.body).not.toContain("__JOIN_CONFIG_SCRIPT__");
  });
});

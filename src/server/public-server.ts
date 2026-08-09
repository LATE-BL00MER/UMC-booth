import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { AppConfig } from "../shared/config";
import { AggregateMetrics, type AggregateEvent } from "./metrics";
import { safeStatusFor, sendSafeError } from "./safe-error";
import type { FileSessionStore, SessionLookup } from "./session-store";

const privacyHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'self'",
};

const events = new Set<AggregateEvent>(["decrypt_success", "save_intent", "join_click"]);

export interface PublicServerDependencies {
  store: FileSessionStore;
  config?: Pick<AppConfig, "joinSiteUrl">;
  recipientHtml?: string;
  recipientTemplatePath?: string;
  metrics?: AggregateMetrics;
}

export function buildPublicServer(deps: PublicServerDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  const metrics = deps.metrics ?? new AggregateMetrics();
  const recipientHtml = loadRecipientHtml(deps);

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });
  app.setNotFoundHandler((_request, reply) => sendSafeError(reply, 404));
  app.setErrorHandler((error, _request, reply) => sendSafeError(reply, safeStatusFor(error)));

  app.get("/health", async () => ({ ok: true }));

  app.get<{ Params: { token: string } }>("/d/:token", async (request, reply) => {
    reply.headers(privacyHeaders);
    const lookup = await deps.store.readActive(request.params.token);
    if (!sendLookupStatus(lookup, reply)) {
      return;
    }
    metrics.recordPage();
    return reply.type("text/html; charset=utf-8").send(recipientHtml);
  });

  app.get<{ Params: { token: string } }>("/f/:token", async (request, reply) => {
    reply.headers(privacyHeaders);
    const lookup = await deps.store.readActive(request.params.token);
    if (!sendLookupStatus(lookup, reply)) {
      return;
    }
    metrics.recordDownload();
    return reply.type("application/octet-stream").send(Buffer.from(lookup.bytes));
  });

  app.post("/events", async (request, reply) => {
    const event = getEvent(request.body);
    if (!event) {
      return sendSafeError(reply, 400);
    }
    metrics.record(event);
    return reply.code(204).send();
  });

  return app;
}

function loadRecipientHtml(deps: PublicServerDependencies): string {
  if (!deps.recipientTemplatePath || !deps.config) {
    return deps.recipientHtml ?? "";
  }
  const template = readFileSync(deps.recipientTemplatePath, "utf8");
  const serializedJoinUrl = JSON.stringify(deps.config.joinSiteUrl).replaceAll("<", "\\u003c");
  const joinConfigScript = `<script>window.__UMC_JOIN_SITE_URL__=${serializedJoinUrl}</script>`;
  return template.replace("__JOIN_CONFIG_SCRIPT__", joinConfigScript);
}

function sendLookupStatus(lookup: SessionLookup, reply: FastifyReply): lookup is Extract<SessionLookup, { kind: "active" }> {
  if (lookup.kind === "active") {
    return true;
  }
  sendSafeError(reply, lookup.kind === "gone" ? 410 : 404);
  return false;
}

function getEvent(value: unknown): AggregateEvent | null {
  if (!value || typeof value !== "object" || !("event" in value) || typeof value.event !== "string") {
    return null;
  }
  return events.has(value.event as AggregateEvent) ? value.event as AggregateEvent : null;
}

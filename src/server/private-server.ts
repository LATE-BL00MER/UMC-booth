import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { AppConfig } from "../shared/config";
import { safeStatusFor, sendSafeError } from "./safe-error";
import type { FileSessionStore } from "./session-store";
import type { RuntimeStatusProvider } from "./types";
import { AggregateMetrics } from "./metrics";

const ciphertextContentType = "application/octet-stream";
const bodyLimit = 12 * 1024 * 1024;

export interface PrivateServerDependencies {
  store: FileSessionStore;
  config: AppConfig;
  runtimeStatus: RuntimeStatusProvider;
  operatorBuildDir: string;
  metrics?: AggregateMetrics;
}

export function buildPrivateServer(deps: PrivateServerDependencies): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit });
  const metrics = deps.metrics ?? new AggregateMetrics();

  app.setNotFoundHandler((_request, reply) => sendSafeError(reply, 404));
  app.setErrorHandler((error, _request, reply) => sendSafeError(reply, hasStatusCode(error, 403) ? 404 : safeStatusFor(error)));

  app.addContentTypeParser(ciphertextContentType, { parseAs: "buffer" }, (_request, payload, done) => {
    done(null, payload);
  });

  void app.register(fastifyStatic, {
    root: resolve(deps.operatorBuildDir),
    prefix: "/",
    index: ["operator.html", "index.html"],
    list: false,
    dotfiles: "deny",
    redirect: false,
  });
  void app.register(fastifyStatic, {
    root: resolve(deps.config.framePackDir),
    prefix: "/frame-pack/",
    list: false,
    dotfiles: "deny",
    redirect: false,
    decorateReply: false,
  });

  app.get("/poses.json", async (_request, reply) => {
    try {
      const poses = await readFile(resolve(deps.config.poseConfigPath), "utf8");
      return reply.type("application/json; charset=utf-8").send(poses);
    } catch {
      return sendSafeError(reply, 404);
    }
  });

  app.get("/api/status", async () => deps.runtimeStatus.getStatus());

  app.get("/api/operator-config", async () => ({
    countdownTickMs: deps.config.countdownTickMs,
    exposeDeliveryUrl: deps.config.nodeEnv === "test",
  }));

  app.get("/api/metrics", async () => metrics.snapshot());

  app.post("/api/metrics", async (request, reply) => {
    const event = operatorMetricEvent(request.body);
    if (event === null) return sendSafeError(reply, 400);
    if (event === "team_start") metrics.recordTeamStart();
    else metrics.recordCompletedQr();
    return reply.code(204).send();
  });

  app.post("/api/sessions", async (request, reply) => {
    if (!(await deps.runtimeStatus.getStatus()).acceptingCaptures) {
      return sendSafeError(reply, 503);
    }
    if (request.headers["content-type"]?.split(";", 1)[0]?.toLowerCase() !== ciphertextContentType) {
      return sendSafeError(reply, 415);
    }
    if (!Buffer.isBuffer(request.body)) {
      return sendSafeError(reply, 415);
    }
    const session = await deps.store.createPending(request.body);
    return reply.code(201).send(session);
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/activate", async (request, reply) => {
    if (!(await deps.runtimeStatus.getStatus()).acceptingCaptures) {
      return sendSafeError(reply, 503);
    }
    try {
      const session = await deps.store.activate(request.params.id);
      return reply.send(session);
    } catch (error) {
      if (error instanceof TypeError || error instanceof Error && error.message === "Session not found") {
        return sendSafeError(reply, 404);
      }
      return sendSafeError(reply, 409);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/resolve", async (request, reply) => {
    const resolution = await deps.store.resolveActivationOrDelete(request.params.id);
    return reply.send(resolution);
  });

  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    try {
      const deleted = await deps.store.deletePending(request.params.id);
      if (deleted) return reply.code(204).send();
      const record = await deps.store.inspectById(request.params.id);
      return record.status === "pending" ? reply.code(204).send() : sendSafeError(reply, 409);
    } catch (error) {
      if (error instanceof TypeError || error instanceof Error && error.message === "Session not found") {
        return reply.code(204).send();
      }
      throw error;
    }
  });

  app.post("/api/shutdown", async (request, reply) => {
    if (!isShutdownRequest(request.body)) {
      return sendSafeError(reply, 400);
    }
    setImmediate(() => {
      void deps.runtimeStatus.requestShutdown().catch(() => undefined);
    });
    return reply.code(202).send();
  });

  return app;
}

function isShutdownRequest(value: unknown): value is { confirm: "DELETE_ALL" } {
  return typeof value === "object"
    && value !== null
    && Object.keys(value).length === 1
    && "confirm" in value
    && value.confirm === "DELETE_ALL";
}

function hasStatusCode(error: unknown, statusCode: number): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === statusCode;
}

function operatorMetricEvent(value: unknown): "team_start" | "completed_qr" | null {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 1 || !("event" in value)) return null;
  return value.event === "team_start" || value.event === "completed_qr" ? value.event : null;
}

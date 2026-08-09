import { readFile } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { AppConfig } from "../shared/config";
import type { FileSessionStore } from "./session-store";
import type { RuntimeStatusProvider } from "./types";

const ciphertextContentType = "application/octet-stream";
const bodyLimit = 12 * 1024 * 1024;

export interface PrivateServerDependencies {
  store: FileSessionStore;
  config: AppConfig;
  runtimeStatus: RuntimeStatusProvider;
  operatorBuildDir: string;
}

export function buildPrivateServer(deps: PrivateServerDependencies): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit });

  app.setErrorHandler((error, _request, reply) => {
    if (hasStatusCode(error, 403)) {
      return reply.code(404).send();
    }
    return reply.send(error);
  });

  app.addContentTypeParser(ciphertextContentType, { parseAs: "buffer" }, (_request, payload, done) => {
    done(null, payload);
  });

  void app.register(fastifyStatic, {
    root: deps.operatorBuildDir,
    prefix: "/",
    index: ["index.html"],
    list: false,
    dotfiles: "deny",
    redirect: false,
  });
  void app.register(fastifyStatic, {
    root: deps.config.framePackDir,
    prefix: "/frame-pack/",
    list: false,
    dotfiles: "deny",
    redirect: false,
    decorateReply: false,
  });

  app.get("/poses.json", async (_request, reply) => {
    try {
      const poses = await readFile(deps.config.poseConfigPath, "utf8");
      return reply.type("application/json; charset=utf-8").send(poses);
    } catch {
      return reply.code(404).send();
    }
  });

  app.get("/api/status", async () => deps.runtimeStatus.getStatus());

  app.post("/api/sessions", async (request, reply) => {
    if (request.headers["content-type"]?.split(";", 1)[0]?.toLowerCase() !== ciphertextContentType) {
      return reply.code(415).send();
    }
    if (!Buffer.isBuffer(request.body)) {
      return reply.code(415).send();
    }
    const session = await deps.store.createPending(request.body);
    return reply.code(201).send(session);
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/activate", async (request, reply) => {
    try {
      const session = await deps.store.activate(request.params.id);
      return reply.send(session);
    } catch (error) {
      if (error instanceof TypeError || error instanceof Error && error.message === "Session not found") {
        return reply.code(404).send();
      }
      return reply.code(409).send();
    }
  });

  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    try {
      const record = await deps.store.inspectById(request.params.id);
      if (record.status !== "pending") {
        return reply.code(409).send();
      }
    } catch {
      return reply.code(204).send();
    }
    await deps.store.deletePending(request.params.id);
    return reply.code(204).send();
  });

  app.post("/api/shutdown", async (request, reply) => {
    if (!isShutdownRequest(request.body)) {
      return reply.code(400).send();
    }
    setImmediate(() => {
      void deps.runtimeStatus.requestShutdown();
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

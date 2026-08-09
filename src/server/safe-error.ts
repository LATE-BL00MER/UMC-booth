import type { FastifyReply } from "fastify";

type SafeStatus = 400 | 404 | 405 | 409 | 410 | 413 | 415 | 500 | 503;

const messages: Record<SafeStatus, string> = {
  400: "Bad request",
  404: "Not found",
  405: "Method not allowed",
  409: "Conflict",
  410: "Gone",
  413: "Payload too large",
  415: "Unsupported media type",
  500: "Internal server error",
  503: "Service unavailable",
};

export function sendSafeError(reply: FastifyReply, statusCode: SafeStatus): FastifyReply {
  return reply.code(statusCode).type("application/json; charset=utf-8").send({ error: messages[statusCode] });
}

export function safeStatusFor(error: unknown): SafeStatus {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return 500;
  }
  return isSafeStatus(error.statusCode) ? error.statusCode : 500;
}

function isSafeStatus(statusCode: unknown): statusCode is SafeStatus {
  return statusCode === 400
    || statusCode === 404
    || statusCode === 405
    || statusCode === 409
    || statusCode === 410
    || statusCode === 413
    || statusCode === 415
    || statusCode === 503;
}

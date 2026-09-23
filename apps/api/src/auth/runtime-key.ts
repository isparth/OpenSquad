import type { RuntimeCredentials } from "@opensquad/core";
import type { FastifyRequest } from "fastify";

export function readRuntimeKey(request: FastifyRequest): RuntimeCredentials | null {
  const key = request.headers["x-opensquad-runtime-key"];
  if (typeof key !== "string" || !key.trim() || key.length > 4096 || key.includes(",")) return null;
  return { apiKey: key.trim() };
}

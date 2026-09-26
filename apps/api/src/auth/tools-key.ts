import type { ToolsCredentials } from "@opensquad/core";
import type { FastifyRequest } from "fastify";

export function readToolsKey(request: FastifyRequest): ToolsCredentials | null {
  const key = request.headers["x-opensquad-tools-key"];
  if (typeof key !== "string" || !key.trim() || key.length > 4096 || key.includes(",")) return null;
  return { apiKey: key.trim() };
}

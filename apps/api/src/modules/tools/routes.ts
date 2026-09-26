import { STATUS_CODES } from "node:http";
import type { ToolsCredentials } from "@opensquad/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { readToolsKey } from "../../auth/tools-key.js";
import { ToolsHttpError, toolsService } from "./service.js";

const toolkitSlug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const connectionId = z.string().regex(/^ca_[A-Za-z0-9_-]{1,64}$/);
const toolkitsQuery = z.strictObject({
  search: z.string().max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
});

function requireKey(request: FastifyRequest): ToolsCredentials {
  const credentials = readToolsKey(request);
  if (!credentials) throw new ToolsHttpError(400, "Provide one tools key in X-OpenSquad-Tools-Key");
  return credentials;
}

/** Aborts provider work when the client goes away before the reply is sent. */
function disconnectSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", app.requireAuth);
  app.setErrorHandler((error, request: FastifyRequest, reply) => {
    const suppliedStatus =
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const statusCode =
      error instanceof ToolsHttpError
        ? error.statusCode
        : suppliedStatus >= 400 && suppliedStatus < 500
          ? suppliedStatus
          : 500;
    if (statusCode === 500) request.log.error("Tools request failed");
    return reply.code(statusCode).send({
      statusCode,
      error: STATUS_CODES[statusCode],
      message:
        error instanceof ToolsHttpError
          ? error.message
          : statusCode < 500
            ? "Invalid request"
            : "Unable to process tools request",
      ...(error instanceof ToolsHttpError && error.code ? { code: error.code } : {}),
    });
  });
  const service = toolsService(app.capabilities.tools);

  app.get("/tools/toolkits", { schema: { querystring: toolkitsQuery } }, async (request, reply) => {
    const credentials = requireKey(request);
    const { search, cursor } = request.query;
    return service.listToolkits(
      credentials,
      { ...(search !== undefined ? { search } : {}), ...(cursor !== undefined ? { cursor } : {}) },
      disconnectSignal(reply),
    );
  });

  app.get("/tools/connections", async (request, reply) => ({
    items: await service.listConnections(
      requireKey(request),
      request.userId as string,
      disconnectSignal(reply),
    ),
  }));

  app.post(
    "/tools/connections",
    { schema: { body: z.strictObject({ toolkit: toolkitSlug }) } },
    async (request, reply) => {
      const credentials = requireKey(request);
      const result = await service.startConnection(
        credentials,
        request.userId as string,
        request.body.toolkit,
        disconnectSignal(reply),
      );
      return reply.code(201).send(result);
    },
  );

  app.delete(
    "/tools/connections/:connectionId",
    { schema: { params: z.object({ connectionId }) } },
    async (request, reply) => {
      const credentials = requireKey(request);
      await service.removeConnection(
        credentials,
        request.userId as string,
        request.params.connectionId,
        disconnectSignal(reply),
      );
      return reply.code(204).send();
    },
  );
};

export default routes;

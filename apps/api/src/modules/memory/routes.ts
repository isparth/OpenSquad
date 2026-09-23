import { STATUS_CODES } from "node:http";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { readRuntimeKey } from "../../auth/runtime-key.js";
import { MemoryError, memoryService } from "./service.js";

const idParams = z.object({ id: z.uuid() });
const documentParams = z.object({
  id: z.uuid(),
  name: z.enum(["profile", "preferences", "notes"]),
});
const revisionQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .optional(),
});
const saveBody = z.strictObject({
  content: z.string(),
  expectedVersion: z.number().int().min(0),
});
const revertBody = z.strictObject({
  version: z.number().int().min(1),
  expectedVersion: z.number().int().min(0),
});

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
      error instanceof MemoryError
        ? error.statusCode
        : suppliedStatus >= 400 && suppliedStatus < 500
          ? suppliedStatus
          : 500;
    if (statusCode === 500) request.log.error("Memory request failed");
    return reply.code(statusCode).send({
      statusCode,
      error: STATUS_CODES[statusCode],
      message:
        error instanceof MemoryError
          ? error.message
          : statusCode < 500
            ? "Invalid request"
            : "Unable to process memory request",
    });
  });
  const service = memoryService(app.db);

  app.get("/agents/:id/memory", { schema: { params: idParams } }, async (request) => {
    const ownerId = request.userId as string;
    const [documents, status] = await Promise.all([
      service.list(ownerId, request.params.id),
      service.status(ownerId, request.params.id),
    ]);
    return { documents, ...status };
  });

  app.post(
    "/agents/:id/memory/refresh",
    { schema: { params: idParams, body: z.strictObject({}).nullish() } },
    async (request, reply) => {
      const credentials = readRuntimeKey(request);
      if (!credentials)
        throw new MemoryError(400, "Provide one runtime key in X-OpenSquad-Runtime-Key");
      const result = await app.memoryUpdates.refresh(
        request.userId as string,
        request.params.id,
        credentials,
      );
      return reply.code(result.started ? 202 : 200).send({ update: result.update });
    },
  );

  app.patch(
    "/memory/settings",
    { schema: { body: z.strictObject({ autoUpdate: z.boolean() }) } },
    async (request) => ({
      autoUpdate: await service.setAutoUpdate(request.userId as string, request.body.autoUpdate),
    }),
  );

  app.patch(
    "/agents/:id/memory/:name",
    { schema: { params: documentParams, body: saveBody } },
    async (request) => ({
      document: await service.save(
        request.userId as string,
        request.params.id,
        request.params.name,
        request.body.content,
        request.body.expectedVersion,
      ),
    }),
  );

  app.get(
    "/agents/:id/memory/:name/revisions",
    { schema: { params: documentParams, querystring: revisionQuery } },
    async (request) =>
      service.revisions(
        request.userId as string,
        request.params.id,
        request.params.name,
        request.query.limit,
        request.query.cursor === undefined ? undefined : Number(request.query.cursor),
      ),
  );

  app.post(
    "/agents/:id/memory/:name/revert",
    { schema: { params: documentParams, body: revertBody } },
    async (request) => ({
      document: await service.revert(
        request.userId as string,
        request.params.id,
        request.params.name,
        request.body.version,
        request.body.expectedVersion,
      ),
    }),
  );

  app.delete("/memory", async (request, reply) => {
    await service.forget(request.userId as string);
    return reply.code(204).send();
  });
};

export default routes;

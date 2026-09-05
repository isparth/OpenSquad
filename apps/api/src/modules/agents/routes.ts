import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { agentsService } from "./service.js";

const idParams = z.object({ id: z.uuid() });

const agentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  label: z.string().nullable(),
  description: z.string(),
  avatarUrl: z.string().nullable(),
  instructions: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  label: z.string().max(50).optional(),
  description: z.string().max(2000).default(""),
  instructions: z.string().max(20000).default(""),
});

const routes: FastifyPluginAsyncZod = async (app) => {
  const service = agentsService(app.db);
  app.addHook("preHandler", app.requireAuth);

  app.get("/", { schema: { response: { 200: z.array(agentSchema) } } }, async (request) => {
    return service.list(request.userId as string);
  });

  app.post(
    "/",
    { schema: { body: createAgentSchema, response: { 201: agentSchema } } },
    async (request, reply) => {
      const row = await service.create({ ...request.body, ownerId: request.userId as string });
      return reply.code(201).send(row);
    },
  );

  app.get(
    "/:id",
    { schema: { params: idParams, response: { 200: agentSchema } } },
    async (request, reply) => {
      const row = await service.get(request.userId as string, request.params.id);
      return row ?? reply.notFound();
    },
  );

  app.delete("/:id", { schema: { params: idParams } }, async (request, reply) => {
    const deleted = await service.delete(request.userId as string, request.params.id);
    return deleted ? reply.code(204).send() : reply.notFound();
  });
};

export default routes;

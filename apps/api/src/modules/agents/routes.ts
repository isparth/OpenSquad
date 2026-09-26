import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { removeAvatar } from "./avatar.js";
import avatarRoutes from "./avatar-routes.js";
import { agentsService } from "./service.js";

const idParams = z.object({ id: z.uuid() });

const toolGrantSchema = z.strictObject({
  toolkit: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  access: z.enum(["read", "write"]),
});
const toolGrantsSchema = z
  .array(toolGrantSchema)
  .max(20)
  .refine(
    (grants) => new Set(grants.map((grant) => grant.toolkit)).size === grants.length,
    "Each app can be granted once",
  );

const agentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  label: z.string().nullable(),
  description: z.string(),
  avatarUrl: z.string().nullable(),
  instructions: z.string(),
  sandboxEnabled: z.boolean(),
  toolGrants: z.array(z.object({ toolkit: z.string(), access: z.enum(["read", "write"]) })),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const editableFields = {
  name: z.string().trim().min(1).max(100),
  label: z
    .string()
    .trim()
    .max(50)
    .nullable()
    .transform((value) => value || null),
  description: z.string().max(2000),
  instructions: z.string().max(20000),
  sandboxEnabled: z.boolean(),
  toolGrants: toolGrantsSchema,
};
const createAgentSchema = z.object({
  ...editableFields,
  label: editableFields.label.optional(),
  description: editableFields.description.default(""),
  instructions: editableFields.instructions.default(""),
  sandboxEnabled: editableFields.sandboxEnabled.default(false),
  toolGrants: editableFields.toolGrants.default([]),
});
const updateAgentSchema = z
  .strictObject(editableFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field to update");

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

  app.patch(
    "/:id",
    { schema: { params: idParams, body: updateAgentSchema, response: { 200: agentSchema } } },
    async (request, reply) => {
      const row = await service.update(request.userId as string, request.params.id, request.body);
      return row ?? reply.notFound();
    },
  );

  app.delete("/:id", { schema: { params: idParams } }, async (request, reply) => {
    const deleted = await service.delete(request.userId as string, request.params.id);
    if (!deleted) return reply.notFound();
    await removeAvatar(app.capabilities.storage, deleted.id, deleted.avatarUrl, () =>
      request.log.warn({ agentId: deleted.id }, "Avatar storage cleanup failed"),
    );
    return reply.code(204).send();
  });

  await app.register(avatarRoutes);
};

export default routes;

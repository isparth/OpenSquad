import { randomUUID } from "node:crypto";
import multipart from "@fastify/multipart";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  avatarFilePattern,
  avatarKey,
  avatarMaxBytes,
  avatarPath,
  removeAvatar,
  validateAvatar,
} from "./avatar.js";
import { agentsService } from "./service.js";

const routes: FastifyPluginAsyncZod = async (app) => {
  await app.register(multipart, {
    limits: {
      files: 1,
      fields: 0,
      parts: 1,
      fileSize: avatarMaxBytes,
      headerPairs: 20,
      fieldNameSize: 100,
    },
  });
  const service = agentsService(app.db);
  const cleanup = (id: string, url: string | null) =>
    removeAvatar(app.capabilities.storage, id, url, () =>
      app.log.warn({ agentId: id }, "Avatar storage cleanup failed"),
    );

  app.post(
    "/:id/avatar",
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        response: { 200: z.object({ avatarUrl: z.string() }) },
      },
    },
    async (request, reply) => {
      const agent = await service.get(request.userId as string, request.params.id);
      if (!agent) return reply.notFound();
      if (!request.isMultipart())
        return reply.badRequest("Upload one avatar file as multipart/form-data");
      let data: Buffer | undefined;
      let format: string | undefined;
      try {
        for await (const part of request.parts()) {
          if (part.type !== "file" || part.fieldname !== "avatar")
            throw new Error("Invalid file field");
          data = await part.toBuffer();
          format = await validateAvatar(data, part.mimetype);
        }
        if (!data || !format) throw new Error("Missing avatar");
      } catch {
        return reply.badRequest(
          "Use one valid, single-frame PNG, JPEG or WebP image up to 2 MiB and 4 million pixels",
        );
      }
      const url = avatarPath(agent.id, `${randomUUID()}.${format}`);
      const key = avatarKey(agent.id, url);
      if (!key) throw new Error("Invalid generated avatar key");
      try {
        await app.capabilities.storage.put(key, data, `image/${format}`);
        const result = await service.setAvatar(request.userId as string, agent.id, url);
        if (!result) {
          await cleanup(agent.id, url);
          return reply.notFound();
        }
        await cleanup(agent.id, result.previousUrl);
        return { avatarUrl: url };
      } catch {
        request.log.error(
          { agentId: agent.id },
          "Avatar save failed; storage reconciliation may be required",
        );
        return reply.internalServerError("Unable to save avatar");
      }
    },
  );

  app.get(
    "/:id/avatar/:file",
    {
      schema: { params: z.object({ id: z.uuid(), file: z.string().regex(avatarFilePattern) }) },
    },
    async (request, reply) => {
      reply
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff");
      const agent = await service.get(request.userId as string, request.params.id);
      if (!agent || agent.avatarUrl !== avatarPath(agent.id, request.params.file))
        return reply.notFound();
      const key = avatarKey(agent.id, agent.avatarUrl);
      if (!key) return reply.notFound();
      try {
        const data = await app.capabilities.storage.get(key);
        if (!data) return reply.notFound();
        return reply.type(`image/${request.params.file.split(".").at(-1)}`).send(Buffer.from(data));
      } catch {
        request.log.error({ agentId: agent.id }, "Avatar read failed");
        return reply.internalServerError("Unable to load avatar");
      }
    },
  );
};

export default routes;

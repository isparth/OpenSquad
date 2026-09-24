import { STATUS_CODES } from "node:http";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { readRuntimeKey } from "../../auth/runtime-key.js";
import { runAdmission } from "./admission.js";
import { runCoordinator } from "./coordinator.js";
import { ConversationError, runDto } from "./dto.js";
import { eventStreams } from "./event-stream.js";
import type { FileCollectionOptions } from "./file-collection.js";
import { chargeRequest } from "./limits.js";
import { runtimeStore } from "./run-store.js";
import { conversationsService } from "./service.js";
import type { UsageBackfillOptions } from "./turn-usage.js";

const idParams = z.object({ id: z.uuid() });
const limit = z.coerce.number().int().min(1).max(100).default(50);
const sequence = z
  .string()
  .refine((value) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n);
const cursor = z
  .string()
  .max(100)
  .refine((value) => {
    const decoded = Buffer.from(value, "base64url").toString();
    return (
      z.uuid().safeParse(decoded).success && Buffer.from(decoded).toString("base64url") === value
    );
  })
  .transform((value) => Buffer.from(value, "base64url").toString());
function decodeFileCursor(value: string): { createdAt: Date; id: string } | null {
  if (Buffer.from(value, "base64url").toString("base64url") !== value) return null;
  const decoded = Buffer.from(value, "base64url").toString();
  const [timestamp, id, ...rest] = decoded.split("|");
  if (!timestamp || !id || rest.length > 0 || !z.uuid().safeParse(id).success) return null;
  const createdAt = new Date(timestamp);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== timestamp) return null;
  return { createdAt, id };
}
const fileCursor = z
  .string()
  .max(200)
  .refine((value) => decodeFileCursor(value) !== null)
  .transform((value) => decodeFileCursor(value) as { createdAt: Date; id: string });
const fileListQuery = z.strictObject({ limit, cursor: fileCursor.optional() });
const createBody = z.strictObject({
  title: z.string().trim().max(200).optional(),
  participants: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("user"), refId: z.string().min(1).max(256) }),
        z.strictObject({ kind: z.literal("agent"), refId: z.uuid() }),
      ]),
    )
    .length(2),
});

function credentials(request: FastifyRequest) {
  const value = readRuntimeKey(request);
  if (!value)
    throw new ConversationError(400, "Provide one runtime key in X-OpenSquad-Runtime-Key");
  return value;
}

function fileContentDisposition(name: string): string {
  const basename = name.split("/").at(-1) || "download";
  const fallback = basename.replace(/[^\x20-\x7e]/g, "_").replace(/[\\"]/g, "_") || "download";
  const encoded = encodeURIComponent(basename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

type ConversationRoutesOptions = {
  usageBackfill: UsageBackfillOptions;
  fileCollection?: FileCollectionOptions;
};

const routes: FastifyPluginAsyncZod<ConversationRoutesOptions> = async (app, options) => {
  app.addHook("preHandler", app.requireAuth);
  app.addHook("preHandler", async (request) => {
    await chargeRequest(
      app.db,
      request.userId as string,
      app.env.NODE_ENV === "test" ? 10_000 : 120,
    );
  });
  const coordinator = runCoordinator(
    app.db,
    app.capabilities.runtime,
    app.capabilities.storage,
    () => app.log.error("Runtime worker stopped; reconciliation may be required"),
    options.usageBackfill,
    options.fileCollection,
  );
  const store = runtimeStore(app.db);
  const admit = runAdmission(app.db, {
    provider: app.capabilities.runtime.name,
    model: app.env.RUNTIME_MODEL,
    features: app.capabilities.runtime.features,
  });
  const streams = eventStreams(app.db);
  app.addHook("preClose", async () => {
    await streams.close();
    await coordinator.close();
  });
  app.setErrorHandler((error, request, reply) => {
    const suppliedStatus =
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const statusCode =
      error instanceof ConversationError
        ? error.statusCode
        : suppliedStatus >= 400 && suppliedStatus < 500
          ? suppliedStatus
          : 500;
    if (statusCode === 500) request.log.error("Conversation request failed");
    return reply.code(statusCode).send({
      statusCode,
      error: STATUS_CODES[statusCode],
      message:
        error instanceof ConversationError
          ? error.message
          : statusCode < 500
            ? "Invalid request"
            : "Unable to process conversation request",
    });
  });
  const service = conversationsService(app.db);
  app.get("/conversations/:id/events", { schema: { params: idParams } }, async (request, reply) => {
    const last = request.headers["last-event-id"];
    if (last !== undefined && !sequence.safeParse(last).success)
      throw new ConversationError(400, "Invalid event cursor");
    const after = typeof last === "string" ? BigInt(last) : undefined;
    const initial = await service.snapshot(request.userId as string, request.params.id);
    if (after !== undefined && after > BigInt(initial.sequence))
      throw new ConversationError(400, "Event cursor is ahead of this conversation");
    const source = streams.open(request.userId as string, request.params.id, initial, after);
    const socket = reply.raw.socket;
    const close = () => source.destroy();
    reply.raw.once("close", close);
    source.once("close", () => {
      reply.raw.removeListener("close", close);
      reply.raw.destroy();
      socket?.destroy();
    });
    return reply
      .type("text/event-stream; charset=utf-8")
      .header("Cache-Control", "private, no-cache, no-transform")
      .header("X-Accel-Buffering", "no")
      .send(source);
  });
  app.post(
    "/conversations/:id/messages",
    {
      bodyLimit: 128 * 1024,
      schema: {
        params: idParams,
        body: z.strictObject({
          text: z
            .string()
            .min(1)
            .max(20000)
            .refine((value) => value.trim().length > 0),
          clientRequestId: z.uuid(),
        }),
      },
    },
    async (request, reply) => {
      const key = credentials(request);
      const ownerId = request.userId as string;
      const result = await admit(ownerId, request.params.id, request.body);
      if (result.fresh) {
        await coordinator.start(ownerId, result.run.id, key, "execute");
        if (result.sessionCreated && result.agentId)
          app.memoryUpdates.schedule(ownerId, result.agentId, request.params.id, key);
      }
      return reply.code(202).send({ message: result.message, run: result.run });
    },
  );
  app.get("/runs/:id", { schema: { params: idParams } }, async (request) => ({
    run: runDto((await store.get(request.userId as string, request.params.id)).run),
  }));
  app.post(
    "/runs/:id/cancel",
    { schema: { params: idParams, body: z.strictObject({}).nullish() } },
    async (request, reply) => {
      const key = credentials(request);
      const run = await store.cancel(request.userId as string, request.params.id);
      if (run.active) await coordinator.start(request.userId as string, run.id, key, "recover");
      return reply.code(run.active ? 202 : 200).send({ run: runDto(run) });
    },
  );
  app.post(
    "/runs/:id/reconcile",
    { schema: { params: idParams, body: z.strictObject({}).nullish() } },
    async (request, reply) => {
      const key = credentials(request);
      const { run } = await store.get(request.userId as string, request.params.id);
      if (run.active) await coordinator.start(request.userId as string, run.id, key, "recover");
      return reply.code(202).send({ run: runDto(run) });
    },
  );
  app.post(
    "/conversations",
    { bodyLimit: 64 * 1024, schema: { body: createBody } },
    async (request, reply) => {
      const users = request.body.participants.filter((member) => member.kind === "user");
      const bots = request.body.participants.filter((member) => member.kind === "agent");
      if (users.length !== 1 || bots.length !== 1 || users[0]?.refId !== request.userId || !bots[0])
        throw new ConversationError(400, "A conversation requires you and one owned bot");
      const result = await service.create(
        request.userId as string,
        bots[0].refId,
        request.body.title || null,
      );
      return reply.code(201).send(result);
    },
  );
  app.get(
    "/conversations",
    {
      schema: {
        querystring: z.strictObject({
          limit,
          cursor: cursor.optional(),
          agentId: z.uuid().optional(),
        }),
      },
    },
    (request) =>
      service.list(
        request.userId as string,
        request.query.limit,
        request.query.cursor,
        request.query.agentId,
      ),
  );
  app.get("/conversations/:id", { schema: { params: idParams } }, async (request) => {
    const { snapshot } = await service.snapshot(request.userId as string, request.params.id);
    return {
      conversation: snapshot.conversation,
      participants: snapshot.participants,
      activeRun: snapshot.activeRun,
    };
  });
  app.get(
    "/conversations/:id/messages",
    {
      schema: {
        params: idParams,
        querystring: z.strictObject({ limit, cursor: sequence.optional() }),
      },
    },
    (request) =>
      service.messages(
        request.userId as string,
        request.params.id,
        request.query.limit,
        request.query.cursor === undefined ? undefined : BigInt(request.query.cursor),
      ),
  );
  app.get(
    "/conversations/:id/files",
    { schema: { params: idParams, querystring: fileListQuery } },
    (request) =>
      service.files(
        request.userId as string,
        request.params.id,
        request.query.limit,
        request.query.cursor,
      ),
  );
  app.get(
    "/conversations/:id/files/:fileId/content",
    { schema: { params: z.object({ id: z.uuid(), fileId: z.uuid() }) } },
    async (request, reply) => {
      const file = await service.file(
        request.userId as string,
        request.params.id,
        request.params.fileId,
      );
      if (!file?.storageKey) return reply.notFound();
      try {
        const bytes = await app.capabilities.storage.get(file.storageKey);
        if (!bytes) return reply.notFound();
        return reply
          .type("application/octet-stream")
          .header("Content-Disposition", fileContentDisposition(file.name))
          .header("X-Content-Type-Options", "nosniff")
          .header("Cache-Control", "private, no-store")
          .send(Buffer.from(bytes));
      } catch {
        request.log.error(
          { conversationId: file.conversationId, fileId: file.id },
          "Conversation file read failed",
        );
        return reply.internalServerError("Unable to download file");
      }
    },
  );
};

export default routes;

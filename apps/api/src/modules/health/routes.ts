import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get("/", async () => "Hello world");

  app.get(
    "/health",
    {
      schema: {
        response: {
          200: z.object({ ok: z.literal(true), db: z.literal("up") }),
          503: z.object({ ok: z.literal(false), db: z.literal("down") }),
        },
      },
    },
    async (_request, reply) => {
      try {
        await app.db.execute(sql`select 1`);
        return { ok: true as const, db: "up" as const };
      } catch (error) {
        app.log.error(error);
        return reply.code(503).send({ ok: false as const, db: "down" as const });
      }
    },
  );
};

export default routes;

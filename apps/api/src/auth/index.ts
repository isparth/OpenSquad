import { clerkPlugin, getAuth } from "@clerk/fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

/**
 * The only file that knows Clerk exists. Everything else reads `request.userId`.
 * With no CLERK_SECRET_KEY set (local dev), every request is treated as `dev-user`.
 */

declare module "fastify" {
  interface FastifyRequest {
    userId: string | null;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const DEV_USER_ID = "dev-user";

export default fp(
  async (app) => {
    const { CLERK_SECRET_KEY: secretKey, CLERK_PUBLISHABLE_KEY: publishableKey } = app.env;
    app.decorateRequest("userId", null);

    if (secretKey && publishableKey) {
      await app.register(clerkPlugin, { secretKey, publishableKey });
      app.addHook("preHandler", async (request) => {
        request.userId = getAuth(request).userId ?? null;
      });
    } else {
      app.log.warn("auth disabled: CLERK_* not set, all requests run as %s", DEV_USER_ID);
      app.addHook("preHandler", async (request) => {
        request.userId = DEV_USER_ID;
      });
    }

    app.decorate("requireAuth", async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.userId) return reply.unauthorized();
    });
  },
  { name: "auth", dependencies: ["env"] },
);

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", app.requireAuth);
  app.get("/me", async (request) => ({ userId: request.userId }));
};

export default routes;

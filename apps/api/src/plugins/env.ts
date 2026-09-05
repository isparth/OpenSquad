import fp from "fastify-plugin";
import type { Env } from "../config/env.js";

declare module "fastify" {
  interface FastifyInstance {
    env: Env;
  }
}

export default fp(
  async (app, options: { env: Env }) => {
    app.decorate("env", options.env);
  },
  { name: "env" },
);

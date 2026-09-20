import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import type { Capabilities } from "@opensquad/core";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import auth from "./auth/index.js";
import type { Env } from "./config/env.js";
import agentsRoutes from "./modules/agents/routes.js";
import healthRoutes from "./modules/health/routes.js";
import capabilities from "./plugins/capabilities.js";
import db from "./plugins/db.js";
import envPlugin from "./plugins/env.js";

export interface BuildAppOptions {
  capabilities?: Partial<Capabilities>;
}

export async function buildApp(env: Env, options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : { level: env.LOG_LEVEL },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(envPlugin, { env });
  await app.register(sensible);
  await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"] });
  await app.register(db);
  await app.register(capabilities, { overrides: options.capabilities ?? {} });
  await app.register(auth);

  await app.register(healthRoutes);
  await app.register(agentsRoutes, { prefix: "/agents" });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

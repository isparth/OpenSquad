import fp from "fastify-plugin";
import { memoryUpdater } from "../modules/memory/updates.js";

declare module "fastify" {
  interface FastifyInstance {
    memoryUpdates: ReturnType<typeof memoryUpdater>;
  }
}

export default fp(
  async (
    app,
    options: { autoTrigger?: boolean; turnDeadlineMs?: number; pollIntervalMs?: number },
  ) => {
    const updater = memoryUpdater(app.db, app.capabilities.runtime, {
      model: app.env.RUNTIME_MODEL,
      log: app.log,
      autoTrigger: options.autoTrigger ?? true,
      turnDeadlineMs: options.turnDeadlineMs ?? 120_000,
      pollIntervalMs: options.pollIntervalMs ?? 1_000,
    });
    app.decorate("memoryUpdates", updater);
    app.addHook("preClose", updater.close);
  },
  { name: "memory-updates", dependencies: ["db", "capabilities", "env"] },
);

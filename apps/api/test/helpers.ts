import { type App, type BuildAppOptions, buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";

export async function createTestApp(options: BuildAppOptions = {}): Promise<App> {
  const app = await buildApp(loadEnv(), {
    ...options,
    memoryUpdates: { autoTrigger: false, ...options.memoryUpdates },
    usageBackfill: { attempts: 0, ...options.usageBackfill },
  });
  await app.ready();
  return app;
}

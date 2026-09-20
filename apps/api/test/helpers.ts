import { type App, type BuildAppOptions, buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";

export async function createTestApp(options: BuildAppOptions = {}): Promise<App> {
  const app = await buildApp(loadEnv(), options);
  await app.ready();
  return app;
}

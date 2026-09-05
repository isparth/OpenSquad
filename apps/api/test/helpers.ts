import { type App, buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";

export async function createTestApp(): Promise<App> {
  const app = await buildApp(loadEnv());
  await app.ready();
  return app;
}

import type { Capabilities } from "@opensquad/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, buildApp } from "../src/app.js";
import { buildCapabilities } from "../src/capabilities/registry.js";
import { loadEnv } from "../src/config/env.js";
import { testDatabaseUrl } from "./database-url.js";
import { FakeRuntimeProvider } from "./fakes.js";
import { createTestApp } from "./helpers.js";

const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: testDatabaseUrl,
});
const apps: App[] = [];

async function track(pending: Promise<App>): Promise<App> {
  const app = await pending;
  apps.push(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider request"));
});

afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

describe("application capability overrides", () => {
  it("keeps the existing defaults with omitted or empty options", async () => {
    const defaults = buildCapabilities(env);
    const factories = [
      () => buildApp(env),
      () => buildApp(env, {}),
      () => buildApp(env, { capabilities: {} }),
    ];
    for (const create of factories) {
      const app = await track(create());
      for (const key of Object.keys(defaults) as Array<keyof Capabilities>) {
        expect(app.capabilities[key].name).toBe(defaults[key].name);
      }
      expect(app.capabilities).not.toHaveProperty("model");
      expect(app.capabilities).not.toHaveProperty("sandbox");
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    }
  });

  it("injects the exact runtime instance while preserving independent capability defaults", async () => {
    const runtime = new FakeRuntimeProvider();
    const overrides = Object.freeze({ runtime });
    const app = await track(buildApp(env, { capabilities: overrides }));
    expect(app.capabilities.runtime).toBe(runtime);
    expect(app.capabilities).toMatchObject({
      memory: { name: "mem0" },
      email: { name: "agentmail" },
      phone: { name: "vapi" },
      tools: { name: "composio" },
      scheduler: { name: "trigger" },
      storage: { name: "local" },
    });
    expect(Object.keys(overrides)).toEqual(["runtime"]);
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("supports every capability without replacing the caller's objects", async () => {
    const supplied = Object.freeze({
      ...buildCapabilities(env),
      runtime: new FakeRuntimeProvider(),
    });
    const app = await track(buildApp(env, { capabilities: supplied }));
    expect(app.capabilities).not.toBe(supplied);
    for (const key of Object.keys(supplied) as Array<keyof Capabilities>) {
      expect(app.capabilities[key]).toBe(supplied[key]);
    }
  });

  it("does not let undefined entries erase registry defaults", async () => {
    const overrides: Partial<Capabilities> = {};
    Object.defineProperty(overrides, "runtime", { value: undefined, enumerable: true });
    const app = await track(buildApp(env, { capabilities: overrides }));
    expect(app.capabilities.runtime.name).toBe("openai-agents");
    expect(overrides.runtime).toBeUndefined();
  });

  it("isolates concurrent app instances and snapshots the override map", async () => {
    const firstRuntime = new FakeRuntimeProvider();
    const secondRuntime = new FakeRuntimeProvider();
    const overrides = { runtime: firstRuntime };
    const [first, second, defaultApp] = await Promise.all([
      track(buildApp(env, { capabilities: overrides })),
      track(buildApp(env, { capabilities: { runtime: secondRuntime } })),
      track(buildApp(env)),
    ]);
    overrides.runtime = secondRuntime;
    expect(first.capabilities.runtime).toBe(firstRuntime);
    expect(second.capabilities.runtime).toBe(secondRuntime);
    expect(defaultApp.capabilities.runtime.name).toBe("openai-agents");
    expect(first.capabilities.memory).not.toBe(second.capabilities.memory);
    expect(first.capabilities.storage).not.toBe(second.capabilities.storage);
    await first.close();
    expect(firstRuntime.cancel).not.toHaveBeenCalled();
    expect(firstRuntime.destroySession).not.toHaveBeenCalled();
    expect(secondRuntime.cancel).not.toHaveBeenCalled();
    expect(secondRuntime.destroySession).not.toHaveBeenCalled();
    expect((await second.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("forwards overrides through createTestApp and uses scripted runtime results", async () => {
    const runtime = new FakeRuntimeProvider();
    const app = await track(createTestApp({ capabilities: { runtime } }));
    const credentials = { apiKey: "dummy-test-key" };
    const session = {
      provider: runtime.name,
      externalId: "session-test",
      model: "test-model",
      status: "idle" as const,
      environmentExternalId: null,
    };
    runtime.createSession.mockResolvedValueOnce(session);
    expect(
      await app.capabilities.runtime.createSession({ instructions: "Test" }, credentials),
    ).toBe(session);
    expect(runtime.createSession).toHaveBeenCalledWith({ instructions: "Test" }, credentials);
  });
});

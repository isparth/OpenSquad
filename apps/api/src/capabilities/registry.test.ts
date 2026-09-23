import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildCapabilities } from "./registry.js";

const database = { DATABASE_URL: "postgres://opensquad:opensquad@localhost:5432/opensquad" };

describe("default runtime", () => {
  it("selects OpenAI Agents without requiring a key to boot or wiring model/sandbox stubs", () => {
    const capabilities = buildCapabilities(loadEnv(database));
    expect(capabilities.runtime.name).toBe("openai-agents");
    expect(capabilities.runtime.features.hostedEnvironment).toBe(true);
    expect(capabilities.runtime.features.environmentless).toBe(true);
    expect(capabilities).not.toHaveProperty("model");
    expect(capabilities).not.toHaveProperty("sandbox");
    expect(capabilities.memory.name).toBe("mem0");
    expect(capabilities.email.name).toBe("agentmail");
    expect(capabilities.phone.name).toBe("vapi");
    expect(capabilities.tools.name).toBe("composio");
    expect(capabilities.scheduler.name).toBe("trigger");
  });

  it("validates the model setting and keeps OpenAI credentials optional", () => {
    expect(loadEnv(database)).toMatchObject({ RUNTIME_MODEL: "gpt-6-luna" });
    expect(loadEnv({ ...database, OPENAI_API_KEY: "" }).OPENAI_API_KEY).toBeUndefined();
    expect(loadEnv({ ...database, RUNTIME_MODEL: "custom-model" }).RUNTIME_MODEL).toBe(
      "custom-model",
    );
    expect(() => loadEnv({ ...database, RUNTIME_MODEL: " " })).toThrow("RUNTIME_MODEL");
  });
});

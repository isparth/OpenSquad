import type { AgentRuntimeProvider, ToolsProvider } from "@opensquad/core";
import { vi } from "vitest";

function unconfigured(method: keyof AgentRuntimeProvider): never {
  throw new Error(`Configure FakeRuntimeProvider.${method} in this test`);
}

export class FakeRuntimeProvider implements AgentRuntimeProvider {
  readonly name = "fake-runtime";
  readonly features = {
    hostedEnvironment: true,
    environmentless: true,
    structuredOutput: true,
    mcp: false,
    subagents: false,
    steering: false,
    artifacts: false,
  };

  readonly createSession = vi.fn<AgentRuntimeProvider["createSession"]>(async () =>
    unconfigured("createSession"),
  );
  readonly retrieveSession = vi.fn<AgentRuntimeProvider["retrieveSession"]>(async () =>
    unconfigured("retrieveSession"),
  );
  readonly sendInput = vi.fn<AgentRuntimeProvider["sendInput"]>(async () =>
    unconfigured("sendInput"),
  );
  readonly events = vi.fn<AgentRuntimeProvider["events"]>(async () => unconfigured("events"));
  readonly listMessages = vi.fn<AgentRuntimeProvider["listMessages"]>(async function* () {
    yield unconfigured("listMessages");
  });
  readonly listTurns = vi.fn<AgentRuntimeProvider["listTurns"]>(async function* () {
    yield unconfigured("listTurns");
  });
  readonly listArtifacts = vi.fn<AgentRuntimeProvider["listArtifacts"]>(async function* () {
    yield unconfigured("listArtifacts");
  });
  readonly readArtifact = vi.fn<AgentRuntimeProvider["readArtifact"]>(async () =>
    unconfigured("readArtifact"),
  );
  readonly cancel = vi.fn<AgentRuntimeProvider["cancel"]>(async () => unconfigured("cancel"));
  readonly destroySession = vi.fn<AgentRuntimeProvider["destroySession"]>(async () =>
    unconfigured("destroySession"),
  );
}

function unconfiguredTools(method: keyof ToolsProvider): never {
  throw new Error(`Configure FakeToolsProvider.${method} in this test`);
}

export class FakeToolsProvider implements ToolsProvider {
  readonly name = "fake-tools";
  readonly listToolkits = vi.fn<ToolsProvider["listToolkits"]>(async () =>
    unconfiguredTools("listToolkits"),
  );
  readonly listConnections = vi.fn<ToolsProvider["listConnections"]>(async () =>
    unconfiguredTools("listConnections"),
  );
  readonly startConnection = vi.fn<ToolsProvider["startConnection"]>(async () =>
    unconfiguredTools("startConnection"),
  );
  readonly removeConnection = vi.fn<ToolsProvider["removeConnection"]>(async () =>
    unconfiguredTools("removeConnection"),
  );
  readonly createSession = vi.fn<ToolsProvider["createSession"]>(async () =>
    unconfiguredTools("createSession"),
  );
}

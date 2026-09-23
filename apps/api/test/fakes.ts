import type { AgentRuntimeProvider } from "@opensquad/core";
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
  readonly cancel = vi.fn<AgentRuntimeProvider["cancel"]>(async () => unconfigured("cancel"));
  readonly destroySession = vi.fn<AgentRuntimeProvider["destroySession"]>(async () =>
    unconfigured("destroySession"),
  );
}

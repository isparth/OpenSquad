import type {
  RuntimeCredentials,
  RuntimeSessionRef,
  RuntimeTurn,
  RuntimeUsage,
} from "@opensquad/core";
import { describe, expect, it } from "vitest";
import { awaitTurnUsage } from "../src/modules/conversations/turn-usage.js";
import { FakeRuntimeProvider } from "./fakes.js";

const session: RuntimeSessionRef = { provider: "fake-runtime", externalId: "session-1" };
const credentials: RuntimeCredentials = { apiKey: "dummy-key" };
const usage: RuntimeUsage = { inputTokens: 10, outputTokens: 2 };

function turn(
  externalId: string,
  turnUsage: RuntimeUsage | null,
  subagentExternalId: string | null = null,
): RuntimeTurn {
  return {
    externalId,
    subagentExternalId,
    status: "succeeded",
    usage: turnUsage,
    error: null,
  };
}

describe("awaitTurnUsage", () => {
  it("returns usage when it appears on the third saved-turn read", async () => {
    const runtime = new FakeRuntimeProvider();
    let calls = 0;
    runtime.listTurns.mockImplementation(async function* () {
      calls++;
      yield turn("root-1", calls === 3 ? usage : null);
    });

    await expect(
      awaitTurnUsage(runtime, session, "root-1", credentials, { attempts: 5, intervalMs: 1 }),
    ).resolves.toEqual(usage);
    expect(runtime.listTurns).toHaveBeenCalledTimes(3);
  });

  it("returns null after the configured number of reads when usage never appears", async () => {
    const runtime = new FakeRuntimeProvider();
    runtime.listTurns.mockImplementation(async function* () {
      yield turn("root-1", null);
    });

    await expect(
      awaitTurnUsage(runtime, session, "root-1", credentials, { attempts: 3, intervalMs: 1 }),
    ).resolves.toBeNull();
    expect(runtime.listTurns).toHaveBeenCalledTimes(3);
  });

  it("ignores other root turns and subagent turns", async () => {
    const runtime = new FakeRuntimeProvider();
    let calls = 0;
    runtime.listTurns.mockImplementation(async function* () {
      calls++;
      if (calls === 1) {
        yield turn("other-root", usage);
        yield turn("root-1", usage, "child-1");
        yield turn("root-1", null);
        return;
      }
      yield turn("root-1", usage);
    });

    await expect(
      awaitTurnUsage(runtime, session, "root-1", credentials, { attempts: 3, intervalMs: 1 }),
    ).resolves.toEqual(usage);
    expect(runtime.listTurns).toHaveBeenCalledTimes(2);
  });

  it("treats a throwing read as a miss and succeeds on the next read", async () => {
    const runtime = new FakeRuntimeProvider();
    let calls = 0;
    runtime.listTurns.mockImplementation(async function* () {
      calls++;
      if (calls === 1) throw new Error("temporary read failure");
      yield turn("root-1", usage);
    });

    await expect(
      awaitTurnUsage(runtime, session, "root-1", credentials, { attempts: 3, intervalMs: 1 }),
    ).resolves.toEqual(usage);
    expect(runtime.listTurns).toHaveBeenCalledTimes(2);
  });

  it("returns null promptly when the signal aborts an in-flight read", async () => {
    const runtime = new FakeRuntimeProvider();
    const controller = new AbortController();
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runtime.listTurns.mockImplementation(async function* (_session, _credentials, options) {
      markStarted();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield turn("root-1", null);
    });

    const result = awaitTurnUsage(runtime, session, "root-1", credentials, {
      attempts: 5,
      intervalMs: 1_000,
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(runtime.listTurns).toHaveBeenCalledTimes(1);
  });

  it("does not read turns when attempts is zero", async () => {
    const runtime = new FakeRuntimeProvider();

    await expect(
      awaitTurnUsage(runtime, session, "root-1", credentials, { attempts: 0, intervalMs: 1 }),
    ).resolves.toBeNull();
    expect(runtime.listTurns).not.toHaveBeenCalled();
  });
});

import { randomUUID } from "node:crypto";
import type { RuntimeEvent } from "@opensquad/core";
import {
  agents,
  conversationMessages,
  conversationRuns,
  conversations,
  runtimeSessions,
} from "@opensquad/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";
import { agentsService } from "../src/modules/agents/service.js";
import { runAdmission } from "../src/modules/conversations/admission.js";
import { runtimeStore } from "../src/modules/conversations/run-store.js";
import { runtimeEvents } from "../src/modules/conversations/runtime-events.js";
import { conversationsService } from "../src/modules/conversations/service.js";
import { createTestApp } from "./helpers.js";

describe("normalized runtime persistence", () => {
  let app: App;
  let owner: string;
  let agentId: string;
  let conversationId: string;
  let runId: string;
  let token: string;
  const runtimeFeatures = {
    hostedEnvironment: true,
    environmentless: true,
    mcp: false,
    subagents: false,
    steering: false,
  };
  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    owner = `test-${randomUUID()}`;
    agentId = (await agentsService(app.db).create({ ownerId: owner, name: "Runtime test" })).id;
    conversationId = (await conversationsService(app.db).create(owner, agentId, null)).conversation
      .id;
    runId = (
      await runAdmission(app.db, {
        provider: "fake-runtime",
        model: "test-model",
        features: runtimeFeatures,
      })(
        owner,
        conversationId,
        { text: "Hello", clientRequestId: randomUUID() },
      )
    ).run.id;
    token = (await runtimeStore(app.db).claim(owner, runId)) as string;
    const { run } = await runtimeStore(app.db).get(owner, runId);
    await app.db
      .update(runtimeSessions)
      .set({ externalId: `session-${runId}` })
      .where(eq(runtimeSessions.id, run.sessionId));
  });
  afterEach(async () => {
    await app.db.delete(conversations).where(eq(conversations.id, conversationId));
    await app.db.delete(agents).where(eq(agents.id, agentId));
  });
  afterAll(() => app.close());
  function event(data: Omit<RuntimeEvent, "externalId" | "sessionExternalId" | "turnExternalId">) {
    return {
      externalId: randomUUID(),
      sessionExternalId: `session-${runId}`,
      turnExternalId: "root-turn",
      ...data,
    } as RuntimeEvent;
  }
  function turn(
    status: "running" | "succeeded",
    subagentExternalId: string | null = null,
  ): RuntimeEvent {
    return event({
      type: "turn.status",
      turn: { externalId: "root-turn", subagentExternalId, status, usage: null, error: null },
    } as RuntimeEvent);
  }

  it("keeps subagent outcomes separate and replaces completed text without requiring deltas", async () => {
    const apply = (value: RuntimeEvent) => runtimeEvents(app.db).apply(owner, runId, token, value);
    await apply(turn("succeeded", "subagent"));
    expect((await runtimeStore(app.db).get(owner, runId)).run.status).toBe("pending");
    await apply(turn("running"));
    const completion = event({
      type: "message.text.completed",
      itemExternalId: "item-a",
      contentIndex: 2,
      text: "Complete text",
    } as RuntimeEvent);
    await apply(completion);
    await apply(completion);
    await apply(
      event({
        type: "message.text.completed",
        itemExternalId: "item-a",
        contentIndex: 2,
        text: "conflicting completion",
      } as RuntimeEvent),
    );
    await apply(
      event({
        type: "message.delta",
        itemExternalId: "item-a",
        contentIndex: 2,
        text: "late delta",
      } as RuntimeEvent),
    );
    const messages = await app.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.runId, runId));
    expect(messages.find((message) => message.role === "assistant")?.content).toEqual([
      { index: 2, type: "text", text: "Complete text", completed: true },
    ]);
    const events = await conversationsService(app.db).events(owner, conversationId, 0n);
    expect(events.filter((entry) => entry.type === "message.text.completed")).toHaveLength(1);
  });

  it("does not regress a terminal root outcome when replaying older buffered statuses", async () => {
    const processor = runtimeEvents(app.db);
    await processor.apply(owner, runId, token, turn("succeeded"));
    await processor.apply(owner, runId, token, turn("running"));
    expect((await runtimeStore(app.db).get(owner, runId)).run.status).toBe("succeeded");
  });

  it("marks expired observation recoverable but refuses takeover during an uncertain mutation", async () => {
    await app.db
      .update(conversationRuns)
      .set({ phase: "observing", observation: "connected", leaseExpiresAt: new Date(0) })
      .where(eq(conversationRuns.id, runId));
    expect((await runtimeStore(app.db).get(owner, runId)).run.observation).toBe(
      "reconciliation_required",
    );
    await app.db
      .update(conversationRuns)
      .set({ mutationInFlight: true })
      .where(eq(conversationRuns.id, runId));
    await expect(runtimeStore(app.db).claim(owner, runId)).rejects.toMatchObject({
      statusCode: 409,
    });
    await app.db
      .update(conversationRuns)
      .set({ mutationInFlight: false })
      .where(eq(conversationRuns.id, runId));
    const replacement = await runtimeStore(app.db).claim(owner, runId);
    expect(replacement).not.toBe(token);
    await expect(
      runtimeEvents(app.db).apply(owner, runId, token, turn("running")),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("bounds multibyte output by serialized bytes rather than character count", async () => {
    await runtimeEvents(app.db).apply(owner, runId, token, turn("running"));
    await expect(
      runtimeEvents(app.db).apply(
        owner,
        runId,
        token,
        event({
          type: "message.text.completed",
          itemExternalId: "oversized",
          contentIndex: 0,
          text: "界".repeat(400000),
        } as RuntimeEvent),
      ),
    ).rejects.toThrow("Output limit exceeded");
  });

  it("keeps admission blocked if recovery failed after reading a remote terminal outcome", async () => {
    await runtimeEvents(app.db).apply(owner, runId, token, turn("succeeded"));
    await runtimeStore(app.db).release(owner, runId, token, "stream_disconnected");
    const { run } = await runtimeStore(app.db).get(owner, runId);
    expect(run.active).toBe(true);
    expect(run.finishedAt).toBeNull();
  });

  it("rejects stale execution tokens and cross-session events", async () => {
    await expect(
      runtimeEvents(app.db).apply(owner, runId, randomUUID(), turn("running")),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      runtimeEvents(app.db).apply(owner, runId, token, {
        ...turn("running"),
        sessionExternalId: "other-session",
      }),
    ).rejects.toThrow("session mismatch");
  });
});

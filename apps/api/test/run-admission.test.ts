import { randomUUID } from "node:crypto";
import { agents, conversationMessages, conversationRuns, conversations } from "@opensquad/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";
import { agentsService } from "../src/modules/agents/service.js";
import { runAdmission } from "../src/modules/conversations/admission.js";
import { conversationsService } from "../src/modules/conversations/service.js";
import { createTestApp } from "./helpers.js";

describe("durable run admission", () => {
  let app: App;
  let owner: string;
  let agentId: string;
  let conversationId: string;
  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    owner = `test-${randomUUID()}`;
    agentId = (
      await agentsService(app.db).create({
        ownerId: owner,
        name: "Run test",
        instructions: "Be helpful",
      })
    ).id;
    conversationId = (await conversationsService(app.db).create(owner, agentId, null)).conversation
      .id;
  });
  afterEach(async () => {
    await app.db.delete(conversations).where(eq(conversations.id, conversationId));
    await app.db.delete(agents).where(eq(agents.id, agentId));
  });
  afterAll(() => app.close());
  const config = {
    provider: "fake-runtime",
    model: "test-model",
    features: {
      hostedEnvironment: true,
      environmentless: true,
      structuredOutput: true,
      mcp: false,
      subagents: false,
      steering: false,
    },
  };

  it("claims a single run and user message for concurrent retries of one intent", async () => {
    const admit = runAdmission(app.db, config);
    const input = { text: "Hello", clientRequestId: randomUUID() };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => admit(owner, conversationId, input)),
    );
    expect(results.filter((result) => result.fresh)).toHaveLength(1);
    expect(new Set(results.map((result) => result.run.id)).size).toBe(1);
    expect(
      await app.db
        .select()
        .from(conversationRuns)
        .where(eq(conversationRuns.conversationId, conversationId)),
    ).toHaveLength(1);
    expect(
      await app.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId)),
    ).toHaveLength(1);
    const events = await conversationsService(app.db).events(owner, conversationId, 0n);
    expect(events.map((event) => event.id)).toEqual(["1", "2"]);
    expect(events.map((event) => event.type)).toEqual(["message.created", "run.updated"]);
    expect(JSON.stringify(results[0])).not.toContain("sessionId");
    expect(JSON.stringify(results[0])).not.toContain("leaseToken");
  });

  it("rejects changed retry payloads and a second unresolved intent", async () => {
    const admit = runAdmission(app.db, config);
    const input = { text: "Hello", clientRequestId: randomUUID() };
    await admit(owner, conversationId, input);
    await expect(
      admit(owner, conversationId, { ...input, text: "Different" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      admit(owner, conversationId, { ...input, clientRequestId: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("checks ownership before revealing an idempotent result", async () => {
    const admit = runAdmission(app.db, config);
    const input = { text: "Private", clientRequestId: randomUUID() };
    await admit(owner, conversationId, input);
    await expect(admit("other-owner", conversationId, input)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      conversationsService(app.db).snapshot("other-owner", conversationId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

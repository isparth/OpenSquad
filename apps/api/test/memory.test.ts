import { randomUUID } from "node:crypto";
import { agents, conversations, memoryDocuments, memoryRevisions } from "@opensquad/db";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";
import { agentsService } from "../src/modules/agents/service.js";
import { memoryService } from "../src/modules/memory/service.js";
import { createTestApp } from "./helpers.js";

describe("memory documents", () => {
  let app: App;
  let agentA: string;
  let agentB: string;
  let foreignAgent: string;
  const agentIds: string[] = [];
  const conversationIds: string[] = [];

  async function createAgent(ownerId: string, name: string) {
    const agent = await agentsService(app.db).create({ ownerId, name });
    agentIds.push(agent.id);
    return agent.id;
  }

  async function save(agentId: string, name: string, content: string, expectedVersion: number) {
    return app.inject({
      method: "PATCH",
      url: `/agents/${agentId}/memory/${name}`,
      payload: { content, expectedVersion },
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    agentA = await createAgent("dev-user", "Memory bot A");
    agentB = await createAgent("dev-user", "Memory bot B");
    foreignAgent = await createAgent("other-owner", "Foreign memory bot");
  });

  afterEach(async () => {
    await app.db
      .delete(memoryDocuments)
      .where(inArray(memoryDocuments.ownerId, ["dev-user", "other-owner"]));
  });

  afterAll(async () => {
    if (conversationIds.length > 0)
      await app.db.delete(conversations).where(inArray(conversations.id, conversationIds));
    await app.db.delete(agents).where(inArray(agents.id, agentIds));
    await app.close();
  });

  it("returns the three empty documents in their declared order", async () => {
    const response = await app.inject({ method: "GET", url: `/agents/${agentA}/memory` });
    expect(response.statusCode).toBe(200);
    expect(response.json().documents).toEqual([
      {
        name: "profile",
        scope: "shared",
        content: "",
        version: 0,
        limit: 4000,
        updatedAt: null,
      },
      {
        name: "preferences",
        scope: "shared",
        content: "",
        version: 0,
        limit: 2000,
        updatedAt: null,
      },
      {
        name: "notes",
        scope: "agent",
        content: "",
        version: 0,
        limit: 4000,
        updatedAt: null,
      },
    ]);
  });

  it("validates bot ownership, IDs, and document names", async () => {
    expect(
      (await app.inject({ method: "GET", url: `/agents/${foreignAgent}/memory` })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `/agents/${randomUUID()}/memory` })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: "GET", url: "/agents/not-a-uuid/memory" })).statusCode).toBe(
      400,
    );
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/agents/${agentA}/memory/secrets`,
          payload: { content: "private", expectedVersion: 0 },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("increments versions and rejects stale writes without changing the document", async () => {
    const first = await save(agentA, "profile", "Name: Parth", 0);
    expect(first.statusCode).toBe(200);
    expect(first.json().document).toMatchObject({ version: 1, content: "Name: Parth" });
    const second = await save(agentA, "profile", "Name: Parth Sharma", 1);
    expect(second.statusCode).toBe(200);
    expect(second.json().document).toMatchObject({ version: 2, content: "Name: Parth Sharma" });
    const stale = await save(agentA, "profile", "stale", 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().message).toBe("Memory changed since it was loaded");
    const current = await app.inject({ method: "GET", url: `/agents/${agentA}/memory` });
    expect(current.json().documents[0]).toMatchObject({
      version: 2,
      content: "Name: Parth Sharma",
    });
  });

  it("shares profile across bots while keeping notes agent-scoped", async () => {
    expect((await save(agentA, "profile", "Shared profile", 0)).statusCode).toBe(200);
    expect((await save(agentA, "notes", "Only for A", 0)).statusCode).toBe(200);
    const forA = (await app.inject({ method: "GET", url: `/agents/${agentA}/memory` })).json()
      .documents;
    const forB = (await app.inject({ method: "GET", url: `/agents/${agentB}/memory` })).json()
      .documents;
    expect(forA[0]).toMatchObject({ content: "Shared profile", version: 1 });
    expect(forB[0]).toMatchObject({ content: "Shared profile", version: 1 });
    expect(forA[2]).toMatchObject({ content: "Only for A", version: 1 });
    expect(forB[2]).toMatchObject({ content: "", version: 0 });
  });

  it("enforces content limits, NUL rejection, and strict request bodies", async () => {
    expect((await save(agentA, "preferences", "p".repeat(2000), 0)).statusCode).toBe(200);
    expect((await save(agentA, "preferences", "p".repeat(2001), 1)).statusCode).toBe(400);
    expect((await save(agentA, "profile", "p".repeat(4001), 0)).statusCode).toBe(400);
    expect((await save(agentA, "profile", "bad\u0000value", 0)).statusCode).toBe(400);
    const extra = await app.inject({
      method: "PATCH",
      url: `/agents/${agentA}/memory/profile`,
      payload: { content: "valid", expectedVersion: 0, extra: true },
    });
    expect(extra.statusCode).toBe(400);
  });

  it("paginates revisions and reverts with optimistic version checks", async () => {
    expect((await save(agentA, "profile", "version one", 0)).statusCode).toBe(200);
    expect((await save(agentA, "profile", "version two", 1)).statusCode).toBe(200);
    expect((await save(agentA, "profile", "version three", 2)).statusCode).toBe(200);
    const firstPage = await app.inject({
      method: "GET",
      url: `/agents/${agentA}/memory/profile/revisions?limit=2`,
    });
    expect(firstPage.json()).toMatchObject({
      items: [
        { version: 3, author: "user", content: "version three" },
        { version: 2, author: "user", content: "version two" },
      ],
      nextCursor: "2",
    });
    const nextPage = await app.inject({
      method: "GET",
      url: `/agents/${agentA}/memory/profile/revisions?limit=2&cursor=2`,
    });
    expect(nextPage.json()).toMatchObject({
      items: [{ version: 1, author: "user", content: "version one" }],
      nextCursor: null,
    });
    const reverted = await app.inject({
      method: "POST",
      url: `/agents/${agentA}/memory/profile/revert`,
      payload: { version: 1, expectedVersion: 3 },
    });
    expect(reverted.statusCode).toBe(200);
    expect(reverted.json().document).toMatchObject({ version: 4, content: "version one" });
    const latest = await app.inject({
      method: "GET",
      url: `/agents/${agentA}/memory/profile/revisions?limit=1`,
    });
    expect(latest.json().items[0]).toMatchObject({ version: 4, author: "revert" });
    const stale = await app.inject({
      method: "POST",
      url: `/agents/${agentA}/memory/profile/revert`,
      payload: { version: 2, expectedVersion: 3 },
    });
    expect(stale.statusCode).toBe(409);
    const missing = await app.inject({
      method: "POST",
      url: `/agents/${agentA}/memory/profile/revert`,
      payload: { version: 99, expectedVersion: 4 },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toBe("Revision not found");
  });

  it("retains only the latest 50 revisions for each document", async () => {
    for (let version = 0; version < 52; version++) {
      const response = await save(agentA, "notes", `revision ${version + 1}`, version);
      expect(response.statusCode).toBe(200);
    }
    const [document] = await app.db
      .select()
      .from(memoryDocuments)
      .where(eq(memoryDocuments.agentId, agentA));
    if (!document) throw new Error("Expected a notes document");
    const revisions = await app.db
      .select({ version: memoryRevisions.version })
      .from(memoryRevisions)
      .where(eq(memoryRevisions.documentId, document.id))
      .orderBy(asc(memoryRevisions.version));
    expect(revisions).toHaveLength(50);
    expect(revisions[0]?.version).toBe(3);
  });

  it("serializes concurrent first saves with optimistic locking", async () => {
    const responses = await Promise.all([
      save(agentA, "profile", "first writer", 0),
      save(agentA, "profile", "second writer", 0),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });

  it("cascades agent notes and revisions on bot deletion but retains shared memory", async () => {
    const agentId = await createAgent("dev-user", "Bot to delete");
    expect((await save(agentId, "profile", "Shared survives", 0)).statusCode).toBe(200);
    expect((await save(agentId, "notes", "Deleted notes", 0)).statusCode).toBe(200);
    const [notes] = await app.db
      .select()
      .from(memoryDocuments)
      .where(eq(memoryDocuments.agentId, agentId));
    if (!notes) throw new Error("Expected notes to exist before deletion");
    const deleted = await app.inject({ method: "DELETE", url: `/agents/${agentId}` });
    expect(deleted.statusCode).toBe(204);
    expect(
      await app.db.select().from(memoryDocuments).where(eq(memoryDocuments.id, notes.id)),
    ).toHaveLength(0);
    expect(
      await app.db.select().from(memoryRevisions).where(eq(memoryRevisions.documentId, notes.id)),
    ).toHaveLength(0);
    const profile = await app.db
      .select()
      .from(memoryDocuments)
      .where(eq(memoryDocuments.ownerId, "dev-user"));
    expect(profile).toHaveLength(1);
    expect(profile[0]).toMatchObject({ name: "profile", content: "Shared survives" });
  });

  it("forgets only the authenticated owner's memory", async () => {
    await memoryService(app.db).save("other-owner", foreignAgent, "profile", "Keep me", 0);
    expect((await save(agentA, "profile", "Forget me", 0)).statusCode).toBe(200);
    const response = await app.inject({ method: "DELETE", url: "/memory" });
    expect(response.statusCode).toBe(204);
    expect(
      await app.db.select().from(memoryDocuments).where(eq(memoryDocuments.ownerId, "dev-user")),
    ).toHaveLength(0);
    expect(
      await app.db.select().from(memoryDocuments).where(eq(memoryDocuments.ownerId, "other-owner")),
    ).toMatchObject([{ content: "Keep me", name: "profile" }]);
  });
});

import { randomUUID } from "node:crypto";
import { agents, conversations } from "@opensquad/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";
import { agentsService } from "../src/modules/agents/service.js";
import { createTestApp } from "./helpers.js";

describe("conversation ownership and history", () => {
  let app: App;
  let agentId: string;
  let foreignId: string;
  const created: string[] = [];
  const extraBots: string[] = [];
  beforeAll(async () => {
    app = await createTestApp();
    const service = agentsService(app.db);
    agentId = (await service.create({ ownerId: "dev-user", name: "Conversation test" })).id;
    foreignId = (await service.create({ ownerId: "other-owner", name: "Private bot" })).id;
  });
  afterAll(async () => {
    for (const id of created) await app.db.delete(conversations).where(eq(conversations.id, id));
    await app.db.delete(agents).where(eq(agents.id, agentId));
    await app.db.delete(agents).where(eq(agents.id, foreignId));
    for (const id of extraBots) await app.db.delete(agents).where(eq(agents.id, id));
    await app.close();
  });
  function create(id = agentId, user = "dev-user") {
    return app.inject({
      method: "POST",
      url: "/conversations",
      payload: {
        title: "Research",
        participants: [
          { kind: "user", refId: user },
          { kind: "agent", refId: id },
        ],
      },
    });
  }
  it("creates a product conversation without runtime credentials and returns its two participants", async () => {
    const response = await create();
    expect(response.statusCode).toBe(201);
    const id = response.json().conversation.id;
    created.push(id);
    const detail = await app.inject({ method: "GET", url: `/conversations/${id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().participants).toHaveLength(2);
    expect(detail.json().activeRun).toBeNull();
    const history = await app.inject({ method: "GET", url: `/conversations/${id}/messages` });
    expect(history.json()).toEqual({ items: [], nextCursor: null });
    const list = await app.inject({ method: "GET", url: "/conversations?limit=1" });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
  });
  it("retains participant identity and conversation history when a bot is deleted", async () => {
    const disposable = await agentsService(app.db).create({
      ownerId: "dev-user",
      name: "Retained bot",
    });
    extraBots.push(disposable.id);
    const response = await create(disposable.id);
    expect(response.statusCode).toBe(201);
    const id = response.json().conversation.id;
    created.push(id);
    expect(
      (await app.inject({ method: "DELETE", url: `/agents/${disposable.id}` })).statusCode,
    ).toBe(204);
    const detail = await app.inject({ method: "GET", url: `/conversations/${id}` });
    expect(detail.statusCode).toBe(200);
    const participant = detail
      .json()
      .participants.find((member: { kind: string }) => member.kind === "agent");
    expect(participant.refId).toBe(disposable.id);
    expect(participant.name).toBe("Retained bot");
    expect(participant.deletedAt).not.toBeNull();
  });

  it("rejects another user participant, foreign bots and missing resources", async () => {
    expect((await create(agentId, "someone-else")).statusCode).toBe(400);
    expect((await create(foreignId)).statusCode).toBe(404);
    expect((await create(randomUUID())).statusCode).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `/conversations/${randomUUID()}` })).statusCode,
    ).toBe(404);
  });
  it("rejects malformed membership and pagination", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/conversations", payload: { participants: [] } }))
        .statusCode,
    ).toBe(400);
    for (const query of ["limit=0", "limit=101", "cursor=not-a-cursor"]) {
      expect((await app.inject({ method: "GET", url: `/conversations?${query}` })).statusCode).toBe(
        400,
      );
    }
  });

  it("filters the conversation list by agentId", async () => {
    const service = agentsService(app.db);
    const secondBot = await service.create({ ownerId: "dev-user", name: "Second bot" });
    extraBots.push(secondBot.id);
    const first = await create(agentId);
    const second = await create(secondBot.id);
    const third = await create(agentId);
    for (const response of [first, second, third]) {
      expect(response.statusCode).toBe(201);
      created.push(response.json().conversation.id);
    }
    const filtered = await app.inject({
      method: "GET",
      url: `/conversations?agentId=${secondBot.id}`,
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items.map((row: { id: string }) => row.id)).toEqual([
      second.json().conversation.id,
    ]);
    const otherFiltered = await app.inject({
      method: "GET",
      url: `/conversations?agentId=${agentId}`,
    });
    const agentItems = otherFiltered.json().items.map((row: { id: string }) => row.id);
    expect(agentItems).toEqual(
      expect.arrayContaining([first.json().conversation.id, third.json().conversation.id]),
    );
    expect(agentItems).not.toContain(second.json().conversation.id);
    expect(
      (await app.inject({ method: "GET", url: `/conversations?agentId=${foreignId}` })).json()
        .items,
    ).toEqual([]);
    expect(
      (await app.inject({ method: "GET", url: "/conversations?agentId=not-a-uuid" })).statusCode,
    ).toBe(400);
  });

  it("returns the current user id from /me", async () => {
    const response = await app.inject({ method: "GET", url: "/me" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: "dev-user" });
  });
});

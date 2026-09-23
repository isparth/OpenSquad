import { randomUUID } from "node:crypto";
import type { MemoryDocumentName, MemoryUpdateChange, RuntimeMessage } from "@opensquad/core";
import {
  agents,
  conversationMessages,
  conversationRuns,
  conversations,
  createDatabase,
  memoryDocuments,
  memoryRevisions,
  memorySettings,
  memorySources,
  memoryUpdates,
  participants,
  runtimeSessions,
} from "@opensquad/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app.js";
import { agentsService } from "../src/modules/agents/service.js";
import { conversationsService } from "../src/modules/conversations/service.js";
import { testDatabaseUrl } from "./database-url.js";
import { FakeRuntimeProvider } from "./fakes.js";
import { createTestApp } from "./helpers.js";

const ownerId = "dev-user";
const otherOwnerId = "review-other-owner";
const baseVersions = { profile: 0, preferences: 0, notes: 0 };
const transcriptMessage = (text: string) => [
  {
    role: "user" as const,
    status: "completed" as const,
    phase: null,
    text,
  },
  {
    role: "assistant" as const,
    status: "completed" as const,
    phase: "final" as const,
    text: "Understood.",
  },
];

interface UpdateSeed {
  id?: string;
  ownerId?: string;
  agentId?: string;
  trigger?: "auto" | "manual";
  status?: "running" | "succeeded" | "failed";
  changed?: MemoryUpdateChange[];
  sources?: Array<{ conversationId: string; throughSequence: string }>;
  createdAt?: Date;
  reviewedAt?: Date | null;
  finishedAt?: Date | null;
  errorCode?: string | null;
}

describe("memory review API", () => {
  let app: App;
  let runtime: FakeRuntimeProvider;
  let agentId: string;
  let agentIds: string[];
  let conversationIds: string[];
  let extractionOutput: string;
  let sessionNumber: number;

  async function createBot(name: string, owner = ownerId) {
    const row = await agentsService(app.db).create({ ownerId: owner, name });
    agentIds.push(row.id);
    return row.id;
  }

  async function createConversation(botId: string, title: string | null = null, owner = ownerId) {
    const { conversation } = await conversationsService(app.db).create(owner, botId, title);
    conversationIds.push(conversation.id);
    const [row] = await app.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    if (!row) throw new Error("Expected seeded conversation");
    return row;
  }

  async function seedDocument(
    name: MemoryDocumentName,
    content: string,
    version: number,
    botId: string | null = null,
    documentOwner = ownerId,
  ) {
    const [row] = await app.db
      .insert(memoryDocuments)
      .values({ ownerId: documentOwner, agentId: botId, name, content, version })
      .returning();
    if (!row) throw new Error("Expected seeded memory document");
    return row;
  }

  async function seedUpdate(options: UpdateSeed = {}) {
    const status = options.status ?? "succeeded";
    const createdAt = options.createdAt ?? new Date();
    const [row] = await app.db
      .insert(memoryUpdates)
      .values({
        ...(options.id ? { id: options.id } : {}),
        ownerId: options.ownerId ?? ownerId,
        agentId: options.agentId ?? agentId,
        trigger: options.trigger ?? "auto",
        status,
        baseVersions,
        sources: options.sources ?? [],
        changed: options.changed ?? [],
        provider: runtime.name,
        errorCode: options.errorCode ?? null,
        reviewedAt: options.reviewedAt ?? null,
        createdAt,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        finishedAt:
          options.finishedAt !== undefined
            ? options.finishedAt
            : status === "running"
              ? null
              : new Date(createdAt.getTime() + 1_000),
      })
      .returning();
    if (!row) throw new Error("Expected seeded memory update");
    return row;
  }

  async function seedRevision(
    documentId: string,
    version: number,
    content: string,
    author: "user" | "extraction" | "revert",
    updateId: string | null = null,
    createdAt = new Date(),
  ) {
    const [row] = await app.db
      .insert(memoryRevisions)
      .values({ documentId, version, content, author, updateId, createdAt })
      .returning();
    if (!row) throw new Error("Expected seeded memory revision");
    return row;
  }

  async function seedTranscript(
    botId: string,
    title: string,
    messages = transcriptMessage("Earlier fact"),
  ) {
    const conversation = await createConversation(botId, title);
    const [user] = await app.db
      .select()
      .from(participants)
      .where(and(eq(participants.conversationId, conversation.id), eq(participants.kind, "user")));
    const [agent] = await app.db
      .select()
      .from(participants)
      .where(and(eq(participants.conversationId, conversation.id), eq(participants.kind, "agent")));
    if (!user || !agent) throw new Error("Expected conversation participants");
    const [session] = await app.db
      .insert(runtimeSessions)
      .values({
        conversationId: conversation.id,
        agentParticipantId: agent.id,
        provider: runtime.name,
        externalId: `review-history-${randomUUID()}`,
        instructions: "",
        memorySnapshot: "",
        model: "gpt-6-luna",
        environment: "hosted",
      })
      .returning();
    if (!session) throw new Error("Expected history session");
    const [run] = await app.db
      .insert(conversationRuns)
      .values({
        conversationId: conversation.id,
        ownerId,
        agentParticipantId: agent.id,
        sessionId: session.id,
        clientRequestId: randomUUID(),
        input: messages[0]?.text ?? "history",
        status: "succeeded",
        observation: "connected",
        phase: "finished",
        active: false,
        deadlineAt: new Date(Date.now() + 60_000),
        finishedAt: new Date(),
      })
      .returning();
    if (!run) throw new Error("Expected history run");
    await app.db.insert(conversationMessages).values(
      messages.map((message, index) => ({
        conversationId: conversation.id,
        participantId: message.role === "user" ? user.id : agent.id,
        runId: run.id,
        sessionId: session.id,
        sequence: BigInt(index + 1),
        role: message.role,
        status: message.status,
        phase: message.phase,
        content: [{ index: 0, type: "text" as const, text: message.text, completed: true }],
      })),
    );
    await app.db
      .update(conversations)
      .set({ messageSequence: BigInt(messages.length) })
      .where(eq(conversations.id, conversation.id));
    return conversation;
  }

  function reviewsUrl(botId: string, limit = 10, cursor?: string) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return `/agents/${botId}/memory/reviews?${query.toString()}`;
  }

  function listReviews(botId: string, limit = 10, cursor?: string) {
    return app.inject({ method: "GET", url: reviewsUrl(botId, limit, cursor) });
  }

  function getMemory(botId = agentId) {
    return app.inject({ method: "GET", url: `/agents/${botId}/memory` });
  }

  function keepReview(updateId: string) {
    return app.inject({
      method: "POST",
      url: `/memory/updates/${updateId}/keep`,
      payload: {},
    });
  }

  function undoReview(updateId: string) {
    return app.inject({
      method: "POST",
      url: `/memory/updates/${updateId}/undo`,
      payload: {},
    });
  }

  async function startManualRefresh(botId = agentId) {
    return app.inject({
      method: "POST",
      url: `/agents/${botId}/memory/refresh`,
      headers: { "x-opensquad-runtime-key": "dummy-user-key" },
      payload: {},
    });
  }

  async function waitForUpdate(updateId: string, status: "succeeded" | "failed") {
    await vi.waitFor(
      async () => {
        const [row] = await app.db
          .select()
          .from(memoryUpdates)
          .where(eq(memoryUpdates.id, updateId));
        expect(row?.status).toBe(status);
      },
      { timeout: 3_000, interval: 10 },
    );
    const [row] = await app.db.select().from(memoryUpdates).where(eq(memoryUpdates.id, updateId));
    if (!row) throw new Error("Expected memory update");
    return row;
  }

  beforeEach(async () => {
    runtime = new FakeRuntimeProvider();
    sessionNumber = 0;
    extractionOutput = JSON.stringify({ profile: "- Name: Parth", preferences: null, notes: null });
    runtime.createSession.mockImplementation(async (options) => {
      if (!options.outputSchema) throw new Error("Expected structured extraction session");
      return {
        provider: runtime.name,
        externalId: `review-extractor-${++sessionNumber}`,
        model: options.model ?? "gpt-6-luna",
        status: "idle",
        environmentExternalId: null,
      };
    });
    runtime.listTurns.mockImplementation(async function* (session) {
      if (!session.externalId.startsWith("review-extractor-")) return;
      yield {
        externalId: "review-extractor-root",
        subagentExternalId: null,
        status: "succeeded",
        usage: { inputTokens: 10, outputTokens: 2 },
        error: null,
      };
    });
    runtime.listMessages.mockImplementation(async function* (session) {
      if (!session.externalId.startsWith("review-extractor-")) return;
      const message: RuntimeMessage = {
        externalId: "review-extractor-message",
        turnExternalId: "review-extractor-root",
        role: "assistant",
        status: "completed",
        phase: "final",
        content: [{ type: "text", text: extractionOutput }],
      };
      yield message;
    });
    runtime.destroySession.mockResolvedValue(undefined);
    app = await createTestApp({
      capabilities: { runtime },
      memoryUpdates: { autoTrigger: false, pollIntervalMs: 5, turnDeadlineMs: 300 },
    });
    agentIds = [];
    conversationIds = [];
    agentId = await createBot("Review bot");
  });

  afterEach(async () => {
    await app.close();
    const cleanup = createDatabase(testDatabaseUrl);
    try {
      await cleanup.db
        .delete(memoryUpdates)
        .where(inArray(memoryUpdates.ownerId, [ownerId, otherOwnerId]));
      await cleanup.db
        .delete(memorySources)
        .where(inArray(memorySources.ownerId, [ownerId, otherOwnerId]));
      await cleanup.db
        .delete(memorySettings)
        .where(inArray(memorySettings.ownerId, [ownerId, otherOwnerId]));
      await cleanup.db
        .delete(memoryDocuments)
        .where(inArray(memoryDocuments.ownerId, [ownerId, otherOwnerId]));
      if (conversationIds.length > 0)
        await cleanup.db.delete(conversations).where(inArray(conversations.id, conversationIds));
      if (agentIds.length > 0) await cleanup.db.delete(agents).where(inArray(agents.id, agentIds));
    } finally {
      await cleanup.close();
    }
  });

  it("lists relevant reviews newest first with version snapshots, sources, cursors and ownership checks", async () => {
    const otherBotId = await createBot("Other review bot");
    const foreignBotId = await createBot("Foreign review bot", otherOwnerId);
    const sourceConversation = await createConversation(agentId, "Primary history");
    const missingConversationId = randomUUID();
    const ownCreatedAt = new Date("2026-09-20T00:00:00.000Z");
    const otherProfileCreatedAt = new Date("2026-09-19T00:00:00.000Z");
    const otherNotesCreatedAt = new Date("2026-09-18T00:00:00.000Z");
    const ownUpdate = await seedUpdate({
      agentId,
      createdAt: ownCreatedAt,
      changed: [
        { name: "profile", fromVersion: 0, toVersion: 1 },
        { name: "notes", fromVersion: 0, toVersion: 1 },
      ],
      sources: [
        { conversationId: sourceConversation.id, throughSequence: "2" },
        { conversationId: missingConversationId, throughSequence: "4" },
      ],
    });
    const otherProfileUpdate = await seedUpdate({
      agentId: otherBotId,
      createdAt: otherProfileCreatedAt,
      changed: [{ name: "profile", fromVersion: 1, toVersion: 2 }],
    });
    const otherNotesUpdate = await seedUpdate({
      agentId: otherBotId,
      createdAt: otherNotesCreatedAt,
      changed: [{ name: "notes", fromVersion: 0, toVersion: 1 }],
    });
    const profile = await seedDocument("profile", "Current profile", 2);
    const notesA = await seedDocument("notes", "Notes from A update", 1, agentId);
    const notesB = await seedDocument("notes", "Notes from B update", 1, otherBotId);
    await seedRevision(profile.id, 1, "Profile from own update", "extraction", ownUpdate.id);
    await seedRevision(profile.id, 2, "Current profile", "extraction", otherProfileUpdate.id);
    await seedRevision(notesA.id, 1, "Notes from A update", "extraction", ownUpdate.id);
    await seedRevision(notesB.id, 1, "Notes from B update", "extraction", otherNotesUpdate.id);

    await seedUpdate({
      agentId,
      status: "failed",
      changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
      createdAt: new Date("2026-09-24T00:00:00.000Z"),
    });
    await seedUpdate({ agentId, changed: [], createdAt: new Date("2026-09-23T00:00:00.000Z") });
    await seedUpdate({
      agentId,
      changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
      reviewedAt: new Date(),
      createdAt: new Date("2026-09-22T00:00:00.000Z"),
    });
    await seedUpdate({
      agentId,
      status: "running",
      changed: [],
      createdAt: new Date("2026-09-21T00:00:00.000Z"),
    });
    await seedUpdate({
      ownerId: otherOwnerId,
      agentId: foreignBotId,
      changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
      createdAt: new Date("2026-09-25T00:00:00.000Z"),
    });

    const firstPage = await listReviews(agentId, 1);
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().items).toHaveLength(1);
    expect(firstPage.json().items[0]).toMatchObject({
      updateId: ownUpdate.id,
      agentId,
      agentName: "Review bot",
      trigger: "auto",
      createdAt: ownCreatedAt.toISOString(),
      sources: [
        {
          conversationId: sourceConversation.id,
          title: "Primary history",
          startedAt: sourceConversation.createdAt.toISOString(),
        },
      ],
      changes: [
        {
          name: "profile",
          fromVersion: 0,
          toVersion: 1,
          before: "",
          after: "Profile from own update",
          current: false,
        },
        {
          name: "notes",
          fromVersion: 0,
          toVersion: 1,
          before: "",
          after: "Notes from A update",
          current: true,
        },
      ],
    });
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));
    const secondPage = await listReviews(agentId, 1, firstPage.json().nextCursor);
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().items).toMatchObject([
      {
        updateId: otherProfileUpdate.id,
        agentId: otherBotId,
        agentName: "Other review bot",
        changes: [
          {
            name: "profile",
            fromVersion: 1,
            toVersion: 2,
            before: "Profile from own update",
            after: "Current profile",
            current: true,
          },
        ],
      },
    ]);
    expect(secondPage.json().nextCursor).toBeNull();
    const otherBotReviews = await listReviews(otherBotId);
    expect(otherBotReviews.statusCode).toBe(200);
    expect(otherBotReviews.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          updateId: ownUpdate.id,
          agentId,
          changes: expect.arrayContaining([
            expect.objectContaining({ name: "notes", after: "Notes from A update" }),
          ]),
        }),
      ]),
    );
    expect(otherBotReviews.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          updateId: otherNotesUpdate.id,
          agentId: otherBotId,
          changes: [
            expect.objectContaining({ name: "notes", after: "Notes from B update", current: true }),
          ],
        }),
      ]),
    );
    expect((await listReviews(agentId, 10, "not-a-cursor")).statusCode).toBe(400);
    expect((await listReviews(foreignBotId)).statusCode).toBe(404);
  });

  it("paginates rows created in the same millisecond using the ID tie-breaker", async () => {
    const laterId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const earlierId = "00000000-0000-4000-8000-000000000000";
    const createdAt = new Date("2026-09-20T10:00:00.123Z");
    const later = await seedUpdate({
      id: laterId,
      createdAt,
      changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
    });
    const earlier = await seedUpdate({
      id: earlierId,
      createdAt,
      changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
    });
    await app.db.execute(
      sql`update memory_updates set created_at = '2026-09-20 10:00:00.123456+00'::timestamptz where id = ${later.id}::uuid`,
    );
    await app.db.execute(
      sql`update memory_updates set created_at = '2026-09-20 10:00:00.123400+00'::timestamptz where id = ${earlier.id}::uuid`,
    );

    const firstPage = await listReviews(agentId, 1);
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().items.map((item: { updateId: string }) => item.updateId)).toEqual([
      later.id,
    ]);
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));
    const secondPage = await listReviews(agentId, 1, firstPage.json().nextCursor);
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().items.map((item: { updateId: string }) => item.updateId)).toEqual([
      earlier.id,
    ]);
    expect(secondPage.json().nextCursor).toBeNull();
  });

  it("marks changes non-current and returns null for pruned revisions", async () => {
    const update = await seedUpdate({
      changed: [
        { name: "profile", fromVersion: 0, toVersion: 1 },
        { name: "preferences", fromVersion: 1, toVersion: 2 },
      ],
    });
    const profile = await seedDocument("profile", "Edited after extraction", 2);
    const preferences = await seedDocument("preferences", "Current preference", 2);
    await seedRevision(profile.id, 2, "Edited after extraction", "user");
    await seedRevision(preferences.id, 2, "Current preference", "extraction", update.id);

    const response = await listReviews(agentId);
    expect(response.statusCode).toBe(200);
    const changes = response.json().items[0].changes;
    expect(changes).toEqual([
      {
        name: "profile",
        fromVersion: 0,
        toVersion: 1,
        before: "",
        after: null,
        current: false,
      },
      {
        name: "preferences",
        fromVersion: 1,
        toVersion: 2,
        before: null,
        after: "Current preference",
        current: true,
      },
    ]);
  });

  it("adds the count of relevant reviewable updates to GET memory", async () => {
    const otherBotId = await createBot("Other review bot");
    await seedUpdate({ changed: [{ name: "notes", fromVersion: 0, toVersion: 1 }] });
    await seedUpdate({
      agentId: otherBotId,
      changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
    });
    await seedUpdate({
      agentId: otherBotId,
      changed: [{ name: "notes", fromVersion: 0, toVersion: 1 }],
    });
    await seedUpdate({
      agentId,
      status: "failed",
      changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
    });
    await seedUpdate({ agentId, changed: [] });
    await seedUpdate({
      agentId,
      reviewedAt: new Date(),
      changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
    });
    await seedUpdate({ agentId, status: "running", changed: [] });

    const response = await getMemory();
    expect(response.statusCode).toBe(200);
    expect(response.json().pendingReviewCount).toBe(2);
  });

  it("keeps reviews idempotently and rejects foreign, unknown and failed updates", async () => {
    const profileUpdate = await seedUpdate({
      changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
    });
    const foreignBotId = await createBot("Foreign review bot", otherOwnerId);
    const foreignUpdate = await seedUpdate({
      ownerId: otherOwnerId,
      agentId: foreignBotId,
      changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
    });
    const failedUpdate = await seedUpdate({
      status: "failed",
      errorCode: "provider_failure",
      changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
    });

    expect((await keepReview(profileUpdate.id)).statusCode).toBe(204);
    expect((await keepReview(profileUpdate.id)).statusCode).toBe(204);
    expect((await listReviews(agentId)).json().items).toHaveLength(0);
    expect((await getMemory()).json().pendingReviewCount).toBe(0);
    expect((await keepReview(randomUUID())).statusCode).toBe(404);
    expect((await keepReview(foreignUpdate.id)).statusCode).toBe(404);
    const [untouchedForeign] = await app.db
      .select()
      .from(memoryUpdates)
      .where(eq(memoryUpdates.id, foreignUpdate.id));
    expect(untouchedForeign?.reviewedAt).toBeNull();
    const failed = await keepReview(failedUpdate.id);
    expect(failed.statusCode).toBe(409);
    expect(failed.json().message).toBe("This memory update can't be reviewed");
  });

  it("undoes shared and update-bot documents without rewinding memory sources", async () => {
    const otherBotId = await createBot("Other review bot");
    const source = await createConversation(agentId, "Source history");
    const update = await seedUpdate({
      agentId,
      changed: [
        { name: "profile", fromVersion: 0, toVersion: 1 },
        { name: "notes", fromVersion: 0, toVersion: 1 },
      ],
      sources: [{ conversationId: source.id, throughSequence: "2" }],
    });
    const profile = await seedDocument("profile", "Extracted profile", 1);
    const notesA = await seedDocument("notes", "Notes for the update bot", 1, agentId);
    const notesB = await seedDocument("notes", "Notes for the other bot", 1, otherBotId);
    await seedRevision(profile.id, 1, "Extracted profile", "extraction", update.id);
    await seedRevision(notesA.id, 1, "Notes for the update bot", "extraction", update.id);
    await seedRevision(notesB.id, 1, "Notes for the other bot", "user");
    await app.db.insert(memorySources).values({
      conversationId: source.id,
      ownerId,
      agentId,
      processedThroughSequence: 2n,
    });
    const [sourceBefore] = await app.db
      .select()
      .from(memorySources)
      .where(eq(memorySources.conversationId, source.id));

    const response = await undoReview(update.id);
    expect(response.statusCode).toBe(204);
    const memory = await getMemory(agentId);
    expect(memory.json().documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "profile", content: "", version: 2 }),
        expect.objectContaining({ name: "notes", content: "", version: 2 }),
      ]),
    );
    const [untouchedNotesB] = await app.db
      .select()
      .from(memoryDocuments)
      .where(eq(memoryDocuments.id, notesB.id));
    expect(untouchedNotesB?.content).toBe("Notes for the other bot");
    for (const document of [profile, notesA]) {
      const [revert] = await app.db
        .select()
        .from(memoryRevisions)
        .where(and(eq(memoryRevisions.documentId, document.id), eq(memoryRevisions.version, 2)));
      expect(revert).toMatchObject({ content: "", author: "revert", updateId: null });
    }
    const [reviewed] = await app.db
      .select()
      .from(memoryUpdates)
      .where(eq(memoryUpdates.id, update.id));
    expect(reviewed?.reviewedAt).toBeInstanceOf(Date);
    const [sourceAfter] = await app.db
      .select()
      .from(memorySources)
      .where(eq(memorySources.conversationId, source.id));
    expect(sourceAfter?.processedThroughSequence).toBe(sourceBefore?.processedThroughSequence);
  });

  it("refuses stale multi-document undo atomically and handles reviewed updates", async () => {
    const profileUpdate = await seedUpdate({
      changed: [
        { name: "profile", fromVersion: 0, toVersion: 1 },
        { name: "notes", fromVersion: 0, toVersion: 1 },
      ],
    });
    const profile = await seedDocument("profile", "Edited after extraction", 2);
    const notes = await seedDocument("notes", "Extracted note", 1, agentId);
    await seedRevision(profile.id, 1, "Extracted profile", "extraction", profileUpdate.id);
    await seedRevision(profile.id, 2, "Edited after extraction", "user");
    await seedRevision(notes.id, 1, "Extracted note", "extraction", profileUpdate.id);
    const revisionsBefore = await app.db.select().from(memoryRevisions);

    const staleUndo = await undoReview(profileUpdate.id);
    expect(staleUndo.statusCode).toBe(409);
    expect(staleUndo.json().message).toBe(
      "Memory changed since this update; use History to restore an older version",
    );
    const [profileAfterStaleUndo] = await app.db
      .select()
      .from(memoryDocuments)
      .where(eq(memoryDocuments.id, profile.id));
    const [notesAfterStaleUndo] = await app.db
      .select()
      .from(memoryDocuments)
      .where(eq(memoryDocuments.id, notes.id));
    expect(profileAfterStaleUndo?.version).toBe(2);
    expect(notesAfterStaleUndo?.version).toBe(1);
    expect(await app.db.select().from(memoryRevisions)).toHaveLength(revisionsBefore.length);
    const [unreviewed] = await app.db
      .select()
      .from(memoryUpdates)
      .where(eq(memoryUpdates.id, profileUpdate.id));
    expect(unreviewed?.reviewedAt).toBeNull();

    const keptUpdate = await seedUpdate({
      changed: [{ name: "preferences", fromVersion: 0, toVersion: 1 }],
    });
    expect((await keepReview(keptUpdate.id)).statusCode).toBe(204);
    const undoAfterKeep = await undoReview(keptUpdate.id);
    expect(undoAfterKeep.statusCode).toBe(409);
    expect(undoAfterKeep.json().message).toBe("This memory update was already reviewed");

    const undoTwice = await seedUpdate({
      changed: [{ name: "preferences", fromVersion: 0, toVersion: 1 }],
    });
    const undoDocument = await seedDocument("preferences", "Undo me", 1);
    if (!undoDocument) throw new Error("Expected preferences document");
    await seedRevision(undoDocument.id, 1, "Undo me", "extraction", undoTwice.id);
    expect((await undoReview(undoTwice.id)).statusCode).toBe(204);
    const secondUndo = await undoReview(undoTwice.id);
    expect(secondUndo.statusCode).toBe(409);
    expect(secondUndo.json().message).toBe("This memory update was already reviewed");

    const foreignBotId = await createBot("Foreign review bot", otherOwnerId);
    const foreignUpdate = await seedUpdate({
      ownerId: otherOwnerId,
      agentId: foreignBotId,
      changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
    });
    expect((await undoReview(foreignUpdate.id)).statusCode).toBe(404);
    expect((await undoReview(randomUUID())).statusCode).toBe(404);
  });

  it("lists and undoes a fake-runtime extraction end to end", async () => {
    const source = await seedTranscript(agentId, "Saved facts");
    const [profileBefore] = await app.db
      .select()
      .from(memoryDocuments)
      .where(and(eq(memoryDocuments.ownerId, ownerId), eq(memoryDocuments.name, "profile")));
    expect(profileBefore).toBeUndefined();
    const response = await startManualRefresh();
    expect(response.statusCode).toBe(202);
    const update = await waitForUpdate(response.json().update.id, "succeeded");
    expect(update.changed).toEqual([{ name: "profile", fromVersion: 0, toVersion: 1 }]);
    const list = await listReviews(agentId);
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toMatchObject([
      {
        updateId: update.id,
        changes: [
          { name: "profile", fromVersion: 0, toVersion: 1, before: "", after: "- Name: Parth" },
        ],
        sources: [
          {
            conversationId: source.id,
            title: "Saved facts",
            startedAt: source.createdAt.toISOString(),
          },
        ],
      },
    ]);
    const [sourceBeforeUndo] = await app.db
      .select()
      .from(memorySources)
      .where(eq(memorySources.conversationId, source.id));
    expect((await undoReview(update.id)).statusCode).toBe(204);
    const [profileAfterUndo] = await app.db
      .select()
      .from(memoryDocuments)
      .where(and(eq(memoryDocuments.ownerId, ownerId), eq(memoryDocuments.name, "profile")));
    expect(profileAfterUndo).toMatchObject({ content: "", version: 2 });
    const [sourceAfterUndo] = await app.db
      .select()
      .from(memorySources)
      .where(eq(memorySources.conversationId, source.id));
    expect(sourceAfterUndo?.processedThroughSequence).toBe(
      sourceBeforeUndo?.processedThroughSequence,
    );
  });

  it("retains only old unreviewed changes when an update starts", async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    const failed = await seedUpdate({
      status: "failed",
      errorCode: "provider_failure",
      createdAt: old,
      finishedAt: old,
      changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
    });
    const reviewed = await seedUpdate({
      createdAt: old,
      finishedAt: old,
      reviewedAt: old,
      changed: [{ name: "preferences", fromVersion: 0, toVersion: 1 }],
    });
    const noChange = await seedUpdate({ createdAt: old, finishedAt: old, changed: [] });
    const retained = await seedUpdate({
      createdAt: old,
      finishedAt: old,
      changed: [{ name: "notes", fromVersion: 0, toVersion: 1 }],
    });
    const profile = await seedDocument("profile", "Old profile", 1);
    const preferences = await seedDocument("preferences", "Old preference", 1);
    const notes = await seedDocument("notes", "Old note", 1, agentId);
    await seedRevision(profile.id, 1, "Old profile", "extraction", failed.id, old);
    await seedRevision(preferences.id, 1, "Old preference", "extraction", reviewed.id, old);
    await seedRevision(notes.id, 1, "Old note", "extraction", retained.id, old);
    await seedTranscript(agentId, "New conversation");

    const response = await startManualRefresh();
    expect(response.statusCode).toBe(202);
    const newest = await waitForUpdate(response.json().update.id, "succeeded");
    const rows = await app.db
      .select()
      .from(memoryUpdates)
      .where(eq(memoryUpdates.ownerId, ownerId));
    const ids = rows.map((row) => row.id);
    expect(ids).not.toContain(failed.id);
    expect(ids).not.toContain(reviewed.id);
    expect(ids).not.toContain(noChange.id);
    expect(ids).toContain(retained.id);
    expect(ids).toContain(newest.id);
    const [failedRevision] = await app.db
      .select()
      .from(memoryRevisions)
      .where(and(eq(memoryRevisions.documentId, profile.id), eq(memoryRevisions.version, 1)));
    const [reviewedRevision] = await app.db
      .select()
      .from(memoryRevisions)
      .where(and(eq(memoryRevisions.documentId, preferences.id), eq(memoryRevisions.version, 1)));
    const [retainedRevision] = await app.db
      .select()
      .from(memoryRevisions)
      .where(and(eq(memoryRevisions.documentId, notes.id), eq(memoryRevisions.version, 1)));
    expect(failedRevision?.updateId).toBeNull();
    expect(reviewedRevision?.updateId).toBeNull();
    expect(retainedRevision?.updateId).toBe(retained.id);
  });
});

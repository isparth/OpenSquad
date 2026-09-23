import type {
  MemoryDocument,
  MemoryDocumentName,
  MemoryRevision,
  MemoryRevisionAuthor,
  MemoryUpdate,
} from "@opensquad/core";
import {
  agents,
  conversations,
  type Database,
  memoryDocuments,
  memoryRevisions,
  memorySettings,
  memorySources,
  memoryUpdates,
  participants,
} from "@opensquad/db";
import { and, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Transaction } from "../conversations/persistence.js";
import { renderMemory } from "./render.js";

const documentNames: MemoryDocumentName[] = ["profile", "preferences", "notes"];
export const documentLimits: Record<MemoryDocumentName, number> = {
  profile: 4000,
  preferences: 2000,
  notes: 4000,
};
const revisionsPerDocument = 50;

export class MemoryError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function documentDto(
  name: MemoryDocumentName,
  row: typeof memoryDocuments.$inferSelect | undefined,
): MemoryDocument {
  return {
    name,
    scope: name === "notes" ? "agent" : "shared",
    content: row?.content ?? "",
    version: row?.version ?? 0,
    limit: documentLimits[name],
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export function memoryUpdateDto(row: typeof memoryUpdates.$inferSelect): MemoryUpdate {
  return {
    id: row.id,
    agentId: row.agentId,
    trigger: row.trigger,
    status: row.status,
    changed: row.changed,
    errorCode: row.errorCode,
    usage: row.usage,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export async function lockMemoryOwner(tx: Transaction, ownerId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`memory:${ownerId}`}, 0))`);
}

export async function sweepExpiredMemoryUpdates(tx: Transaction, ownerId: string): Promise<void> {
  await tx
    .update(memoryUpdates)
    .set({ status: "failed", errorCode: "worker_lost", finishedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(memoryUpdates.ownerId, ownerId),
        eq(memoryUpdates.status, "running"),
        lte(memoryUpdates.leaseExpiresAt, sql`clock_timestamp()`),
      ),
    );
}

export async function writeDocument(
  tx: Transaction,
  input: {
    ownerId: string;
    agentId: string;
    name: MemoryDocumentName;
    content: string;
    expectedVersion: number;
    author: MemoryRevisionAuthor;
    updateId: string | null;
  },
): Promise<MemoryDocument> {
  const [current] = await tx
    .select()
    .from(memoryDocuments)
    .where(scopedDocument(input.ownerId, input.agentId, input.name))
    .limit(1);
  const currentVersion = current?.version ?? 0;
  if (currentVersion !== input.expectedVersion)
    throw new MemoryError(409, "Memory changed since it was loaded");

  const version = currentVersion + 1;
  const [row] = current
    ? await tx
        .update(memoryDocuments)
        .set({ content: input.content, version, updatedAt: sql`clock_timestamp()` })
        .where(eq(memoryDocuments.id, current.id))
        .returning()
    : await tx
        .insert(memoryDocuments)
        .values({
          ownerId: input.ownerId,
          agentId: input.name === "notes" ? input.agentId : null,
          name: input.name,
          content: input.content,
          version,
        })
        .returning();
  if (!row) throw new Error("Memory document write returned no row");

  await tx.insert(memoryRevisions).values({
    documentId: row.id,
    updateId: input.updateId,
    version,
    content: input.content,
    author: input.author,
  });
  await tx
    .delete(memoryRevisions)
    .where(
      and(
        eq(memoryRevisions.documentId, row.id),
        lt(memoryRevisions.version, version - revisionsPerDocument + 1),
      ),
    );
  return documentDto(input.name, row);
}

function scopedDocument(ownerId: string, agentId: string, name: MemoryDocumentName) {
  return and(
    eq(memoryDocuments.ownerId, ownerId),
    eq(memoryDocuments.name, name),
    name === "notes" ? eq(memoryDocuments.agentId, agentId) : isNull(memoryDocuments.agentId),
  );
}

export async function memorySnapshot(
  tx: Transaction,
  ownerId: string,
  agentId: string,
): Promise<string> {
  const [settings] = await tx
    .select({ autoUpdate: memorySettings.autoUpdate })
    .from(memorySettings)
    .where(eq(memorySettings.ownerId, ownerId));
  const rows = await tx
    .select({
      name: memoryDocuments.name,
      agentId: memoryDocuments.agentId,
      content: memoryDocuments.content,
    })
    .from(memoryDocuments)
    .where(
      and(
        eq(memoryDocuments.ownerId, ownerId),
        or(isNull(memoryDocuments.agentId), eq(memoryDocuments.agentId, agentId)),
      ),
    );
  return renderMemory(
    {
      profile: rows.find((row) => row.name === "profile")?.content ?? "",
      preferences: rows.find((row) => row.name === "preferences")?.content ?? "",
      notes: rows.find((row) => row.name === "notes" && row.agentId === agentId)?.content ?? "",
    },
    { autoUpdate: settings?.autoUpdate ?? true },
  );
}

export async function assertAgent(
  executor: Database | Transaction,
  ownerId: string,
  agentId: string,
  lock = false,
) {
  const condition = and(eq(agents.id, agentId), eq(agents.ownerId, ownerId));
  const result = lock
    ? await executor.select({ id: agents.id }).from(agents).where(condition).for("share")
    : await executor.select({ id: agents.id }).from(agents).where(condition);
  if (result.length === 0) throw new MemoryError(404, "Bot not found");
}

export function memoryService(db: Database) {
  const save = async (
    ownerId: string,
    agentId: string,
    name: MemoryDocumentName,
    content: string,
    expectedVersion: number,
    author: MemoryRevisionAuthor = "user",
  ): Promise<MemoryDocument> =>
    db.transaction(async (tx) => {
      await lockMemoryOwner(tx, ownerId);
      await assertAgent(tx, ownerId, agentId, true);
      if (content.length > documentLimits[name])
        throw new MemoryError(400, "Memory document is too long");
      if (content.includes("\u0000"))
        throw new MemoryError(400, "Memory document contains invalid characters");

      return writeDocument(tx, {
        ownerId,
        agentId,
        name,
        content,
        expectedVersion,
        author,
        updateId: null,
      });
    });

  return {
    status: async (ownerId: string, agentId: string) =>
      db.transaction(async (tx) => {
        await lockMemoryOwner(tx, ownerId);
        await sweepExpiredMemoryUpdates(tx, ownerId);
        await assertAgent(tx, ownerId, agentId);
        const [setting] = await tx
          .select({ autoUpdate: memorySettings.autoUpdate })
          .from(memorySettings)
          .where(eq(memorySettings.ownerId, ownerId));
        const [latest] = await tx
          .select()
          .from(memoryUpdates)
          .where(and(eq(memoryUpdates.ownerId, ownerId), eq(memoryUpdates.agentId, agentId)))
          .orderBy(desc(memoryUpdates.createdAt))
          .limit(1);
        return {
          autoUpdate: setting?.autoUpdate ?? true,
          lastUpdate: latest ? memoryUpdateDto(latest) : null,
        };
      }),

    setAutoUpdate: async (ownerId: string, autoUpdate: boolean): Promise<boolean> =>
      db.transaction(async (tx) => {
        await lockMemoryOwner(tx, ownerId);
        const [row] = await tx
          .insert(memorySettings)
          .values({ ownerId, autoUpdate })
          .onConflictDoUpdate({
            target: memorySettings.ownerId,
            set: { autoUpdate, updatedAt: sql`clock_timestamp()` },
          })
          .returning({ autoUpdate: memorySettings.autoUpdate });
        return row?.autoUpdate ?? autoUpdate;
      }),

    list: async (ownerId: string, agentId: string): Promise<MemoryDocument[]> => {
      await assertAgent(db, ownerId, agentId);
      const rows = await db
        .select()
        .from(memoryDocuments)
        .where(
          and(
            eq(memoryDocuments.ownerId, ownerId),
            or(isNull(memoryDocuments.agentId), eq(memoryDocuments.agentId, agentId)),
          ),
        );
      return documentNames.map((name) =>
        documentDto(
          name,
          rows.find(
            (row) =>
              row.name === name &&
              (name === "notes" ? row.agentId === agentId : row.agentId === null),
          ),
        ),
      );
    },

    save,

    revisions: async (
      ownerId: string,
      agentId: string,
      name: MemoryDocumentName,
      limit: number,
      before?: number,
    ): Promise<{ items: MemoryRevision[]; nextCursor: string | null }> => {
      await assertAgent(db, ownerId, agentId);
      const conditions = [scopedDocument(ownerId, agentId, name)];
      if (before !== undefined) conditions.push(lt(memoryRevisions.version, before));
      const rows = await db
        .select({
          version: memoryRevisions.version,
          author: memoryRevisions.author,
          content: memoryRevisions.content,
          createdAt: memoryRevisions.createdAt,
        })
        .from(memoryRevisions)
        .innerJoin(memoryDocuments, eq(memoryRevisions.documentId, memoryDocuments.id))
        .where(and(...conditions))
        .orderBy(desc(memoryRevisions.version))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      }));
      return {
        items,
        nextCursor: hasMore ? String(items.at(-1)?.version) : null,
      };
    },

    revert: async (
      ownerId: string,
      agentId: string,
      name: MemoryDocumentName,
      version: number,
      expectedVersion: number,
    ): Promise<MemoryDocument> => {
      await assertAgent(db, ownerId, agentId);
      const [revision] = await db
        .select({ content: memoryRevisions.content })
        .from(memoryRevisions)
        .innerJoin(memoryDocuments, eq(memoryRevisions.documentId, memoryDocuments.id))
        .where(and(scopedDocument(ownerId, agentId, name), eq(memoryRevisions.version, version)));
      if (!revision) throw new MemoryError(404, "Revision not found");
      return save(ownerId, agentId, name, revision.content, expectedVersion, "revert");
    },

    forget: (ownerId: string) =>
      db.transaction(async (tx) => {
        await lockMemoryOwner(tx, ownerId);
        await tx.delete(memoryDocuments).where(eq(memoryDocuments.ownerId, ownerId));
        await tx.delete(memoryUpdates).where(eq(memoryUpdates.ownerId, ownerId));
        await tx.execute(sql`
          insert into ${memorySources} (
            "conversation_id",
            "owner_id",
            "agent_id",
            "processed_through_sequence"
          )
          select
            ${conversations.id},
            ${conversations.ownerId},
            ${participants.agentId},
            ${conversations.messageSequence}
          from ${conversations}
          inner join ${participants}
            on ${participants.conversationId} = ${conversations.id}
          where ${conversations.ownerId} = ${ownerId}
            and ${participants.kind} = 'agent'
            and ${participants.agentId} is not null
          on conflict ("conversation_id") do update set
            "owner_id" = excluded."owner_id",
            "agent_id" = excluded."agent_id",
            "processed_through_sequence" = excluded."processed_through_sequence",
            "updated_at" = clock_timestamp()
        `);
      }),
  };
}

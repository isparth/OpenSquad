import type {
  MemoryDocumentName,
  MemoryReview,
  MemoryReviewChange,
  MemoryUpdateChange,
} from "@opensquad/core";
import {
  agents,
  conversations,
  type Database,
  memoryDocuments,
  memoryRevisions,
  memoryUpdates,
} from "@opensquad/db";
import { and, count, desc, eq, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { Transaction } from "../conversations/persistence.js";
import { lockMemoryOwner, MemoryError, writeDocument } from "./service.js";

interface ReviewCursor {
  createdAt: Date;
  id: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalidCursor(): never {
  throw new MemoryError(400, "Invalid memory review cursor");
}

function parseCursor(cursor: string): ReviewCursor {
  if (cursor.length > 128 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalidCursor();
  const value = Buffer.from(cursor, "base64url").toString("utf8");
  if (Buffer.from(value).toString("base64url") !== cursor) invalidCursor();
  const separator = value.indexOf("|");
  if (separator < 1 || value.indexOf("|", separator + 1) !== -1) invalidCursor();
  const createdAtValue = value.slice(0, separator);
  const id = value.slice(separator + 1);
  const createdAt = new Date(createdAtValue);
  if (
    !uuidPattern.test(id) ||
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== createdAtValue
  )
    invalidCursor();
  return { createdAt, id };
}

function encodeCursor(createdAt: Date, id: string) {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

function reviewableUpdates(ownerId: string, agentId: string) {
  return and(
    eq(memoryUpdates.ownerId, ownerId),
    eq(memoryUpdates.status, "succeeded"),
    isNull(memoryUpdates.reviewedAt),
    sql`jsonb_array_length(${memoryUpdates.changed}) > 0`,
    or(
      eq(memoryUpdates.agentId, agentId),
      sql`${memoryUpdates.changed} @> '[{"name":"profile"}]'::jsonb`,
      sql`${memoryUpdates.changed} @> '[{"name":"preferences"}]'::jsonb`,
    ),
  );
}

function documentScopeKey(name: MemoryDocumentName, agentId: string) {
  return `${name}:${name === "notes" ? agentId : "shared"}`;
}

function revisionKey(documentId: string, version: number) {
  return `${documentId}:${version}`;
}

export async function pendingMemoryReviewCount(
  db: Database,
  ownerId: string,
  agentId: string,
): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(memoryUpdates)
    .where(reviewableUpdates(ownerId, agentId));
  return Number(result?.count ?? 0);
}

export async function listMemoryReviews(
  db: Database,
  ownerId: string,
  agentId: string,
  limit: number,
  cursor?: string,
): Promise<{ items: MemoryReview[]; nextCursor: string | null }> {
  const createdAtMs = sql`date_trunc('milliseconds', ${memoryUpdates.createdAt})`;
  const conditions = [reviewableUpdates(ownerId, agentId)];
  if (cursor) {
    const position = parseCursor(cursor);
    const cursorCreatedAt = position.createdAt.toISOString();
    conditions.push(
      or(
        sql`${createdAtMs} < ${cursorCreatedAt}::timestamptz`,
        and(
          sql`${createdAtMs} = ${cursorCreatedAt}::timestamptz`,
          lt(memoryUpdates.id, position.id),
        ),
      ),
    );
  }
  const rows = await db
    .select()
    .from(memoryUpdates)
    .where(and(...conditions))
    .orderBy(desc(createdAtMs), desc(memoryUpdates.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const agentIds = [...new Set([agentId, ...page.map((row) => row.agentId)])];
  const agentRows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), inArray(agents.id, agentIds)));
  const agentNames = new Map(agentRows.map((row) => [row.id, row.name]));
  if (!agentNames.has(agentId)) throw new MemoryError(404, "Bot not found");

  const documentConditions: SQL[] = [];
  const documentKeys = new Set<string>();
  for (const row of page) {
    for (const change of row.changed) {
      const key = documentScopeKey(change.name, row.agentId);
      if (documentKeys.has(key)) continue;
      documentKeys.add(key);
      const condition =
        change.name === "notes"
          ? and(eq(memoryDocuments.name, change.name), eq(memoryDocuments.agentId, row.agentId))
          : and(eq(memoryDocuments.name, change.name), isNull(memoryDocuments.agentId));
      if (condition) documentConditions.push(condition);
    }
  }
  const documentRows = documentConditions.length
    ? await db
        .select({
          id: memoryDocuments.id,
          name: memoryDocuments.name,
          agentId: memoryDocuments.agentId,
          content: memoryDocuments.content,
          version: memoryDocuments.version,
        })
        .from(memoryDocuments)
        .where(and(eq(memoryDocuments.ownerId, ownerId), or(...documentConditions)))
    : [];
  const documents = new Map(
    documentRows.map((row) => [documentScopeKey(row.name, row.agentId ?? ""), row]),
  );

  const revisionConditions: SQL[] = [];
  const revisionsToRead = new Set<string>();
  for (const row of page) {
    for (const change of row.changed) {
      const document = documents.get(documentScopeKey(change.name, row.agentId));
      if (!document) continue;
      const versions = [
        change.toVersion,
        ...(change.fromVersion === 0 ? [] : [change.fromVersion]),
      ];
      for (const version of versions) {
        const key = revisionKey(document.id, version);
        if (revisionsToRead.has(key)) continue;
        revisionsToRead.add(key);
        const condition = and(
          eq(memoryRevisions.documentId, document.id),
          eq(memoryRevisions.version, version),
        );
        if (condition) revisionConditions.push(condition);
      }
    }
  }
  const revisionRows = revisionConditions.length
    ? await db
        .select({
          documentId: memoryRevisions.documentId,
          version: memoryRevisions.version,
          content: memoryRevisions.content,
        })
        .from(memoryRevisions)
        .where(or(...revisionConditions))
    : [];
  const revisions = new Map(
    revisionRows.map((row) => [revisionKey(row.documentId, row.version), row.content]),
  );

  const sourceRefs = page.flatMap((row) => row.sources);
  const sourceIds = [...new Set(sourceRefs.map((source) => source.conversationId))];
  const sourceRows = sourceIds.length
    ? await db
        .select({
          id: conversations.id,
          title: conversations.title,
          createdAt: conversations.createdAt,
        })
        .from(conversations)
        .where(and(eq(conversations.ownerId, ownerId), inArray(conversations.id, sourceIds)))
    : [];
  const sourceConversations = new Map(sourceRows.map((row) => [row.id, row]));

  const items: MemoryReview[] = page.flatMap((row) => {
    const agentName = agentNames.get(row.agentId);
    if (!agentName) return [];
    const changes: MemoryReviewChange[] = row.changed.map((change: MemoryUpdateChange) => {
      const document = documents.get(documentScopeKey(change.name, row.agentId));
      const before =
        change.fromVersion === 0
          ? ""
          : document
            ? (revisions.get(revisionKey(document.id, change.fromVersion)) ?? null)
            : null;
      const after = document
        ? (revisions.get(revisionKey(document.id, change.toVersion)) ?? null)
        : null;
      return {
        name: change.name,
        fromVersion: change.fromVersion,
        toVersion: change.toVersion,
        before,
        after,
        current: document?.version === change.toVersion,
      };
    });
    const sources = row.sources.flatMap((source) => {
      const conversation = sourceConversations.get(source.conversationId);
      return conversation
        ? [
            {
              conversationId: conversation.id,
              title: conversation.title,
              startedAt: conversation.createdAt.toISOString(),
            },
          ]
        : [];
    });
    return [
      {
        updateId: row.id,
        agentId: row.agentId,
        agentName,
        trigger: row.trigger,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
        sources,
        changes,
      },
    ];
  });
  const last = page.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

function notReviewable() {
  return new MemoryError(409, "This memory update can't be reviewed");
}

function notFound() {
  return new MemoryError(404, "Memory update not found");
}

function alreadyReviewed() {
  return new MemoryError(409, "This memory update was already reviewed");
}

async function lockReviewableUpdate(tx: Transaction, ownerId: string, updateId: string) {
  const [row] = await tx
    .select()
    .from(memoryUpdates)
    .where(and(eq(memoryUpdates.id, updateId), eq(memoryUpdates.ownerId, ownerId)))
    .for("update");
  if (!row) throw notFound();
  if (row.status !== "succeeded" || row.changed.length === 0) throw notReviewable();
  return row;
}

export async function keepMemoryReview(
  db: Database,
  ownerId: string,
  updateId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockMemoryOwner(tx, ownerId);
    const update = await lockReviewableUpdate(tx, ownerId, updateId);
    if (update.reviewedAt !== null) return;
    await tx
      .update(memoryUpdates)
      .set({ reviewedAt: sql`clock_timestamp()` })
      .where(eq(memoryUpdates.id, update.id));
  });
}

export async function undoMemoryReview(
  db: Database,
  ownerId: string,
  updateId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockMemoryOwner(tx, ownerId);
    const update = await lockReviewableUpdate(tx, ownerId, updateId);
    if (update.reviewedAt !== null) throw alreadyReviewed();

    const documentConditions = update.changed.map((change) =>
      change.name === "notes"
        ? and(eq(memoryDocuments.name, change.name), eq(memoryDocuments.agentId, update.agentId))
        : and(eq(memoryDocuments.name, change.name), isNull(memoryDocuments.agentId)),
    );
    const documentRows = await tx
      .select()
      .from(memoryDocuments)
      .where(and(eq(memoryDocuments.ownerId, ownerId), or(...documentConditions)))
      .for("update");
    const documents = new Map(
      documentRows.map((row) => [documentScopeKey(row.name, row.agentId ?? ""), row]),
    );
    const revisionConditions: SQL[] = [];
    for (const change of update.changed) {
      if (change.fromVersion === 0) continue;
      const document = documents.get(documentScopeKey(change.name, update.agentId));
      if (!document) continue;
      const condition = and(
        eq(memoryRevisions.documentId, document.id),
        eq(memoryRevisions.version, change.fromVersion),
      );
      if (condition) revisionConditions.push(condition);
    }
    const revisionRows = revisionConditions.length
      ? await tx
          .select({
            documentId: memoryRevisions.documentId,
            version: memoryRevisions.version,
            content: memoryRevisions.content,
          })
          .from(memoryRevisions)
          .where(or(...revisionConditions))
      : [];
    const previousContents = new Map(
      revisionRows.map((row) => [revisionKey(row.documentId, row.version), row.content]),
    );
    const restore: Array<{ change: MemoryUpdateChange; content: string }> = [];
    for (const change of update.changed) {
      const document = documents.get(documentScopeKey(change.name, update.agentId));
      if (!document || document.version !== change.toVersion) {
        throw new MemoryError(
          409,
          "Memory changed since this update; use History to restore an older version",
        );
      }
      const content =
        change.fromVersion === 0
          ? ""
          : previousContents.get(revisionKey(document.id, change.fromVersion));
      if (content === undefined) {
        throw new MemoryError(
          409,
          "Memory changed since this update; use History to restore an older version",
        );
      }
      restore.push({ change, content });
    }

    for (const item of restore) {
      await writeDocument(tx, {
        ownerId,
        agentId: update.agentId,
        name: item.change.name,
        content: item.content,
        expectedVersion: item.change.toVersion,
        author: "revert",
        updateId: null,
      });
    }
    await tx
      .update(memoryUpdates)
      .set({ reviewedAt: sql`clock_timestamp()` })
      .where(eq(memoryUpdates.id, update.id));
  });
}

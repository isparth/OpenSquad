import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentRuntimeProvider,
  RuntimeArtifact,
  RuntimeCredentials,
  StorageProvider,
} from "@opensquad/core";
import { conversationFiles, type Database, runtimeSessions } from "@opensquad/db";
import { eq } from "drizzle-orm";
import { conversationFileDto } from "./dto.js";
import { appendEvent, terminal } from "./persistence.js";
import { runtimeStore, withRun } from "./run-store.js";

const outputRoot = "/workspace/outputs";
const maxFileBytes = 25 * 1024 * 1024;
const maxRunBytes = 100 * 1024 * 1024;
const maxFilesPerRun = 20;
const contentTypes: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  html: "text/html",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export interface FileCollectionOptions {
  retryDelayMs?: number;
}

function stripControlCharacters(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(
        code <= 0x1f ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x061c ||
        (code >= 0x200e && code <= 0x200f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    })
    .join("");
}

function outputName(path: string): string | null {
  if (!path.startsWith(`${outputRoot}/`) || path.includes("\0") || path.split("/").includes(".."))
    return null;
  const relative = posix.relative(outputRoot, path);
  if (!relative || relative === "." || posix.isAbsolute(relative)) return null;
  const name = Array.from(stripControlCharacters(relative)).slice(0, 255).join("");
  return name || null;
}

function contentTypeFor(path: string): string {
  const extension = path.split("/").at(-1)?.split(".").at(-1)?.toLowerCase();
  return extension && Object.hasOwn(contentTypes, extension)
    ? (contentTypes[extension] as string)
    : "application/octet-stream";
}

function validArtifact(artifact: RuntimeArtifact): boolean {
  return (
    Number.isSafeInteger(artifact.sizeBytes) &&
    artifact.sizeBytes >= 0 &&
    Number.isFinite(new Date(artifact.createdAt).getTime())
  );
}

async function deleteObjects(storage: StorageProvider, keys: Set<string>, keep: Set<string>) {
  await Promise.all(
    [...keys]
      .filter((key) => !keep.has(key))
      .map(async (key) => {
        try {
          await storage.delete(key);
        } catch {}
      }),
  );
}

export async function collectRunFiles(
  db: Database,
  runtime: AgentRuntimeProvider,
  storage: StorageProvider,
  ownerId: string,
  runId: string,
  credentials: RuntimeCredentials,
  signal: AbortSignal,
  options: FileCollectionOptions = {},
): Promise<void> {
  const candidateKeys = new Set<string>();
  let persistedKeys = new Set<string>();
  try {
    if (signal.aborted || !runtime.features.artifacts) return;
    const { run, session } = await runtimeStore(db).get(ownerId, runId);
    if (
      signal.aborted ||
      run.active ||
      !terminal(run.status) ||
      !run.rootTurnId ||
      session.environment !== "hosted" ||
      !session.externalId ||
      session.provider !== runtime.name
    ) {
      return;
    }

    const rootTurnId = run.rootTurnId;
    const sessionRef = { provider: session.provider, externalId: session.externalId };
    const listTurnArtifacts = async () => {
      const found: RuntimeArtifact[] = [];
      for await (const artifact of runtime.listArtifacts(sessionRef, credentials, { signal })) {
        if (artifact.turnExternalId === rootTurnId) found.push(artifact);
      }
      return found.sort(
        (first, second) =>
          first.createdAt.localeCompare(second.createdAt) ||
          first.externalId.localeCompare(second.externalId),
      );
    };

    let artifacts = await listTurnArtifacts();
    if (signal.aborted) return;
    if (artifacts.length === 0) {
      try {
        await delay(options.retryDelayMs ?? 5_000, undefined, { signal });
      } catch {
        return;
      }
      if (signal.aborted) return;
      artifacts = await listTurnArtifacts();
    }
    if (signal.aborted || artifacts.length === 0) return;

    const existing = await db
      .select()
      .from(conversationFiles)
      .where(eq(conversationFiles.sessionId, session.id));
    const recorded = new Set(existing.map((file) => file.externalArtifactId));
    const runFiles = existing.filter((file) => file.runId === run.id);
    let fileCount = runFiles.length;
    let storedBytes = runFiles.reduce(
      (total, file) => total + (file.status === "stored" ? file.sizeBytes : 0),
      0,
    );
    const pending: (typeof conversationFiles.$inferInsert)[] = [];

    for (const artifact of artifacts) {
      if (signal.aborted) return;
      if (recorded.has(artifact.externalId)) continue;
      if (fileCount >= maxFilesPerRun) break;
      const name = outputName(artifact.path);
      if (!name || !validArtifact(artifact)) continue;
      fileCount++;
      recorded.add(artifact.externalId);

      const fileId = randomUUID();
      const contentType = contentTypeFor(artifact.path);
      let status: "stored" | "too_large" | "failed";
      let storageKey: string | null = null;
      let sizeBytes = artifact.sizeBytes;
      const remainingBytes = maxRunBytes - storedBytes;
      if (artifact.sizeBytes > maxFileBytes || artifact.sizeBytes > remainingBytes) {
        status = "too_large";
      } else {
        const key = `conversations/${run.conversationId}/files/${fileId}`;
        candidateKeys.add(key);
        const readLimit = Math.min(maxFileBytes, remainingBytes);
        try {
          const bytes = await runtime.readArtifact(sessionRef, artifact.externalId, credentials, {
            maxBytes: readLimit,
            signal,
          });
          if (signal.aborted) return;
          if (bytes.byteLength > readLimit) throw new Error("Artifact exceeds size limit");
          await storage.put(key, bytes, contentType);
          status = "stored";
          storageKey = key;
          sizeBytes = bytes.byteLength;
          storedBytes += bytes.byteLength;
        } catch {
          if (signal.aborted) return;
          status = "failed";
        }
      }
      pending.push({
        id: fileId,
        conversationId: run.conversationId,
        runId: run.id,
        sessionId: session.id,
        externalArtifactId: artifact.externalId,
        turnExternalId: artifact.turnExternalId,
        path: artifact.path,
        name,
        sizeBytes,
        contentType,
        storageKey,
        status,
        createdAt: new Date(artifact.createdAt),
      });
    }

    if (signal.aborted || pending.length === 0) return;
    const inserted = await withRun(db, ownerId, runId, async (tx, current) => {
      if (
        current.active ||
        !terminal(current.status) ||
        current.rootTurnId !== rootTurnId ||
        current.sessionId !== session.id
      ) {
        return [];
      }
      const [currentSession] = await tx
        .select()
        .from(runtimeSessions)
        .where(eq(runtimeSessions.id, current.sessionId));
      if (!currentSession) return [];
      if (
        currentSession.environment !== "hosted" ||
        currentSession.provider !== runtime.name ||
        currentSession.externalId !== session.externalId
      ) {
        return [];
      }
      const rows = await tx
        .insert(conversationFiles)
        .values(pending)
        .onConflictDoNothing()
        .returning();
      if (rows.length > 0) {
        await appendEvent(tx, current.conversationId, "files.updated", current.id, {
          runId: current.id,
          files: rows.map(conversationFileDto),
        });
      }
      return rows;
    });
    persistedKeys = new Set(inserted.flatMap((file) => (file.storageKey ? [file.storageKey] : [])));
  } catch {
  } finally {
    await deleteObjects(storage, candidateKeys, persistedKeys);
  }
}

import type {
  ConversationMessage,
  ConversationSummary,
  MemoryDocument,
  MemoryDocumentName,
  MemoryRevision,
  MemoryUpdate,
  MessageContentPart,
} from "@opensquad/core";

export interface AgentRecord {
  id: string;
  name: string;
  label: string | null;
  description: string;
  instructions: string;
  sandboxEnabled: boolean;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentInput = Pick<
  AgentRecord,
  "name" | "label" | "description" | "instructions" | "sandboxEnabled"
>;

function parseAgent(value: unknown): AgentRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid bot response");
  const row = value as Record<string, unknown>;
  for (const key of ["id", "name", "description", "instructions", "createdAt", "updatedAt"]) {
    if (typeof row[key] !== "string") throw new Error("Invalid bot response");
  }
  if (typeof row.sandboxEnabled !== "boolean") throw new Error("Invalid bot response");
  if (
    (row.label !== null && typeof row.label !== "string") ||
    (row.avatarUrl !== null && typeof row.avatarUrl !== "string")
  ) {
    throw new Error("Invalid bot response");
  }
  return value as AgentRecord;
}

export interface Health {
  ok: boolean;
  db: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function invalid(): never {
  throw new Error("Invalid conversation response");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseConversationSummary(value: unknown): ConversationSummary {
  if (!isRecord(value)) invalid();
  if (typeof value.id !== "string" || typeof value.createdAt !== "string") invalid();
  if (value.title !== null && typeof value.title !== "string") invalid();
  return { id: value.id, title: value.title, createdAt: value.createdAt };
}

function parseContentPart(value: unknown): MessageContentPart {
  if (!isRecord(value)) invalid();
  if (!Number.isInteger(value.index) || typeof value.completed !== "boolean") invalid();
  if (value.type === "text" && typeof value.text === "string") {
    return value as MessageContentPart;
  }
  if (value.type === "image" && typeof value.url === "string") {
    return value as MessageContentPart;
  }
  invalid();
}

function parseMessage(value: unknown): ConversationMessage {
  if (!isRecord(value)) invalid();
  for (const key of ["id", "conversationId", "participantId", "runId", "sequence", "createdAt"]) {
    if (typeof value[key] !== "string") invalid();
  }
  if (!/^\d+$/.test(value.sequence as string)) invalid();
  if (value.role !== "user" && value.role !== "assistant") invalid();
  if (!Array.isArray(value.content)) invalid();
  const content = value.content.map(parseContentPart);
  if (!["running", "completed", "incomplete"].includes(value.status as string)) invalid();
  if (value.phase !== null && value.phase !== "commentary" && value.phase !== "final") invalid();
  return { ...(value as object), content } as ConversationMessage;
}

function parsePage<T>(value: unknown, parseItem: (item: unknown) => T) {
  if (!isRecord(value) || !Array.isArray(value.items)) invalid();
  if (value.nextCursor !== null && typeof value.nextCursor !== "string") invalid();
  return {
    items: value.items.map(parseItem),
    nextCursor: value.nextCursor as string | null,
  };
}

function invalidMemory(): never {
  throw new Error("Invalid memory response");
}

function parseMemoryDocument(value: unknown): MemoryDocument {
  if (!isRecord(value)) invalidMemory();
  if (value.name !== "profile" && value.name !== "preferences" && value.name !== "notes")
    invalidMemory();
  if (value.scope !== "shared" && value.scope !== "agent") invalidMemory();
  if (typeof value.content !== "string") invalidMemory();
  if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 0)
    invalidMemory();
  if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit <= 0)
    invalidMemory();
  if (value.updatedAt !== null && typeof value.updatedAt !== "string") invalidMemory();
  return {
    name: value.name,
    scope: value.scope,
    content: value.content,
    version: value.version,
    limit: value.limit,
    updatedAt: value.updatedAt,
  };
}

function parseMemoryUpdate(value: unknown): MemoryUpdate {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "agentId",
      "trigger",
      "status",
      "changed",
      "errorCode",
      "usage",
      "createdAt",
      "finishedAt",
    ])
  )
    invalidMemory();
  if (typeof value.id !== "string" || typeof value.agentId !== "string") invalidMemory();
  if (value.trigger !== "auto" && value.trigger !== "manual") invalidMemory();
  if (value.status !== "running" && value.status !== "succeeded" && value.status !== "failed")
    invalidMemory();
  if (!Array.isArray(value.changed) || value.changed.length > 3) invalidMemory();
  const changed = value.changed.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, ["name", "fromVersion", "toVersion"]))
      invalidMemory();
    const name = item.name;
    const fromVersion = item.fromVersion;
    const toVersion = item.toVersion;
    if (name !== "profile" && name !== "preferences" && name !== "notes") invalidMemory();
    if (
      typeof fromVersion !== "number" ||
      !Number.isInteger(fromVersion) ||
      fromVersion < 0 ||
      typeof toVersion !== "number" ||
      !Number.isInteger(toVersion) ||
      toVersion < 1
    )
      invalidMemory();
    return {
      name: name as MemoryUpdate["changed"][number]["name"],
      fromVersion: fromVersion as number,
      toVersion: toVersion as number,
    };
  });
  if (value.errorCode !== null && typeof value.errorCode !== "string") invalidMemory();
  let usage: MemoryUpdate["usage"];
  if (value.usage === null) {
    usage = null;
  } else {
    if (
      !isRecord(value.usage) ||
      !hasExactKeys(value.usage, ["inputTokens", "outputTokens"]) ||
      typeof value.usage.inputTokens !== "number" ||
      !Number.isInteger(value.usage.inputTokens) ||
      value.usage.inputTokens < 0 ||
      typeof value.usage.outputTokens !== "number" ||
      !Number.isInteger(value.usage.outputTokens) ||
      value.usage.outputTokens < 0
    )
      invalidMemory();
    usage = {
      inputTokens: value.usage.inputTokens,
      outputTokens: value.usage.outputTokens,
    };
  }
  if (typeof value.createdAt !== "string") invalidMemory();
  if (value.finishedAt !== null && typeof value.finishedAt !== "string") invalidMemory();
  return {
    id: value.id,
    agentId: value.agentId,
    trigger: value.trigger,
    status: value.status,
    changed,
    errorCode: value.errorCode,
    usage,
    createdAt: value.createdAt,
    finishedAt: value.finishedAt,
  };
}

function parseMemoryRevision(value: unknown): MemoryRevision {
  if (!isRecord(value)) invalidMemory();
  if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1)
    invalidMemory();
  if (value.author !== "user" && value.author !== "extraction" && value.author !== "revert")
    invalidMemory();
  if (typeof value.content !== "string" || typeof value.createdAt !== "string") invalidMemory();
  return {
    version: value.version,
    author: value.author,
    content: value.content,
    createdAt: value.createdAt,
  };
}

/** Thin fetch wrapper for the OpenSquad API. Auth headers get added here once Clerk is wired in. */
export class ApiClient {
  private userId: Promise<string> | undefined;

  constructor(readonly baseUrl: string) {}

  getUserId(): Promise<string> {
    this.userId ??= this.get<unknown>("/me")
      .then((value) => {
        if (!isRecord(value) || typeof value.userId !== "string") {
          throw new Error("Invalid user response");
        }
        return value.userId;
      })
      .catch((error: unknown) => {
        this.userId = undefined;
        throw error;
      });
    return this.userId;
  }

  async listConversations(
    agentId: string,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<{ items: ConversationSummary[]; nextCursor: string | null }> {
    const path =
      `/conversations?agentId=${encodeURIComponent(agentId)}&limit=100` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    return parsePage(await this.get<unknown>(path, signal), parseConversationSummary);
  }

  async createConversation(agentId: string): Promise<{ conversation: ConversationSummary }> {
    const userId = await this.getUserId();
    const response = await this.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participants: [
          { kind: "user", refId: userId },
          { kind: "agent", refId: agentId },
        ],
      }),
    });
    const value: unknown = await response.json();
    if (!isRecord(value)) invalid();
    return { conversation: parseConversationSummary(value.conversation) };
  }

  async listMessages(
    conversationId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<{ items: ConversationMessage[]; nextCursor: string | null }> {
    const path =
      `/conversations/${encodeURIComponent(conversationId)}/messages?limit=50` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    return parsePage(await this.get<unknown>(path, signal), parseMessage);
  }

  async getMemory(
    agentId: string,
    signal?: AbortSignal,
  ): Promise<{
    documents: MemoryDocument[];
    autoUpdate: boolean;
    lastUpdate: MemoryUpdate | null;
  }> {
    const value: unknown = await this.get(`/agents/${encodeURIComponent(agentId)}/memory`, signal);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["documents", "autoUpdate", "lastUpdate"]) ||
      !Array.isArray(value.documents) ||
      typeof value.autoUpdate !== "boolean"
    )
      invalidMemory();
    const lastUpdate = value.lastUpdate === null ? null : parseMemoryUpdate(value.lastUpdate);
    return {
      documents: value.documents.map(parseMemoryDocument),
      autoUpdate: value.autoUpdate,
      lastUpdate,
    };
  }

  async setMemoryAutoUpdate(autoUpdate: boolean): Promise<boolean> {
    const response = await this.request("/memory/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoUpdate }),
    });
    const value: unknown = await response.json();
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["autoUpdate"]) ||
      typeof value.autoUpdate !== "boolean"
    )
      invalidMemory();
    return value.autoUpdate;
  }

  async saveMemory(
    agentId: string,
    name: MemoryDocumentName,
    content: string,
    expectedVersion: number,
  ): Promise<MemoryDocument> {
    const response = await this.request(
      `/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(name)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, expectedVersion }),
      },
    );
    const value: unknown = await response.json();
    if (!isRecord(value)) invalidMemory();
    return parseMemoryDocument(value.document);
  }

  async listMemoryRevisions(
    agentId: string,
    name: MemoryDocumentName,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<{ items: MemoryRevision[]; nextCursor: string | null }> {
    const path =
      `/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(name)}/revisions?limit=20` +
      (cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`);
    return parsePage(await this.get<unknown>(path, signal), parseMemoryRevision);
  }

  async revertMemory(
    agentId: string,
    name: MemoryDocumentName,
    version: number,
    expectedVersion: number,
  ): Promise<MemoryDocument> {
    const response = await this.request(
      `/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(name)}/revert`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version, expectedVersion }),
      },
    );
    const value: unknown = await response.json();
    if (!isRecord(value)) invalidMemory();
    return parseMemoryDocument(value.document);
  }

  async forgetMemory(): Promise<void> {
    await this.request("/memory", { method: "DELETE" });
  }

  health(): Promise<Health> {
    return this.get("/health");
  }

  async listAgents(signal?: AbortSignal): Promise<AgentRecord[]> {
    const rows = await this.get<unknown>("/agents", signal);
    if (!Array.isArray(rows)) throw new Error("Invalid bot list response");
    return rows.map(parseAgent);
  }

  async getAgent(id: string, signal?: AbortSignal): Promise<AgentRecord> {
    return parseAgent(await this.get(`/agents/${encodeURIComponent(id)}`, signal));
  }

  createAgent(input: AgentInput): Promise<AgentRecord> {
    return this.saveAgent("/agents", "POST", input);
  }

  updateAgent(id: string, input: Partial<AgentInput>): Promise<AgentRecord> {
    return this.saveAgent(`/agents/${encodeURIComponent(id)}`, "PATCH", input);
  }

  async deleteAgent(id: string): Promise<void> {
    await this.request(`/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async uploadAvatar(id: string, file: File): Promise<{ avatarUrl: string }> {
    const body = new FormData();
    body.append("avatar", file);
    const response = await this.request(`/agents/${encodeURIComponent(id)}/avatar`, {
      method: "POST",
      body,
    });
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      !("avatarUrl" in value) ||
      typeof value.avatarUrl !== "string"
    ) {
      throw new Error("Invalid avatar response");
    }
    return { avatarUrl: value.avatarUrl };
  }

  async getAvatar(agent: AgentRecord, signal: AbortSignal): Promise<Blob> {
    const prefix = `/agents/${encodeURIComponent(agent.id)}/avatar/`;
    if (
      !agent.avatarUrl?.startsWith(prefix) ||
      !/^[0-9a-f-]+\.(png|jpeg|webp)$/.test(agent.avatarUrl.slice(prefix.length))
    ) {
      throw new Error("Invalid avatar location");
    }
    const response = await this.request(agent.avatarUrl, { signal });
    if (!/^image\/(png|jpeg|webp)$/.test(response.headers.get("content-type") ?? ""))
      throw new Error("Invalid avatar type");
    return response.blob();
  }

  private async saveAgent(
    path: string,
    method: string,
    input: Partial<AgentInput>,
  ): Promise<AgentRecord> {
    const response = await this.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return parseAgent(await response.json());
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      redirect: "error",
    });
    if (!response.ok) throw new ApiError(response.status, `API returned status ${response.status}`);
    return response;
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await this.request(path, { signal: signal ?? null });
    return response.json() as Promise<T>;
  }
}

let cached: Promise<ApiClient> | undefined;

/** Resolves the API base URL from the main process once, then reuses the client. */
export function getApiClient(): Promise<ApiClient> {
  cached ??= window.opensquad.getApiBaseUrl().then((url) => new ApiClient(url));
  return cached;
}

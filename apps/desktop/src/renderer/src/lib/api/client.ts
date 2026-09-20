export interface AgentRecord {
  id: string;
  name: string;
  label: string | null;
  description: string;
  instructions: string;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentInput = Pick<AgentRecord, "name" | "label" | "description" | "instructions">;

function parseAgent(value: unknown): AgentRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid bot response");
  const row = value as Record<string, unknown>;
  for (const key of ["id", "name", "description", "instructions", "createdAt", "updatedAt"]) {
    if (typeof row[key] !== "string") throw new Error("Invalid bot response");
  }
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

/** Thin fetch wrapper for the OpenSquad API. Auth headers get added here once Clerk is wired in. */
export class ApiClient {
  constructor(private readonly baseUrl: string) {}

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

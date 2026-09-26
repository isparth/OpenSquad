import type { RuntimeMcpServer } from "./runtime.js";

/** The user's own tools-provider key. Passed explicitly to every operation, never stored in a provider. */
export interface ToolsCredentials {
  apiKey: string;
}

export interface Toolkit {
  slug: string;
  name: string;
  description: string;
  toolsCount: number;
}

/** `attention` covers expired, failed, inactive and disabled connections. */
export type ToolConnectionStatus = "active" | "pending" | "attention";

export interface ToolConnection {
  id: string;
  toolkit: string;
  status: ToolConnectionStatus;
  createdAt: string;
}

export type ToolAccess = "read" | "write";

/** A bot's saved access to one toolkit. The connected account is resolved live per conversation. */
export interface AgentToolGrant {
  toolkit: string;
  access: ToolAccess;
}

export interface ToolGrant {
  toolkit: string;
  access: ToolAccess;
  connectionId: string;
}

export interface ToolSession {
  externalId: string;
  mcpServer: RuntimeMcpServer;
  mcpHeaders: Record<string, string>;
}

export interface ToolsRequestOptions {
  signal?: AbortSignal;
}

export type ToolsErrorCode =
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "invalid_response"
  | "unavailable"
  | "policy_mismatch";

/** Provider-neutral failure with a static, safe message. Never carries provider text or keys. */
export class ToolsError extends Error {
  constructor(
    readonly code: ToolsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolsError";
  }
}

/** Tools capability. Default provider: Composio. */
export interface ToolsProvider {
  readonly name: string;
  listToolkits(
    credentials: ToolsCredentials,
    options: { search?: string; cursor?: string; limit?: number },
    request?: ToolsRequestOptions,
  ): Promise<{ items: Toolkit[]; nextCursor: string | null }>;
  listConnections(
    credentials: ToolsCredentials,
    userId: string,
    request?: ToolsRequestOptions,
  ): Promise<ToolConnection[]>;
  startConnection(
    credentials: ToolsCredentials,
    userId: string,
    toolkit: string,
    request?: ToolsRequestOptions,
  ): Promise<{ connectionId: string; redirectUrl: string }>;
  removeConnection(
    credentials: ToolsCredentials,
    userId: string,
    connectionId: string,
    request?: ToolsRequestOptions,
  ): Promise<void>;
  createSession(
    credentials: ToolsCredentials,
    userId: string,
    grants: ToolGrant[],
    request?: ToolsRequestOptions,
  ): Promise<ToolSession>;
}

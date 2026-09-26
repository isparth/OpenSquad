import {
  type ToolConnection,
  type ToolConnectionStatus,
  type ToolGrant,
  type Toolkit,
  type ToolSession,
  type ToolsCredentials,
  ToolsError,
  type ToolsErrorCode,
  type ToolsProvider,
  type ToolsRequestOptions,
} from "@opensquad/core";
import { z } from "zod";

const BASE_URL = "https://backend.composio.dev/api/v3.1";
const MCP_HOST = "backend.composio.dev";
const CONNECT_HOST = "connect.composio.dev";
const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CONNECTION_PAGES = 5;
const META_TOOLS = [
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
];
const READ_TAGS = { enable: ["readOnlyHint"], disable: ["destructiveHint"] };
const WRITE_TAGS = { disable: ["destructiveHint"] };

const TOOLKIT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CONNECTION_ID = /^ca_[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^trs_[A-Za-z0-9_-]{1,64}$/;

const MESSAGES: Record<ToolsErrorCode, string> = {
  unauthorized: "Composio rejected the key",
  not_found: "Composio resource not found",
  conflict: "Composio request conflict",
  rate_limited: "Composio rate limit reached",
  invalid_response: "Composio returned an invalid response",
  unavailable: "Composio is unavailable",
  policy_mismatch: "Composio session did not match the requested tool policy",
};

function fail(code: ToolsErrorCode): ToolsError {
  return new ToolsError(code, MESSAGES[code]);
}

function statusCode(status: number): ToolsErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  return "unavailable";
}

const toolkitsSchema = z.object({
  items: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      composio_managed_auth_schemes: z.array(z.string()).nullish(),
      meta: z
        .object({ description: z.string().nullish(), tools_count: z.number().nullish() })
        .nullish(),
    }),
  ),
  next_cursor: z.string().nullish(),
});

// Picks only safe fields. Composio items also carry `state` and `data`, which can hold tokens.
const connectionsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      toolkit: z.object({ slug: z.string() }),
      status: z.string(),
      is_disabled: z.boolean().nullish(),
      created_at: z.string(),
    }),
  ),
  next_cursor: z.string().nullish(),
});

const sessionIdSchema = z.object({ session_id: z.string().regex(SESSION_ID) });
const linkSchema = z.object({
  redirect_url: z.string(),
  connected_account_id: z.string().regex(CONNECTION_ID),
});
const tagsSchema = z.object({
  enabled: z.array(z.string()).optional(),
  disabled: z.array(z.string()).optional(),
});
const sessionEchoSchema = z.object({
  session_id: z.string().regex(SESSION_ID),
  mcp: z.object({ type: z.string(), url: z.string() }),
  tool_router_tools: z.array(z.string()),
  config: z.object({
    toolkits: z.object({ enabled: z.array(z.string()) }),
    tools: z.record(z.string(), z.object({ tags: tagsSchema.optional() })),
    connected_accounts: z.record(z.string(), z.array(z.string())),
    workbench: z.object({ enable: z.boolean() }),
    manage_connections: z.object({ enabled: z.boolean() }),
    premium_usage: z.boolean(),
  }),
});

function sameSet(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  if (!actual || actual.length !== expected.length) return false;
  const set = new Set(actual);
  return set.size === expected.length && expected.every((item) => set.has(item));
}

function connectionStatus(status: string, disabled: boolean): ToolConnectionStatus {
  if (disabled) return "attention";
  if (status === "ACTIVE") return "active";
  if (status === "INITIALIZING" || status === "INITIATED") return "pending";
  return "attention";
}

function assertKey(credentials: ToolsCredentials): string {
  if (typeof credentials?.apiKey !== "string" || !credentials.apiKey.trim()) {
    throw new Error("composio: An API key is required");
  }
  return credentials.apiKey;
}

function assertUser(userId: string): void {
  if (typeof userId !== "string" || !userId || userId.length > 256) {
    throw new Error("composio: Invalid user ID");
  }
}

function assertToolkit(toolkit: string): void {
  if (typeof toolkit !== "string" || !TOOLKIT_SLUG.test(toolkit)) {
    throw new Error("composio: Invalid toolkit");
  }
}

function assertConnection(connectionId: string): void {
  if (typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId)) {
    throw new Error("composio: Invalid connection ID");
  }
}

function isConnectLink(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === CONNECT_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
  );
}

function isSessionMcpUrl(value: string, sessionId: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === MCP_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname === `/tool_router/${sessionId}/mcp`
  );
}

interface RequestSpec {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Array<[string, string]>;
  body?: unknown;
}

/** Composio tools provider over REST v3.1. No SDK and no environment reads. */
export class ComposioProvider implements ToolsProvider {
  readonly name = "composio";
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  async listToolkits(
    credentials: ToolsCredentials,
    options: { search?: string; cursor?: string; limit?: number },
    request?: ToolsRequestOptions,
  ): Promise<{ items: Toolkit[]; nextCursor: string | null }> {
    const search = options.search?.trim() ?? "";
    if (search.length > 100) throw new Error("composio: Search is too long");
    if (
      options.cursor !== undefined &&
      (options.cursor.length === 0 || options.cursor.length > 512)
    )
      throw new Error("composio: Invalid cursor");
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20) || 20));
    const query: Array<[string, string]> = [
      ["limit", String(limit)],
      ["sort_by", "usage"],
    ];
    if (search) query.push(["search", search]);
    if (options.cursor) query.push(["cursor", options.cursor]);
    const body = await this.send(
      credentials,
      { method: "GET", path: "/toolkits", query },
      toolkitsSchema,
      request,
    );
    return {
      items: body.items
        .filter(
          (item) =>
            TOOLKIT_SLUG.test(item.slug) && (item.composio_managed_auth_schemes?.length ?? 0) > 0,
        )
        .map((item) => ({
          slug: item.slug,
          name: item.name.slice(0, 200),
          description: (item.meta?.description ?? "").slice(0, 500),
          toolsCount: Math.max(0, Math.trunc(item.meta?.tools_count ?? 0)),
        })),
      nextCursor: body.next_cursor || null,
    };
  }

  async listConnections(
    credentials: ToolsCredentials,
    userId: string,
    request?: ToolsRequestOptions,
  ): Promise<ToolConnection[]> {
    assertUser(userId);
    const result: ToolConnection[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_CONNECTION_PAGES; page++) {
      const query: Array<[string, string]> = [
        ["user_ids", userId],
        ["limit", "100"],
      ];
      if (cursor) query.push(["cursor", cursor]);
      const body = await this.send(
        credentials,
        { method: "GET", path: "/connected_accounts", query },
        connectionsSchema,
        request,
      );
      for (const item of body.items) {
        if (!CONNECTION_ID.test(item.id) || !TOOLKIT_SLUG.test(item.toolkit.slug)) continue;
        result.push({
          id: item.id,
          toolkit: item.toolkit.slug,
          status: connectionStatus(item.status, item.is_disabled === true),
          createdAt: item.created_at,
        });
      }
      cursor = body.next_cursor || null;
      if (!cursor) break;
    }
    return result;
  }

  async startConnection(
    credentials: ToolsCredentials,
    userId: string,
    toolkit: string,
    request?: ToolsRequestOptions,
  ): Promise<{ connectionId: string; redirectUrl: string }> {
    assertKey(credentials);
    assertUser(userId);
    assertToolkit(toolkit);
    const existing = await this.listConnections(credentials, userId, request);
    if (existing.some((item) => item.toolkit === toolkit && item.status === "active")) {
      throw fail("conflict");
    }
    const session = await this.send(
      credentials,
      {
        method: "POST",
        path: "/tool_router/session",
        body: {
          user_id: userId,
          toolkits: { enable: [toolkit] },
          manage_connections: { enable: false },
          workbench: { enable: false },
          premium_usage: false,
          search: { enable: false },
        },
      },
      sessionIdSchema,
      request,
    );
    const link = await this.send(
      credentials,
      {
        method: "POST",
        path: `/tool_router/session/${session.session_id}/link`,
        body: { toolkit },
      },
      linkSchema,
      request,
    );
    if (!isConnectLink(link.redirect_url)) throw fail("invalid_response");
    return { connectionId: link.connected_account_id, redirectUrl: link.redirect_url };
  }

  async removeConnection(
    credentials: ToolsCredentials,
    userId: string,
    connectionId: string,
    request?: ToolsRequestOptions,
  ): Promise<void> {
    assertKey(credentials);
    assertUser(userId);
    assertConnection(connectionId);
    const owned = await this.listConnections(credentials, userId, request);
    if (!owned.some((item) => item.id === connectionId)) throw fail("not_found");
    await this.send(
      credentials,
      { method: "DELETE", path: `/connected_accounts/${connectionId}` },
      null,
      request,
    );
  }

  async createSession(
    credentials: ToolsCredentials,
    userId: string,
    grants: ToolGrant[],
    request?: ToolsRequestOptions,
  ): Promise<ToolSession> {
    const apiKey = assertKey(credentials);
    assertUser(userId);
    if (!Array.isArray(grants) || grants.length === 0 || grants.length > 50) {
      throw new Error("composio: Grants are required");
    }
    for (const grant of grants) {
      assertToolkit(grant.toolkit);
      assertConnection(grant.connectionId);
      if (grant.access !== "read" && grant.access !== "write")
        throw new Error("composio: Invalid access");
    }
    const toolkits = grants.map((grant) => grant.toolkit);
    if (new Set(toolkits).size !== toolkits.length)
      throw new Error("composio: Duplicate toolkit grant");

    const raw = await this.send(
      credentials,
      {
        method: "POST",
        path: "/tool_router/session",
        body: {
          user_id: userId,
          toolkits: { enable: toolkits },
          tools: Object.fromEntries(
            grants.map((grant) => [
              grant.toolkit,
              { tags: grant.access === "read" ? READ_TAGS : WRITE_TAGS },
            ]),
          ),
          connected_accounts: Object.fromEntries(
            grants.map((grant) => [grant.toolkit, [grant.connectionId]]),
          ),
          manage_connections: { enable: false },
          workbench: { enable: false },
          premium_usage: false,
          search: { enable: true },
          execute: { enable_multi_execute: true },
        },
      },
      z.unknown(),
      request,
    );
    const created = sessionIdSchema.safeParse(raw);
    if (!created.success) throw fail("invalid_response");
    const sessionId = created.data.session_id;
    const echo = sessionEchoSchema.safeParse(raw);
    if (!echo.success || !this.matchesPolicy(echo.data, grants)) {
      await this.send(
        credentials,
        { method: "DELETE", path: `/tool_router/session/${sessionId}` },
        null,
        request,
      ).catch(() => {});
      throw fail("policy_mismatch");
    }
    return {
      externalId: sessionId,
      mcpServer: { name: "composio", url: echo.data.mcp.url, allowedTools: [...META_TOOLS] },
      mcpHeaders: { "x-api-key": apiKey },
    };
  }

  // Composio ignores unknown filter field names and then exposes every tool, so the echo is checked.
  private matchesPolicy(echo: z.infer<typeof sessionEchoSchema>, grants: ToolGrant[]): boolean {
    const toolkits = grants.map((grant) => grant.toolkit);
    const { config } = echo;
    if (!sameSet(config.toolkits.enabled, toolkits)) return false;
    if (!sameSet(Object.keys(config.tools), toolkits)) return false;
    if (!sameSet(Object.keys(config.connected_accounts), toolkits)) return false;
    for (const grant of grants) {
      const tags = config.tools[grant.toolkit]?.tags;
      if (!sameSet(tags?.disabled, ["destructiveHint"])) return false;
      if (!sameSet(config.connected_accounts[grant.toolkit], [grant.connectionId])) return false;
      if (grant.access === "read" && !sameSet(tags?.enabled, ["readOnlyHint"])) return false;
      if (grant.access === "write" && (tags?.enabled?.length ?? 0) > 0) return false;
    }
    return (
      config.workbench.enable === false &&
      config.manage_connections.enabled === false &&
      config.premium_usage === false &&
      sameSet(echo.tool_router_tools, META_TOOLS) &&
      echo.mcp.type === "http" &&
      isSessionMcpUrl(echo.mcp.url, echo.session_id)
    );
  }

  private async send<T>(
    credentials: ToolsCredentials,
    spec: RequestSpec,
    schema: z.ZodType<T> | null,
    request?: ToolsRequestOptions,
  ): Promise<T> {
    const apiKey = assertKey(credentials);
    const url = new URL(`${BASE_URL}${spec.path}`);
    for (const [name, value] of spec.query ?? []) url.searchParams.append(name, value);
    const headers: Record<string, string> = { accept: "application/json", "x-api-key": apiKey };
    if (spec.body !== undefined) headers["content-type"] = "application/json";
    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (request?.signal) signals.push(request.signal);
    let response: Response;
    try {
      response = await this.fetch(url.href, {
        method: spec.method,
        headers,
        ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
        redirect: "error",
        signal: AbortSignal.any(signals),
      });
    } catch {
      throw fail("unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw fail(statusCode(response.status));
    }
    const text = await readLimited(response);
    if (schema === null) return undefined as T;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw fail("invalid_response");
    }
    const result = schema.safeParse(parsed);
    if (!result.success) throw fail("invalid_response");
    return result.data;
  }
}

async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw fail("invalid_response");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw fail("invalid_response");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ToolsError) throw error;
    throw fail("unavailable");
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

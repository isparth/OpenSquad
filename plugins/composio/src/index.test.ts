import { type ToolGrant, ToolsError } from "@opensquad/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposioProvider } from "./index.js";

const KEY = "ak_test_secret_key";
const credentials = { apiKey: KEY };
const BASE = "https://backend.composio.dev/api/v3.1";
const SECRET_TEXT = "upstream says ak_test_secret_key is bad";

type Call = { url: URL; init: RequestInit };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stub(...responses: Array<Response | ((call: Call) => Response | Promise<Response>)>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: new URL(String(input)), init: init ?? {} };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return typeof next === "function" ? next(call) : next;
  });
  return {
    provider: new ComposioProvider({ fetch: fetch as typeof globalThis.fetch }),
    calls,
    fetch,
  };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "ca_github1",
    toolkit: { slug: "github" },
    auth_config: { id: "ac_1", auth_scheme: "OAUTH2", is_composio_managed: true },
    user_id: "dev-user",
    status: "ACTIVE",
    is_disabled: false,
    created_at: "2026-09-26T10:20:06.154Z",
    state: { authScheme: "OAUTH2", val: { status: "ACTIVE", access_token: "gho_supersecret" } },
    data: { access_token: "gho_supersecret", password: "hunter2" },
    ...overrides,
  };
}

function accounts(items: unknown[], next_cursor: string | null = null) {
  return json({ items, next_cursor, total_pages: 1, current_page: 1, total_items: items.length });
}

const META = ["COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"];
const READ_TAGS = { enabled: ["readOnlyHint"], disabled: ["destructiveHint"] };
const WRITE_TAGS = { disabled: ["destructiveHint"] };

function sessionEcho(
  overrides: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
) {
  return {
    session_id: "trs_abc123",
    mcp: { type: "http", url: "https://backend.composio.dev/tool_router/trs_abc123/mcp" },
    tool_router_tools: META,
    config: {
      user_id: "dev-user",
      toolkits: { enabled: ["github", "gmail"] },
      premium_usage: false,
      manage_connections: { enabled: false, enable_connection_removal: true },
      tools: { github: { tags: READ_TAGS }, gmail: { tags: WRITE_TAGS } },
      connected_accounts: { github: ["ca_github1"], gmail: ["ca_gmail1"] },
      workbench: { enable: false, proxy_execution_enabled: true },
      search: { enable: true },
      execute: { enable_multi_execute: true },
      ...config,
    },
    config_version: 1,
    warnings: [],
    ...overrides,
  };
}

const grants: ToolGrant[] = [
  { toolkit: "github", access: "read", connectionId: "ca_github1" },
  { toolkit: "gmail", access: "write", connectionId: "ca_gmail1" },
];

async function rejection(promise: Promise<unknown>): Promise<ToolsError> {
  const error = await promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ToolsError);
  return error as ToolsError;
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_BASE_URL;
});

describe("ComposioProvider transport", () => {
  it("sends only the explicit key and ignores ambient environment", async () => {
    process.env.COMPOSIO_API_KEY = "ak_ambient_should_not_be_used";
    process.env.COMPOSIO_BASE_URL = "https://evil.example";
    const { provider, calls } = stub(json({ items: [], next_cursor: null }));
    await provider.listToolkits(credentials, {});
    const [call] = calls;
    expect(`${call?.url.origin}${call?.url.pathname}`).toBe(`${BASE}/toolkits`);
    expect(call?.init.headers).toEqual({ accept: "application/json", "x-api-key": KEY });
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(call?.init)).not.toContain("ambient");
  });

  it("rejects blank keys without a request", async () => {
    const { provider, fetch } = stub();
    await expect(provider.listToolkits({ apiKey: " " }, {})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps HTTP errors to static messages without upstream text or key", async () => {
    const cases: Array<[number, ToolsError["code"]]> = [
      [401, "unauthorized"],
      [403, "unauthorized"],
      [404, "not_found"],
      [409, "conflict"],
      [429, "rate_limited"],
      [400, "unavailable"],
      [500, "unavailable"],
    ];
    for (const [status, code] of cases) {
      const { provider } = stub(json({ error: { message: SECRET_TEXT, code: status } }, status));
      const error = await rejection(provider.listToolkits(credentials, {}));
      expect(error.code).toBe(code);
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("upstream");
    }
  });

  it("maps network failures and timeouts to unavailable", async () => {
    const failing = new ComposioProvider({
      fetch: vi.fn().mockRejectedValue(new Error(SECRET_TEXT)) as typeof fetch,
    });
    const error = await rejection(failing.listToolkits(credentials, {}));
    expect(error.code).toBe("unavailable");
    expect(error.message).not.toContain(KEY);

    const hanging = new ComposioProvider({
      timeoutMs: 20,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        )) as typeof fetch,
    });
    expect((await rejection(hanging.listToolkits(credentials, {}))).code).toBe("unavailable");
  });

  it("honors the caller's abort signal", async () => {
    const controller = new AbortController();
    const provider = new ComposioProvider({
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          controller.abort();
        })) as typeof fetch,
    });
    const error = await rejection(
      provider.listToolkits(credentials, {}, { signal: controller.signal }),
    );
    expect(error.code).toBe("unavailable");
  });

  it("rejects oversized bodies, declared or streamed", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    const declared = stub(json({ items: [] }, 200, { "content-length": String(big.length) }));
    expect((await rejection(declared.provider.listToolkits(credentials, {}))).code).toBe(
      "invalid_response",
    );
    const streamed = stub(
      new Response(big, { status: 200, headers: { "content-type": "application/json" } }),
    );
    expect((await rejection(streamed.provider.listToolkits(credentials, {}))).code).toBe(
      "invalid_response",
    );
  });

  it("rejects unparseable responses", async () => {
    const { provider } = stub(
      new Response("not json", { headers: { "content-type": "application/json" } }),
    );
    expect((await rejection(provider.listToolkits(credentials, {}))).code).toBe("invalid_response");
    const shape = stub(json({ items: "nope" }));
    expect((await rejection(shape.provider.listToolkits(credentials, {}))).code).toBe(
      "invalid_response",
    );
  });
});

describe("listToolkits", () => {
  it("returns only connectable toolkits and clamps the query", async () => {
    const { provider, calls } = stub(
      json({
        items: [
          {
            slug: "github",
            name: "GitHub",
            type: "native",
            composio_managed_auth_schemes: ["OAUTH2"],
            meta: { description: "Code hosting", tools_count: 874, logo: "https://x" },
          },
          { slug: "custom", name: "Custom", composio_managed_auth_schemes: [], meta: {} },
          { slug: "noauth", name: "No auth", no_auth: true, meta: { description: "" } },
          { slug: "Bad Slug", name: "Bad", composio_managed_auth_schemes: ["OAUTH2"], meta: {} },
        ],
        next_cursor: "cur_2",
      }),
    );
    const result = await provider.listToolkits(credentials, {
      search: "  git ",
      cursor: "cur_1",
      limit: 500,
    });
    expect(result).toEqual({
      items: [{ slug: "github", name: "GitHub", description: "Code hosting", toolsCount: 874 }],
      nextCursor: "cur_2",
    });
    const params = calls[0]?.url.searchParams;
    expect(params?.get("search")).toBe("git");
    expect(params?.get("cursor")).toBe("cur_1");
    expect(params?.get("limit")).toBe("50");
    expect(params?.get("sort_by")).toBe("usage");
  });

  it("defaults the limit and rejects long searches", async () => {
    const { provider, calls, fetch } = stub(json({ items: [] }));
    expect(await provider.listToolkits(credentials, {})).toEqual({ items: [], nextCursor: null });
    expect(calls[0]?.url.searchParams.get("limit")).toBe("20");
    expect(calls[0]?.url.searchParams.has("search")).toBe(false);
    await expect(provider.listToolkits(credentials, { search: "x".repeat(101) })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("listConnections", () => {
  it("maps statuses and never copies token fields", async () => {
    const { provider, calls } = stub(
      accounts([
        account(),
        account({ id: "ca_pending", toolkit: { slug: "gmail" }, status: "INITIATED" }),
        account({ id: "ca_init", toolkit: { slug: "slack" }, status: "INITIALIZING" }),
        account({ id: "ca_expired", status: "EXPIRED" }),
        account({ id: "ca_failed", status: "FAILED" }),
        account({ id: "ca_disabled", status: "ACTIVE", is_disabled: true }),
        account({ id: "not-an-id" }),
      ]),
    );
    const result = await provider.listConnections(credentials, "dev-user");
    expect(result).toEqual([
      {
        id: "ca_github1",
        toolkit: "github",
        status: "active",
        createdAt: "2026-09-26T10:20:06.154Z",
      },
      {
        id: "ca_pending",
        toolkit: "gmail",
        status: "pending",
        createdAt: "2026-09-26T10:20:06.154Z",
      },
      { id: "ca_init", toolkit: "slack", status: "pending", createdAt: "2026-09-26T10:20:06.154Z" },
      {
        id: "ca_expired",
        toolkit: "github",
        status: "attention",
        createdAt: "2026-09-26T10:20:06.154Z",
      },
      {
        id: "ca_failed",
        toolkit: "github",
        status: "attention",
        createdAt: "2026-09-26T10:20:06.154Z",
      },
      {
        id: "ca_disabled",
        toolkit: "github",
        status: "attention",
        createdAt: "2026-09-26T10:20:06.154Z",
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const secret of ["gho_supersecret", "hunter2", "state", "auth_config", "user_id"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(calls[0]?.url.pathname).toBe("/api/v3.1/connected_accounts");
    expect(calls[0]?.url.searchParams.getAll("user_ids")).toEqual(["dev-user"]);
    expect(calls[0]?.url.searchParams.get("limit")).toBe("100");
  });

  it("follows cursors up to a page cap", async () => {
    const pages = Array.from({ length: 10 }, (_, index) =>
      accounts([account({ id: `ca_page${index}` })], `cursor${index}`),
    );
    const { provider, calls } = stub(...pages);
    const result = await provider.listConnections(credentials, "dev-user");
    expect(result).toHaveLength(5);
    expect(calls).toHaveLength(5);
    expect(calls[1]?.url.searchParams.get("cursor")).toBe("cursor0");
  });

  it("validates the user id", async () => {
    const { provider, fetch } = stub();
    await expect(provider.listConnections(credentials, "")).rejects.toThrow();
    await expect(provider.listConnections(credentials, "x".repeat(257))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("startConnection", () => {
  const link = {
    redirect_url: "https://connect.composio.dev/link/lk_abc",
    connected_account_id: "ca_new1",
  };

  it("creates a restricted session and returns the Connect Link", async () => {
    const { provider, calls } = stub(
      accounts([account({ toolkit: { slug: "gmail" } }), account({ status: "EXPIRED" })]),
      json({ session_id: "trs_link1", mcp: { type: "http", url: "https://x" } }, 201),
      json(link, 201),
    );
    expect(await provider.startConnection(credentials, "dev-user", "github")).toEqual({
      connectionId: "ca_new1",
      redirectUrl: "https://connect.composio.dev/link/lk_abc",
    });
    expect(calls[1]?.url.href).toBe(`${BASE}/tool_router/session`);
    expect(calls[1]?.init.method).toBe("POST");
    expect(calls[1]?.init.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": KEY,
    });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      user_id: "dev-user",
      toolkits: { enable: ["github"] },
      manage_connections: { enable: false },
      workbench: { enable: false },
      premium_usage: false,
      search: { enable: false },
    });
    expect(calls[2]?.url.href).toBe(`${BASE}/tool_router/session/trs_link1/link`);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ toolkit: "github" });
  });

  it("refuses when an active connection exists", async () => {
    const { provider, calls } = stub(accounts([account()]));
    expect(
      (await rejection(provider.startConnection(credentials, "dev-user", "github"))).code,
    ).toBe("conflict");
    expect(calls).toHaveLength(1);
  });

  it.each([
    "http://connect.composio.dev/link/lk_abc",
    "https://evil.example/link/lk_abc",
    "https://connect.composio.dev.evil.example/link",
    "https://user:pass@connect.composio.dev/link/lk_abc",
    "https://connect.composio.dev/link/lk_abc#x",
    "not a url",
  ])("rejects redirect URL %s", async (redirect_url) => {
    const { provider } = stub(
      accounts([]),
      json({ session_id: "trs_link1" }, 201),
      json({ ...link, redirect_url }, 201),
    );
    expect(
      (await rejection(provider.startConnection(credentials, "dev-user", "github"))).code,
    ).toBe("invalid_response");
  });

  it("validates toolkit slugs before any request", async () => {
    const { provider, fetch } = stub();
    for (const slug of ["", "GitHub", "../x", "a".repeat(65), "-x"]) {
      await expect(provider.startConnection(credentials, "dev-user", slug)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("removeConnection", () => {
  it("deletes an owned connection", async () => {
    const { provider, calls } = stub(accounts([account()]), json({ success: true }));
    await provider.removeConnection(credentials, "dev-user", "ca_github1");
    expect(calls[1]?.url.href).toBe(`${BASE}/connected_accounts/ca_github1`);
    expect(calls[1]?.init.method).toBe("DELETE");
    expect(calls[1]?.init.headers).toEqual({ accept: "application/json", "x-api-key": KEY });
  });

  it("cancels the unused delete response body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const { provider } = stub(accounts([account()]), new Response(body, { status: 200 }));
    await provider.removeConnection(credentials, "dev-user", "ca_github1");
    expect(cancel).toHaveBeenCalled();
  });

  it("refuses connections owned by someone else", async () => {
    const { provider, calls } = stub(accounts([account()]));
    expect(
      (await rejection(provider.removeConnection(credentials, "dev-user", "ca_other"))).code,
    ).toBe("not_found");
    expect(calls).toHaveLength(1);
  });

  it("validates connection ids", async () => {
    const { provider, fetch } = stub();
    await expect(provider.removeConnection(credentials, "dev-user", "ca_../x")).rejects.toThrow();
    await expect(provider.removeConnection(credentials, "dev-user", "github")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("createSession", () => {
  it("sends the exact policy body and returns the MCP server", async () => {
    const { provider, calls } = stub(json(sessionEcho(), 201));
    expect(await provider.createSession(credentials, "dev-user", grants)).toEqual({
      externalId: "trs_abc123",
      mcpServer: {
        name: "composio",
        url: "https://backend.composio.dev/tool_router/trs_abc123/mcp",
        allowedTools: [
          "COMPOSIO_SEARCH_TOOLS",
          "COMPOSIO_GET_TOOL_SCHEMAS",
          "COMPOSIO_MULTI_EXECUTE_TOOL",
        ],
      },
      mcpHeaders: { "x-api-key": KEY },
    });
    expect(calls[0]?.url.href).toBe(`${BASE}/tool_router/session`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      user_id: "dev-user",
      toolkits: { enable: ["github", "gmail"] },
      tools: {
        github: { tags: { enable: ["readOnlyHint"], disable: ["destructiveHint"] } },
        gmail: { tags: { disable: ["destructiveHint"] } },
      },
      connected_accounts: { github: ["ca_github1"], gmail: ["ca_gmail1"] },
      manage_connections: { enable: false },
      workbench: { enable: false },
      premium_usage: false,
      search: { enable: true },
      execute: { enable_multi_execute: true },
    });
  });

  it("accepts a write grant echoed with an empty enabled list", async () => {
    const { provider } = stub(
      json(
        sessionEcho(
          {},
          {
            toolkits: { enabled: ["gmail"] },
            tools: { gmail: { tags: { enabled: [], disabled: ["destructiveHint"] } } },
            connected_accounts: { gmail: ["ca_gmail1"] },
          },
        ),
        201,
      ),
    );
    await expect(
      provider.createSession(credentials, "dev-user", [grants[1] as ToolGrant]),
    ).resolves.toMatchObject({ externalId: "trs_abc123" });
  });

  const mismatches: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["tags echoed empty", {}, { tools: { github: { tags: {} }, gmail: { tags: WRITE_TAGS } } }],
    [
      "read echoed as write",
      {},
      { tools: { github: { tags: WRITE_TAGS }, gmail: { tags: WRITE_TAGS } } },
    ],
    ["missing tools entry", {}, { tools: { github: { tags: READ_TAGS } } }],
    [
      "extra tools entry",
      {},
      { tools: { github: { tags: READ_TAGS }, gmail: { tags: WRITE_TAGS }, slack: {} } },
    ],
    ["extra toolkit", {}, { toolkits: { enabled: ["github", "gmail", "slack"] } }],
    ["workbench on", {}, { workbench: { enable: true } }],
    ["manage connections on", {}, { manage_connections: { enabled: true } }],
    ["premium usage on", {}, { premium_usage: true }],
    ["extra router tool", { tool_router_tools: [...META, "GITHUB_DELETE_A_REPOSITORY"] }, {}],
    ["missing router tool", { tool_router_tools: META.slice(1) }, {}],
    [
      "wrong mcp host",
      { mcp: { type: "http", url: "https://evil.example/tool_router/trs_abc123/mcp" } },
      {},
    ],
    [
      "http mcp",
      { mcp: { type: "http", url: "http://backend.composio.dev/tool_router/trs_abc123/mcp" } },
      {},
    ],
    [
      "other session path",
      { mcp: { type: "http", url: "https://backend.composio.dev/tool_router/trs_other/mcp" } },
      {},
    ],
    [
      "mcp query",
      { mcp: { type: "http", url: "https://backend.composio.dev/tool_router/trs_abc123/mcp?x=1" } },
      {},
    ],
    [
      "mcp userinfo",
      { mcp: { type: "http", url: "https://u:p@backend.composio.dev/tool_router/trs_abc123/mcp" } },
      {},
    ],
    [
      "mcp type",
      { mcp: { type: "sse", url: "https://backend.composio.dev/tool_router/trs_abc123/mcp" } },
      {},
    ],
    ["missing config", { config: undefined }, {}],
    ["missing connected accounts", {}, { connected_accounts: undefined }],
    [
      "wrong connected account",
      {},
      { connected_accounts: { github: ["ca_other"], gmail: ["ca_gmail1"] } },
    ],
    [
      "extra connected account",
      {},
      { connected_accounts: { github: ["ca_github1", "ca_other"], gmail: ["ca_gmail1"] } },
    ],
    [
      "extra connected account toolkit",
      {},
      {
        connected_accounts: { github: ["ca_github1"], gmail: ["ca_gmail1"], slack: ["ca_slack1"] },
      },
    ],
    ["missing connected account toolkit", {}, { connected_accounts: { github: ["ca_github1"] } }],
  ];

  it.each(mismatches)("fails closed and deletes the session: %s", async (_name, top, config) => {
    const { provider, calls } = stub(json(sessionEcho(top, config), 201), json({ success: true }));
    const error = await rejection(provider.createSession(credentials, "dev-user", grants));
    expect(error.code).toBe("policy_mismatch");
    expect(calls[1]?.url.href).toBe(`${BASE}/tool_router/session/trs_abc123`);
    expect(calls[1]?.init.method).toBe("DELETE");
  });

  it("cleans up with its own signal after the caller aborts", async () => {
    const controller = new AbortController();
    const { provider, calls } = stub(
      () => {
        controller.abort();
        return json(sessionEcho({}, { workbench: { enable: true } }), 201);
      },
      json({ success: true }),
    );
    const error = await rejection(
      provider.createSession(credentials, "dev-user", grants, { signal: controller.signal }),
    );
    expect(error.code).toBe("policy_mismatch");
    expect(calls[1]?.init.method).toBe("DELETE");
    expect(calls[1]?.url.href).toBe(`${BASE}/tool_router/session/trs_abc123`);
    expect(calls[1]?.init.signal?.aborted).toBe(false);
  });

  it("still fails closed when cleanup fails", async () => {
    const { provider } = stub(
      json(sessionEcho({}, { workbench: { enable: true } }), 201),
      json({ error: {} }, 500),
    );
    expect((await rejection(provider.createSession(credentials, "dev-user", grants))).code).toBe(
      "policy_mismatch",
    );
  });

  it("validates grants before any request", async () => {
    const { provider, fetch } = stub();
    const invalid: ToolGrant[][] = [
      [],
      [grants[0] as ToolGrant, { ...(grants[0] as ToolGrant), access: "write" }],
      [{ toolkit: "GitHub", access: "read", connectionId: "ca_x" }],
      [{ toolkit: "github", access: "admin" as "read", connectionId: "ca_x" }],
      [{ toolkit: "github", access: "read", connectionId: "x" }],
    ];
    for (const value of invalid) {
      await expect(provider.createSession(credentials, "dev-user", value)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

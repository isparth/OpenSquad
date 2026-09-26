import { describe, expect, it, vi } from "vitest";
import type { RuntimeCredentialVault } from "../src/main/runtime-credentials.js";
import { createToolsCommands, type ToolsCommands } from "../src/main/tools-commands.js";

const ORIGIN = "http://localhost:3000";
const KEY = "ak_test_tools_key";
const LINK = "https://connect.composio.dev/link/lk_abc";
const toolkit = { slug: "github", name: "GitHub", description: "Code", toolsCount: 874 };
const connection = {
  id: "ca_github1",
  toolkit: "github",
  status: "active",
  createdAt: "2026-09-26T10:20:06.154Z",
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeVault(readKey: unknown = { ok: true, key: KEY }): RuntimeCredentialVault {
  return {
    origin: ORIGIN,
    status: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    readKey: vi.fn(async () => readKey),
  } as unknown as RuntimeCredentialVault;
}

function setup(
  responses: Array<Response | (() => Promise<Response>)>,
  options: {
    vault?: RuntimeCredentialVault;
    timeoutMs?: number;
    openExternal?: () => Promise<void>;
  } = {},
) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return typeof next === "function" ? next() : next;
  });
  const openExternal = vi.fn(options.openExternal ?? (async () => {}));
  const commands: ToolsCommands = createToolsCommands({
    vault: options.vault ?? makeVault(),
    fetch: fetchMock as unknown as typeof fetch,
    openExternal,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const calls = () => fetchMock.mock.calls as unknown as [string, RequestInit][];
  return { commands, fetchMock, openExternal, calls };
}

describe("request shape", () => {
  it("lists toolkits with a GET, the tools key and no redirects", async () => {
    const { commands, calls } = setup([jsonResponse({ items: [toolkit], nextCursor: "n1" })]);
    expect(await commands.listToolkits({ search: "git hub", cursor: "c1" })).toEqual({
      items: [toolkit],
      nextCursor: "n1",
    });
    const [url, init] = calls()[0] as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/tools/toolkits?search=git+hub&cursor=c1`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ "X-OpenSquad-Tools-Key": KEY });
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits empty query parameters", async () => {
    const { commands, calls } = setup([jsonResponse({ items: [], nextCursor: null })]);
    await commands.listToolkits({});
    expect(calls()[0]?.[0]).toBe(`${ORIGIN}/tools/toolkits`);
  });

  it("lists connections", async () => {
    const { commands, calls } = setup([jsonResponse({ items: [connection] })]);
    expect(await commands.listConnections()).toEqual({ items: [connection] });
    expect(calls()[0]?.[0]).toBe(`${ORIGIN}/tools/connections`);
  });

  it("starts a connection, opens the link in main and returns only the id", async () => {
    const { commands, calls, openExternal } = setup([
      jsonResponse({ connectionId: "ca_new1", redirectUrl: LINK }, 201),
    ]);
    const result = await commands.startConnection({ toolkit: "github" });
    expect(result).toEqual({ connectionId: "ca_new1" });
    expect(JSON.stringify(result)).not.toContain("connect.composio.dev");
    expect(openExternal).toHaveBeenCalledWith(LINK);
    const [url, init] = calls()[0] as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/tools/connections`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "X-OpenSquad-Tools-Key": KEY,
    });
    expect(JSON.parse(init.body as string)).toEqual({ toolkit: "github" });
  });

  it("removes a connection and accepts an empty 204", async () => {
    const { commands, calls } = setup([new Response(null, { status: 204 })]);
    await expect(
      commands.removeConnection({ connectionId: "ca_github1" }),
    ).resolves.toBeUndefined();
    const [url, init] = calls()[0] as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/tools/connections/ca_github1`);
    expect(init.method).toBe("DELETE");
    expect(init.headers).toEqual({ "X-OpenSquad-Tools-Key": KEY });
  });
});

describe("Connect Link validation", () => {
  it.each([
    "http://connect.composio.dev/link/lk_abc",
    "https://evil.example/link",
    "https://connect.composio.dev.evil.example/link",
    "https://user:pass@connect.composio.dev/link",
    "https://connect.composio.dev:8443/link",
    "https://connect.composio.dev/link/lk_abc#fragment",
    "javascript:alert(1)",
    "not a url",
  ])("never opens %s", async (redirectUrl) => {
    const { commands, openExternal } = setup([
      jsonResponse({ connectionId: "ca_new1", redirectUrl }, 201),
    ]);
    await expect(commands.startConnection({ toolkit: "github" })).rejects.toThrow(
      "invalid response",
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("reports a static error when the browser can't open", async () => {
    const { commands } = setup(
      [jsonResponse({ connectionId: "ca_new1", redirectUrl: LINK }, 201)],
      {
        openExternal: async () => {
          throw new Error(`failed ${LINK}`);
        },
      },
    );
    await expect(commands.startConnection({ toolkit: "github" })).rejects.toThrow(
      /^unable to open browser$/,
    );
  });
});

describe("validation and credentials", () => {
  it("rejects malformed commands before fetch", async () => {
    const { commands, fetchMock } = setup([]);
    await expect(commands.listToolkits({ search: "x".repeat(101) })).rejects.toThrow(
      "invalid request",
    );
    await expect(commands.startConnection({ toolkit: "GitHub" })).rejects.toThrow(
      "invalid request",
    );
    await expect(commands.removeConnection({ connectionId: "../x" })).rejects.toThrow(
      "invalid request",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails without a stored tools key", async () => {
    const { commands, fetchMock } = setup([], {
      vault: makeVault({ ok: false, reason: "not-configured" }),
    });
    await expect(commands.listConnections()).rejects.toThrow("tools credential unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("response handling", () => {
  it.each([
    [400, "request rejected"],
    [401, "authentication required"],
    [404, "resource not found"],
    [409, "request conflict"],
    [422, "tools key rejected"],
    [429, "rate limited"],
    [502, "service unavailable"],
  ])("maps %i to %s without leaking the body", async (status, message) => {
    const { commands } = setup([jsonResponse({ message: `upstream ${KEY}` }, status)]);
    const error = await commands.listConnections().catch((reason: Error) => reason);
    expect((error as Error).message).toBe(message);
  });

  it("rejects schema mismatches, including extra fields", async () => {
    for (const body of [
      { items: [{ ...connection, state: { token: "x" } }] },
      { items: [{ ...connection, status: "ACTIVE" }] },
      { items: [connection], extra: true },
    ]) {
      const { commands } = setup([jsonResponse(body)]);
      await expect(commands.listConnections()).rejects.toThrow("invalid response");
    }
  });

  it("rejects wrong content types and oversized bodies", async () => {
    const wrongType = setup([new Response("{}", { headers: { "content-type": "text/html" } })]);
    await expect(wrongType.commands.listConnections()).rejects.toThrow("invalid response");
    const big = setup([
      jsonResponse({ items: [] }, 200, { "content-length": String(2 * 1024 * 1024) }),
    ]);
    await expect(big.commands.listConnections()).rejects.toThrow("response too large");
  });

  it("times out and aborts", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init.signal?.aborted) reject(new Error("aborted"));
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const commands = createToolsCommands({
      vault: makeVault(),
      fetch: fetchMock as unknown as typeof fetch,
      openExternal: vi.fn(),
      timeoutMs: 20,
    });
    await expect(commands.listConnections()).rejects.toThrow("request timed out");
    const controller = new AbortController();
    const slow = createToolsCommands({
      vault: makeVault(),
      fetch: fetchMock as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    const pending = slow.listConnections(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("request aborted");
  });

  it("limits concurrent tools commands", async () => {
    const never = () => new Promise<Response>(() => {});
    const { commands } = setup([never, never, never, never]);
    for (let i = 0; i < 4; i += 1) commands.listConnections().catch(() => {});
    await Promise.resolve();
    await expect(commands.listConnections()).rejects.toThrow("too many active tools commands");
    commands.abortAll();
  });
});

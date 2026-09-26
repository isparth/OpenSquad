import { ToolsError, type ToolsErrorCode } from "@opensquad/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app.js";
import { FakeToolsProvider } from "./fakes.js";
import { createTestApp } from "./helpers.js";

const KEY = "ak_test_tools_key";
const headers = { "x-opensquad-tools-key": KEY };
const toolkit = { slug: "github", name: "GitHub", description: "Code", toolsCount: 874 };
const connection = {
  id: "ca_github1",
  toolkit: "github",
  status: "active" as const,
  createdAt: "2026-09-26T10:20:06.154Z",
};

describe("tools routes", () => {
  let app: App;
  let tools: FakeToolsProvider;

  beforeAll(async () => {
    tools = new FakeToolsProvider();
    app = await createTestApp({ capabilities: { tools } });
  });
  afterAll(() => app.close());
  beforeEach(() => vi.clearAllMocks());

  const routes = [
    { method: "GET" as const, url: "/tools/toolkits" },
    { method: "GET" as const, url: "/tools/connections" },
    { method: "POST" as const, url: "/tools/connections", payload: { toolkit: "github" } },
    { method: "DELETE" as const, url: "/tools/connections/ca_github1" },
  ];

  it.each(routes)("$method $url requires one tools key", async (route) => {
    for (const value of [undefined, "", "   ", "a,b", "x".repeat(4097)]) {
      const response = await app.inject({
        ...route,
        headers: value === undefined ? {} : { "x-opensquad-tools-key": value },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toBe("Provide one tools key in X-OpenSquad-Tools-Key");
    }
    for (const method of Object.values(tools)) {
      if (typeof method === "function" && "mock" in method) expect(method).not.toHaveBeenCalled();
    }
  });

  it("lists toolkits with search and cursor", async () => {
    tools.listToolkits.mockResolvedValueOnce({ items: [toolkit], nextCursor: "next" });
    const response = await app.inject({
      method: "GET",
      url: "/tools/toolkits?search=git&cursor=abc",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [toolkit], nextCursor: "next" });
    expect(tools.listToolkits).toHaveBeenCalledWith(
      { apiKey: KEY },
      { search: "git", cursor: "abc" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(response.body).not.toContain(KEY);
  });

  it("rejects overlong searches and unknown query fields", async () => {
    for (const url of [`/tools/toolkits?search=${"x".repeat(101)}`, "/tools/toolkits?limit=5"]) {
      expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(400);
    }
    expect(tools.listToolkits).not.toHaveBeenCalled();
  });

  it("lists the user's connections", async () => {
    tools.listConnections.mockResolvedValueOnce([connection]);
    const response = await app.inject({ method: "GET", url: "/tools/connections", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [connection] });
    expect(tools.listConnections).toHaveBeenCalledWith(
      { apiKey: KEY },
      "dev-user",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("starts a connection", async () => {
    const result = {
      connectionId: "ca_new1",
      redirectUrl: "https://connect.composio.dev/link/lk_1",
    };
    tools.startConnection.mockResolvedValueOnce(result);
    const response = await app.inject({
      method: "POST",
      url: "/tools/connections",
      headers,
      payload: { toolkit: "github" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(result);
    expect(tools.startConnection).toHaveBeenCalledWith(
      { apiKey: KEY },
      "dev-user",
      "github",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("validates connection input", async () => {
    for (const payload of [
      { toolkit: "GitHub" },
      { toolkit: "../x" },
      { toolkit: "github", x: 1 },
      {},
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/tools/connections",
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    for (const id of ["github", "ca_", "ca_a.b"]) {
      const response = await app.inject({
        method: "DELETE",
        url: `/tools/connections/${id}`,
        headers,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(tools.startConnection).not.toHaveBeenCalled();
    expect(tools.removeConnection).not.toHaveBeenCalled();
  });

  it("removes a connection", async () => {
    tools.removeConnection.mockResolvedValueOnce(undefined);
    const response = await app.inject({
      method: "DELETE",
      url: "/tools/connections/ca_github1",
      headers,
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(tools.removeConnection).toHaveBeenCalledWith(
      { apiKey: KEY },
      "dev-user",
      "ca_github1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  const errorCases: Array<[ToolsErrorCode, number, string | undefined]> = [
    ["unauthorized", 422, "tools_key_rejected"],
    ["not_found", 404, undefined],
    ["conflict", 409, undefined],
    ["rate_limited", 429, undefined],
    ["unavailable", 502, undefined],
    ["invalid_response", 502, undefined],
    ["policy_mismatch", 502, undefined],
  ];

  it.each(errorCases)("maps %s to %i with a static message", async (code, status, bodyCode) => {
    tools.listConnections.mockRejectedValueOnce(new ToolsError(code, `leak ${KEY} upstream`));
    const response = await app.inject({ method: "GET", url: "/tools/connections", headers });
    expect(response.statusCode).toBe(status);
    const body = response.json();
    if (bodyCode) expect(body.code).toBe(bodyCode);
    expect(response.body).not.toContain(KEY);
    expect(response.body).not.toContain("upstream");
  });

  it("hides unexpected provider errors", async () => {
    tools.listToolkits.mockRejectedValueOnce(new Error(`boom ${KEY}`));
    const response = await app.inject({ method: "GET", url: "/tools/toolkits", headers });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(KEY);
    expect(response.body).not.toContain("boom");
  });
});

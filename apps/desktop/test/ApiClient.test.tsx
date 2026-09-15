import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentRecord, ApiClient, ApiError } from "@/lib/api/client.js";

const agent: AgentRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test",
  label: null,
  description: "",
  instructions: "",
  avatarUrl: null,
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};
const api = new ApiClient("http://localhost:3000/");
beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("bot HTTP client", () => {
  it("lists, reads, creates and updates validated bot records", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify([agent])));
    expect(await api.listAgents()).toEqual([agent]);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(agent)));
    expect(await api.getAgent(agent.id)).toEqual(agent);
    const input = { name: "Test", label: null, description: "", instructions: "" };
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(agent)));
    await api.createAgent(input);
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:3000/agents",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input), redirect: "error" }),
    );
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(agent)));
    await api.updateAgent(agent.id, { label: null });
    expect(fetch).toHaveBeenLastCalledWith(
      `http://localhost:3000/agents/${agent.id}`,
      expect.objectContaining({ method: "PATCH", body: '{"label":null}' }),
    );
  });

  it("handles a bodyless 204 delete response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.deleteAgent(agent.id)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      `http://localhost:3000/agents/${agent.id}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("leaves multipart boundaries to fetch", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ avatarUrl: `/agents/${agent.id}/avatar/test.png` })),
    );
    const file = new File(["test"], "photo.png", { type: "image/png" });
    await api.uploadAvatar(agent.id, file);
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(init?.headers).toBeUndefined();
    if (!(init?.body instanceof FormData)) throw new Error("Expected multipart FormData");
    expect(init.body.get("avatar")).toBe(file);
  });

  it("does not fetch arbitrary avatar URLs and rejects wrong response types", async () => {
    const signal = new AbortController().signal;
    for (const avatarUrl of [
      "https://outside.example/image.png",
      "/agents/other/avatar/a.png",
      `/agents/${agent.id}/avatar/../../secret`,
    ]) {
      await expect(api.getAvatar({ ...agent, avatarUrl }, signal)).rejects.toThrow(
        "Invalid avatar location",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("<html>", { headers: { "content-type": "text/html" } }),
    );
    await expect(
      api.getAvatar({ ...agent, avatarUrl: `/agents/${agent.id}/avatar/abcd.png` }, signal),
    ).rejects.toThrow("Invalid avatar type");
  });

  it("keeps abort signals and private avatar bytes intact", async () => {
    const signal = new AbortController().signal;
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("image", { headers: { "content-type": "image/png" } }),
    );
    const blob = await api.getAvatar(
      { ...agent, avatarUrl: `/agents/${agent.id}/avatar/abcd.png` },
      signal,
    );
    expect(blob.size).toBe(5);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal, redirect: "error" }),
    );
  });

  it("rejects malformed records and preserves HTTP status without leaking response diagnostics", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: "missing-fields" }])),
    );
    await expect(api.listAgents()).rejects.toThrow("Invalid bot response");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("secret internal diagnostic", { status: 404 }),
    );
    await expect(api.getAgent(agent.id)).rejects.toEqual(
      new ApiError(404, "API returned status 404"),
    );
  });
});

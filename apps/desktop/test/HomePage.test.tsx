import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "@/features/home/HomePage.js";

function mockFetch(response: { ok: boolean; status: number; body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status,
      json: () => Promise.resolve(response.body),
    }),
  );
}

describe("HomePage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders hello world and reports the API as up", async () => {
    mockFetch({ ok: true, status: 200, body: { ok: true, db: "up" } });
    render(<HomePage />);
    expect(screen.getByRole("heading", { name: "Hello world" })).toBeInTheDocument();
    expect(await screen.findByText("API up")).toBeInTheDocument();
  });

  it("reports the API as down on a failed request", async () => {
    mockFetch({ ok: false, status: 503 });
    render(<HomePage />);
    expect(await screen.findByText(/API down: API returned status 503/)).toBeInTheDocument();
  });
});

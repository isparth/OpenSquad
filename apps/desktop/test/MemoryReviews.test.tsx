import type { MemoryReview } from "@opensquad/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryReviews } from "@/features/memory/MemoryReviews.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const otherAgentId = "22222222-2222-4222-8222-222222222222";
const createdAt = "2026-09-20T10:00:00.000Z";
const startedAt = "2026-09-19T10:00:00.000Z";

function review(overrides: Partial<MemoryReview> = {}): MemoryReview {
  return {
    updateId: "33333333-3333-4333-8333-333333333333",
    agentId: otherAgentId,
    agentName: "Research bot",
    trigger: "auto",
    createdAt,
    finishedAt: "2026-09-20T10:00:05.000Z",
    sources: [
      { conversationId: "44444444-4444-4444-8444-444444444444", title: "Planning", startedAt },
    ],
    changes: [
      {
        name: "profile",
        fromVersion: 0,
        toVersion: 1,
        before: "",
        after: "- Name: Test",
        current: true,
      },
    ],
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderReviews(props: Partial<Parameters<typeof MemoryReviews>[0]> = {}) {
  const onChanged = props.onChanged ?? vi.fn();
  return render(
    <MemoryReviews
      agentId={agentId}
      pendingCount={1}
      disabled={false}
      onChanged={onChanged}
      {...props}
    />,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(window.opensquad.getApiBaseUrl).mockResolvedValue("http://localhost:3000");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("memory reviews panel", () => {
  it("renders nothing and does not fetch when there are no pending reviews", () => {
    const { container } = renderReviews({ pendingCount: 0 });
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the other bot's shared-profile diff with accessible markers and source", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [review()], nextCursor: null }));
    renderReviews();

    expect(
      await screen.findByRole("heading", { name: "Changes to review (1)" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/From your conversation with Research bot ·/)).toBeInTheDocument();
    expect(
      screen.getByText(`Read: Planning (${new Date(startedAt).toLocaleDateString()})`),
    ).toBeInTheDocument();
    expect(screen.getByText("About you")).toBeInTheDocument();
    expect(screen.getByText("Shared with all your bots")).toBeInTheDocument();
    const added = document.querySelector<HTMLElement>(".memory-diff-line.added");
    if (!added) throw new Error("Expected an added diff line");
    expect(added.querySelector(".memory-diff-marker")).toHaveTextContent("+");
    expect(added.querySelector(".memory-diff-text")).toHaveTextContent("- Name: Test");
    expect(within(added).getByText("Added:", { selector: ".sr-only" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/agents/11111111-1111-4111-8111-111111111111/memory/reviews?limit=10",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("keeps a review, removes it, and notifies the panel", async () => {
    const onChanged = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [review()], nextCursor: null }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    renderReviews({ onChanged });

    await screen.findByText("Shared with all your bots");
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://localhost:3000/memory/updates/33333333-3333-4333-8333-333333333333/keep",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(screen.queryByText("Shared with all your bots")).not.toBeInTheDocument();
  });

  it("reloads reviews and explains a conflict when Undo returns 409", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [review()], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse({ message: "conflict" }, 409))
      .mockResolvedValueOnce(jsonResponse({ items: [review()], nextCursor: null }));
    renderReviews();

    await screen.findByText("Shared with all your bots");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Memory changed since this update. Use History to restore an older version.",
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "http://localhost:3000/agents/11111111-1111-4111-8111-111111111111/memory/reviews?limit=10",
    );
  });

  it("disables Undo when the current document has changed", async () => {
    const firstChange = review().changes[0];
    if (!firstChange) throw new Error("Expected a profile change");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [review({ changes: [{ ...firstChange, current: false }] })],
        nextCursor: null,
      }),
    );
    renderReviews();

    expect(
      await screen.findByText(
        "Changed since this update. Use History to restore an older version.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep" })).toBeEnabled();
  });

  it("appends the next review page without duplicating the first item", async () => {
    const second = review({
      updateId: "55555555-5555-4555-8555-555555555555",
      agentName: "Writing bot",
      changes: [
        {
          name: "notes",
          fromVersion: 0,
          toVersion: 1,
          before: "",
          after: "- Draft chapter",
          current: true,
        },
      ],
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [review()], nextCursor: "cursor-2" }))
      .mockResolvedValueOnce(jsonResponse({ items: [second], nextCursor: null }));
    renderReviews();

    expect(await screen.findByText("About you")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Notes for Writing bot")).toBeInTheDocument();
    expect(screen.getAllByText("About you")).toHaveLength(1);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://localhost:3000/agents/11111111-1111-4111-8111-111111111111/memory/reviews?limit=10&cursor=cursor-2",
    );
  });

  it("aborts an in-flight list request when unmounted", async () => {
    const request = { signal: null as AbortSignal | null };
    fetchMock.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
      request.signal = init?.signal ?? null;
      return new Promise<Response>(() => {});
    });
    const view = renderReviews();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(request.signal?.aborted).toBe(true);
  });

  it("aborts the previous list request when the viewed bot changes", async () => {
    const firstRequest = { signal: null as AbortSignal | null };
    fetchMock
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        firstRequest.signal = init?.signal ?? null;
        return new Promise<Response>(() => {});
      })
      .mockResolvedValueOnce(jsonResponse({ items: [review()], nextCursor: null }));
    const onChanged = vi.fn();
    const view = renderReviews({ onChanged });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.rerender(
      <MemoryReviews
        agentId={otherAgentId}
        pendingCount={1}
        disabled={false}
        onChanged={onChanged}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(firstRequest.signal?.aborted).toBe(true);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://localhost:3000/agents/22222222-2222-4222-8222-222222222222/memory/reviews?limit=10",
    );
  });
});

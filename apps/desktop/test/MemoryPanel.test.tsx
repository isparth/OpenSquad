import type { MemoryDocument, MemoryDocumentName, MemoryRevision } from "@opensquad/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryPanel } from "@/features/memory/MemoryPanel.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const updatedAt = "2026-09-15T00:00:00.000Z";
const startingContent = "Name: Parth";

function document(
  name: MemoryDocumentName,
  content: string,
  version: number,
  limit: number,
): MemoryDocument {
  return {
    name,
    scope: name === "notes" ? "agent" : "shared",
    content,
    version,
    limit,
    updatedAt: version ? updatedAt : null,
  };
}

function emptyDocuments(): MemoryDocument[] {
  return [
    document("profile", "", 0, 4000),
    document("preferences", "", 0, 2000),
    document("notes", "", 0, 4000),
  ];
}

let documents: MemoryDocument[];
let revisions: MemoryRevision[];
let fetchMock: ReturnType<typeof vi.fn>;
const panelUrl = `http://localhost:3000/agents/${agentId}/memory`;

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function urlOf(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function renderPanel(props: Partial<Parameters<typeof MemoryPanel>[0]> = {}) {
  const onBusyChange = props.onBusyChange ?? vi.fn();
  render(<MemoryPanel agentId={agentId} disabled={false} onBusyChange={onBusyChange} {...props} />);
  return { onBusyChange };
}

beforeEach(() => {
  documents = [
    document("profile", startingContent, 2, 4000),
    document("preferences", "", 0, 2000),
    document("notes", "", 0, 4000),
  ];
  revisions = [
    { version: 2, author: "user", content: startingContent, createdAt: updatedAt },
    { version: 1, author: "extraction", content: "Name: Old", createdAt: updatedAt },
  ];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(urlOf(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === panelUrl.slice("http://localhost:3000".length)) {
      return response({ documents });
    }
    if (method === "GET" && url.pathname.endsWith("/revisions")) {
      return response({ items: revisions, nextCursor: null });
    }
    if (method === "PATCH" && url.pathname.includes("/memory/")) {
      const name = url.pathname.split("/").at(-1) as MemoryDocumentName;
      const body = JSON.parse(String(init?.body)) as { content: string; expectedVersion: number };
      const current = documents.find((item) => item.name === name);
      if (!current) return response({ message: "missing" }, 404);
      const saved = { ...current, content: body.content, version: current.version + 1, updatedAt };
      documents = documents.map((item) => (item.name === name ? saved : item));
      revisions = [
        { version: saved.version, author: "user", content: saved.content, createdAt: updatedAt },
        ...revisions,
      ];
      return response({ document: saved });
    }
    if (method === "POST" && url.pathname.endsWith("/revert")) {
      const name = url.pathname.split("/").at(-2) as MemoryDocumentName;
      const body = JSON.parse(String(init?.body)) as { version: number; expectedVersion: number };
      const revision = revisions.find((item) => item.version === body.version);
      const current = documents.find((item) => item.name === name);
      if (!revision || !current) return response({ message: "missing" }, 404);
      const restored = {
        ...current,
        content: revision.content,
        version: current.version + 1,
        updatedAt,
      };
      documents = documents.map((item) => (item.name === name ? restored : item));
      revisions = [
        {
          version: restored.version,
          author: "revert",
          content: restored.content,
          createdAt: updatedAt,
        },
        ...revisions,
      ];
      return response({ document: restored });
    }
    if (method === "DELETE" && url.pathname === "/memory") {
      documents = emptyDocuments();
      revisions = [];
      return new Response(null, { status: 204 });
    }
    return response({ message: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("memory panel", () => {
  it("shows the three tabs and shared profile by default", async () => {
    renderPanel();
    const about = await screen.findByRole("tab", { name: "About you" });
    expect(about).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Preferences" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByRole("tab", { name: "Notes for this bot" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "About you" })).toHaveValue(startingContent);
    expect(screen.getByText("Shared with all your bots.")).toBeInTheDocument();
    expect(screen.getByText(`${startingContent.length} / 4000`)).toBeInTheDocument();
  });

  it("saves the current draft with its loaded version and clears dirty state", async () => {
    const { onBusyChange } = renderPanel();
    const textarea = await screen.findByRole("textbox", { name: "About you" });
    fireEvent.change(textarea, { target: { value: "New profile" } });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"));
    expect(textarea).toHaveValue("New profile");
    expect(save).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith(
      `${panelUrl}/profile`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ content: "New profile", expectedVersion: 2 }),
      }),
    );
    expect(onBusyChange).toHaveBeenNthCalledWith(1, true);
    expect(onBusyChange).toHaveBeenNthCalledWith(2, false);
  });

  it("blocks over-limit drafts and displays the excess count", async () => {
    renderPanel();
    const textarea = await screen.findByRole("textbox", { name: "About you" });
    fireEvent.change(textarea, { target: { value: "x".repeat(4001) } });
    expect(screen.getByText("Too long by 1 characters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("discards draft changes back to the loaded content", async () => {
    renderPanel();
    const textarea = await screen.findByRole("textbox", { name: "About you" });
    fireEvent.change(textarea, { target: { value: "Unsaved profile" } });
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(textarea).toHaveValue(startingContent);
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows a conflict alert with Reload when restoring a revision conflicts", async () => {
    renderPanel();
    await screen.findByRole("textbox", { name: "About you" });
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const oldRevision = await screen.findByText(/Version 1 · Updated from a conversation/);
    const oldItem = oldRevision.closest<HTMLElement>(".memory-revision");
    if (!oldItem) throw new Error("Expected revision item");
    fetchMock.mockResolvedValueOnce(response({ message: "conflict" }, 409));
    fireEvent.click(within(oldItem).getByRole("button", { name: "Restore" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This memory changed somewhere else. Reload to get the latest version; unsaved changes on this tab will be lost.",
    );
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("shows a conflict alert and reloads the latest document while clearing the draft", async () => {
    renderPanel();
    const textarea = await screen.findByRole("textbox", { name: "About you" });
    fireEvent.change(textarea, { target: { value: "Unsaved edit" } });
    fetchMock.mockResolvedValueOnce(response({ message: "conflict" }, 409));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "This memory changed somewhere else. Reload to get the latest version; unsaved changes on this tab will be lost.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "About you" })).toHaveValue(startingContent),
    );
    expect(fetchMock.mock.calls.filter(([input]) => urlOf(input).endsWith("/memory"))).toHaveLength(
      2,
    );
  });

  it("shows bot-only notes and saves them to the notes document", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("tab", { name: "Notes for this bot" }));
    expect(screen.getByText("Only this bot sees these notes.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Notes for this bot" }), {
      target: { value: "Project notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"));
    expect(fetchMock).toHaveBeenCalledWith(
      `${panelUrl}/notes`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ content: "Project notes", expectedVersion: 0 }),
      }),
    );
  });

  it("keeps drafts when switching tabs and supports ArrowRight selection", async () => {
    renderPanel();
    const about = await screen.findByRole("tab", { name: "About you" });
    const preferences = screen.getByRole("tab", { name: "Preferences" });
    fireEvent.change(screen.getByRole("textbox", { name: "About you" }), {
      target: { value: "Draft profile" },
    });
    fireEvent.click(preferences);
    expect(screen.getByRole("textbox", { name: "Preferences" })).toBeInTheDocument();
    fireEvent.keyDown(preferences, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Notes for this bot" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(about);
    expect(screen.getByRole("textbox", { name: "About you" })).toHaveValue("Draft profile");
  });

  it("shows revision history and restores a prior version", async () => {
    renderPanel();
    await screen.findByRole("textbox", { name: "About you" });
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const oldRevision = await screen.findByText(/Version 1 · Updated from a conversation/);
    expect(screen.getByText(/Version 2 · Edited by you/)).toBeInTheDocument();
    const oldItem = oldRevision.closest<HTMLElement>(".memory-revision");
    if (!oldItem) throw new Error("Expected revision item");
    fireEvent.click(within(oldItem).getByRole("button", { name: "View" }));
    expect(within(oldItem).getByText("Name: Old")).toHaveClass("preserve-text");
    fireEvent.click(within(oldItem).getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "About you" })).toHaveValue("Name: Old"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `${panelUrl}/profile/revert`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ version: 1, expectedVersion: 2 }),
      }),
    );
    expect(await screen.findByText(/Version 3 · Restored/)).toBeInTheDocument();
  });

  it("closes forget confirmation on Keep memory and forgets/refetches on confirm", async () => {
    renderPanel();
    await screen.findByRole("textbox", { name: "About you" });
    fireEvent.click(screen.getByRole("button", { name: "Forget everything" }));
    const dialog = screen.getByRole("dialog", { name: "Forget everything?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep memory" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => urlOf(input).endsWith("/memory") && init?.method === "DELETE",
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Forget everything" }));
    const confirmation = screen.getByRole("dialog", { name: "Forget everything?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Forget everything" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "About you" })).toHaveValue(""));
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/memory",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

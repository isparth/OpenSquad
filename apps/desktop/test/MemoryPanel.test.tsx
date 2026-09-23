import type {
  MemoryDocument,
  MemoryDocumentName,
  MemoryRevision,
  MemoryUpdate,
} from "@opensquad/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryPanel } from "@/features/memory/MemoryPanel.js";
import { RuntimeKeyProvider } from "@/features/runtime-key/RuntimeKeyContext.js";

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

function memoryUpdate(overrides: Partial<MemoryUpdate> = {}): MemoryUpdate {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    agentId,
    trigger: "auto",
    status: "running",
    changed: [],
    errorCode: null,
    usage: null,
    createdAt: updatedAt,
    finishedAt: null,
    ...overrides,
  };
}

let documents: MemoryDocument[];
let revisions: MemoryRevision[];
let autoUpdate: boolean;
let lastUpdate: MemoryUpdate | null;
let nextMemoryResponse: {
  documents: MemoryDocument[];
  autoUpdate: boolean;
  lastUpdate: MemoryUpdate | null;
} | null;
let memoryReads: number;
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
  const view = render(
    <RuntimeKeyProvider>
      <MemoryPanel agentId={agentId} disabled={false} onBusyChange={onBusyChange} {...props} />
    </RuntimeKeyProvider>,
  );
  return { onBusyChange, ...view };
}

function configureRuntimeKey() {
  vi.mocked(window.opensquad.getRuntimeKeyStatus).mockResolvedValue({ state: "configured" });
}

function updatesRegion() {
  return screen.getByRole("region", { name: "Automatic memory updates" });
}

async function flushMicrotasks() {
  await act(async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve();
  });
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
  autoUpdate = true;
  lastUpdate = null;
  nextMemoryResponse = null;
  memoryReads = 0;
  vi.mocked(window.opensquad.getRuntimeKeyStatus)
    .mockReset()
    .mockResolvedValue({ state: "unavailable", reason: "not-configured" });
  vi.mocked(window.opensquad.refreshMemory).mockReset().mockResolvedValue({ update: null });
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(urlOf(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === panelUrl.slice("http://localhost:3000".length)) {
      memoryReads++;
      if (memoryReads > 1 && nextMemoryResponse) return response(nextMemoryResponse);
      return response({ documents, autoUpdate, lastUpdate });
    }
    if (method === "PATCH" && url.pathname === "/memory/settings") {
      autoUpdate = (JSON.parse(String(init?.body)) as { autoUpdate: boolean }).autoUpdate;
      return response({ autoUpdate });
    }
    if (method === "GET" && url.pathname.endsWith("/revisions")) {
      return response({ items: revisions, nextCursor: null });
    }
    if (method === "PATCH" && url.pathname.includes("/memory/")) {
      const name = url.pathname.split("/").at(-1) as MemoryDocumentName;
      const body = JSON.parse(String(init?.body)) as { content: string; expectedVersion: number };
      const current = documents.find((item) => item.name === name);
      if (!current) return response({ message: "missing" }, 404);
      if (body.expectedVersion !== current.version) return response({ message: "conflict" }, 409);
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
  vi.useRealTimers();
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
    await waitFor(() =>
      expect(screen.getByText("Saved", { selector: ".memory-saved" })).toBeInTheDocument(),
    );
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
    await waitFor(() =>
      expect(screen.getByText("Saved", { selector: ".memory-saved" })).toBeInTheDocument(),
    );
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

  it("toggles automatic updates and rolls back on a settings error", async () => {
    renderPanel();
    const toggle = await screen.findByRole("switch", { name: "Update memory automatically" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/memory/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ autoUpdate: false }),
      }),
    );

    fetchMock.mockResolvedValueOnce(response({ message: "failure" }, 500));
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("API returned status 500");
    expect(toggle).not.toBeChecked();
  });

  it("disables manual updates and shows a hint without a runtime key", async () => {
    renderPanel();
    const button = await screen.findByRole("button", { name: "Update now" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Add your OpenAI key to update memory.")).toBeInTheDocument();
  });

  it("reports no new sources when manual refresh returns null", async () => {
    configureRuntimeKey();
    vi.mocked(window.opensquad.refreshMemory).mockResolvedValueOnce({ update: null });
    renderPanel();
    const button = await screen.findByRole("button", { name: "Update now" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(
      await screen.findByText("Nothing new to read. Memory is up to date."),
    ).toBeInTheDocument();
    expect(window.opensquad.refreshMemory).toHaveBeenCalledWith({ agentId });
  });

  it("shows the rate-limit message when manual refresh is rejected", async () => {
    configureRuntimeKey();
    vi.mocked(window.opensquad.refreshMemory).mockRejectedValueOnce(new Error("rate limited"));
    renderPanel();
    const button = await screen.findByRole("button", { name: "Update now" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many memory updates this hour. Try again later.",
    );
  });

  it("polls a started update, shows its changed labels, and updates the editor", async () => {
    configureRuntimeKey();
    const running = memoryUpdate();
    const finished = memoryUpdate({
      status: "succeeded",
      changed: [{ name: "profile", fromVersion: 2, toVersion: 3 }],
      usage: { inputTokens: 10, outputTokens: 5 },
      finishedAt: updatedAt,
    });
    vi.mocked(window.opensquad.refreshMemory).mockResolvedValueOnce({ update: running });
    nextMemoryResponse = {
      documents: [document("profile", "- Name: Test", 3, 4000), ...documents.slice(1)],
      autoUpdate: true,
      lastUpdate: finished,
    };
    renderPanel();
    await screen.findByRole("textbox", { name: "About you" });
    const button = screen.getByRole("button", { name: "Update now" });
    await waitFor(() => expect(button).toBeEnabled());
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(button);
      for (let index = 0; index < 10; index++) await Promise.resolve();
    });
    expect(within(updatesRegion()).getByRole("status")).toHaveTextContent(
      "Updating memory from your recent conversations…",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(within(updatesRegion()).getByRole("status")).toHaveTextContent(
      `Updated ${new Date(updatedAt).toLocaleString()}: About you. · 15 tokens`,
    );
    expect(screen.getByRole("textbox", { name: "About you" })).toHaveValue("- Name: Test");
  });

  it("keeps a stale draft base version through extraction and exposes the conflict path", async () => {
    configureRuntimeKey();
    const running = memoryUpdate();
    const finished = memoryUpdate({
      status: "succeeded",
      changed: [{ name: "profile", fromVersion: 2, toVersion: 3 }],
      finishedAt: updatedAt,
    });
    vi.mocked(window.opensquad.refreshMemory).mockResolvedValueOnce({ update: running });
    const extractedDocuments = [
      document("profile", "Extracted profile", 3, 4000),
      ...documents.slice(1),
    ];
    const extractedRevisions = [
      {
        version: 3,
        author: "extraction" as const,
        content: "Extracted profile",
        createdAt: updatedAt,
      },
      ...revisions,
    ];
    renderPanel();
    const editor = await screen.findByRole("textbox", { name: "About you" });
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await screen.findByText(/Version 2 · Edited by you/);
    fireEvent.change(editor, { target: { value: "My draft before refresh" } });
    documents = extractedDocuments;
    revisions = extractedRevisions;
    nextMemoryResponse = { documents: extractedDocuments, autoUpdate: true, lastUpdate: finished };
    const button = screen.getByRole("button", { name: "Update now" });
    await waitFor(() => expect(button).toBeEnabled());
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(button);
      for (let index = 0; index < 10; index++) await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      for (let index = 0; index < 10; index++) await Promise.resolve();
    });
    expect(editor).toHaveValue("My draft before refresh");
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        new URL(urlOf(input)).pathname.endsWith("/revisions"),
      ),
    ).toHaveLength(2);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      for (let index = 0; index < 10; index++) await Promise.resolve();
    });
    const saveCall = fetchMock.mock.calls.find(
      ([input, init]) => urlOf(input) === `${panelUrl}/profile` && init?.method === "PATCH",
    );
    expect(JSON.parse(String(saveCall?.[1]?.body)).expectedVersion).toBe(2);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This memory changed somewhere else. Reload to get the latest version; unsaved changes on this tab will be lost.",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `${panelUrl}/profile`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ content: "My draft before refresh", expectedVersion: 2 }),
      }),
    );
  });

  it("polls when opened with a running update", async () => {
    lastUpdate = memoryUpdate();
    nextMemoryResponse = {
      documents: [document("profile", "Updated on open", 3, 4000), ...documents.slice(1)],
      autoUpdate: true,
      lastUpdate: memoryUpdate({
        status: "succeeded",
        changed: [{ name: "profile", fromVersion: 2, toVersion: 3 }],
        finishedAt: updatedAt,
      }),
    };
    vi.useFakeTimers();
    renderPanel();
    await flushMicrotasks();
    expect(within(updatesRegion()).getByRole("status")).toHaveTextContent(
      "Updating memory from your recent conversations…",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByRole("textbox", { name: "About you" })).toHaveValue("Updated on open");
  });

  it("does not poll after unmount", async () => {
    lastUpdate = memoryUpdate();
    vi.useFakeTimers();
    const view = renderPanel();
    await flushMicrotasks();
    expect(memoryReads).toBe(1);
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(memoryReads).toBe(1);
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

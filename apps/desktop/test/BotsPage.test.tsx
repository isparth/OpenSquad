import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotsPage } from "@/features/agents/BotsPage.js";
import { RuntimeKeyProvider } from "@/features/runtime-key/RuntimeKeyContext.js";
import { type AgentRecord, ApiError } from "@/lib/api/client.js";

const api = vi.hoisted(() => ({
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  uploadAvatar: vi.fn(),
  getAvatar: vi.fn(),
  getMemory: vi.fn(),
  listConversations: vi.fn(),
}));
vi.mock("@/lib/api/client.js", async (original) => ({
  ...(await original<typeof import("@/lib/api/client.js")>()),
  getApiClient: async () => api,
}));
const alice: AgentRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Alice",
  label: "Research",
  description: "Find reliable sources.",
  instructions: "Cite your sources.",
  avatarUrl: null,
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  api.listAgents.mockResolvedValue([alice]);
  api.getAgent.mockResolvedValue(alice);
  api.getMemory.mockResolvedValue([
    { name: "profile", scope: "shared", content: "", version: 0, limit: 4000, updatedAt: null },
    {
      name: "preferences",
      scope: "shared",
      content: "",
      version: 0,
      limit: 2000,
      updatedAt: null,
    },
    { name: "notes", scope: "agent", content: "", version: 0, limit: 4000, updatedAt: null },
  ]);
  api.listConversations.mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(window.opensquad.getRuntimeKeyStatus).mockResolvedValue({
    state: "unavailable",
    reason: "not-configured",
  });
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn().mockReturnValue("blob:test-avatar"),
      revokeObjectURL: vi.fn(),
    }),
  );
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

async function openAlice() {
  render(
    <RuntimeKeyProvider>
      <BotsPage />
    </RuntimeKeyProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Alice Research/ }));
  return screen.findByRole("heading", { name: "Alice" });
}

async function openAliceProfile() {
  await openAlice();
  fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
  return screen.findByTestId("agent-details");
}

describe("bot management", () => {
  it("opens the chat when a bot is clicked", async () => {
    await openAlice();
    expect(screen.getByRole("button", { name: "Profile" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Conversations" })).toBeInTheDocument();
    expect(api.getAgent).toHaveBeenCalledWith(alice.id, expect.any(AbortSignal));
  });

  it("navigates from chat to the profile and settings", async () => {
    await openAlice();
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(await screen.findByTestId("agent-details")).toBeInTheDocument();
    expect(screen.getByText("Find reliable sources.")).toBeInTheDocument();
    expect(screen.getByText("Cite your sources.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Memory" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Edit bot" })).toBeInTheDocument();
  });

  it("renders no label text for a bot without a label", async () => {
    const bob = { ...alice, id: "22222222-2222-4222-8222-222222222222", name: "Bob", label: null };
    api.listAgents.mockResolvedValue([alice, bob]);
    render(
      <RuntimeKeyProvider>
        <BotsPage />
      </RuntimeKeyProvider>,
    );
    const bobButton = await screen.findByRole("button", { name: "Bob" });
    expect(bobButton).toHaveAccessibleName("Bob");
    expect(screen.queryByText("No label")).not.toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();
  });

  it("shows an actionable empty state", async () => {
    api.listAgents.mockResolvedValue([]);
    render(
      <RuntimeKeyProvider>
        <BotsPage />
      </RuntimeKeyProvider>,
    );
    expect(await screen.findByText("No bots yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New bot" })).toBeEnabled();
  });

  it("creates a bot and opens its saved details", async () => {
    const bob = { ...alice, id: "22222222-2222-4222-8222-222222222222", name: "Bob", label: null };
    api.createAgent.mockResolvedValue(bob);
    api.getAgent.mockResolvedValue(bob);
    render(
      <RuntimeKeyProvider>
        <BotsPage />
      </RuntimeKeyProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "New bot" }));
    fireEvent.change(screen.getByLabelText("Bot name"), { target: { value: "Bob" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "A helpful bot" } });
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    expect(await screen.findByRole("heading", { name: "Bob" })).toBeInTheDocument();
    expect(api.createAgent).toHaveBeenCalledWith({
      name: "Bob",
      label: null,
      description: "A helpful bot",
      instructions: "",
    });
  });

  it("prefills the edit form and persists changed fields", async () => {
    await openAliceProfile();
    api.updateAgent.mockResolvedValue({ ...alice, name: "Alice updated" });
    fireEvent.click(screen.getByRole("button", { name: "Edit bot" }));
    expect(screen.getByLabelText("Bot name")).toHaveValue("Alice");
    expect(screen.getByLabelText("Label (optional)")).toHaveValue("Research");
    expect(screen.getByLabelText("Instructions")).toHaveValue("Cite your sources.");
    fireEvent.change(screen.getByLabelText("Bot name"), { target: { value: "Alice updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(api.updateAgent).toHaveBeenCalledWith(alice.id, {
        name: "Alice updated",
        label: "Research",
        description: "Find reliable sources.",
        instructions: "Cite your sources.",
      }),
    );
  });

  it("preserves form values on save failure and blocks duplicate submits while pending", async () => {
    let rejectSave: (error: Error) => void = () => {};
    api.createAgent.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      }),
    );
    render(
      <RuntimeKeyProvider>
        <BotsPage />
      </RuntimeKeyProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "New bot" }));
    fireEvent.change(screen.getByLabelText("Bot name"), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New bot" })).toBeDisabled();
    rejectSave(new Error("Could not save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
    expect(screen.getByLabelText("Bot name")).toHaveValue("Draft");
    expect(api.createAgent).toHaveBeenCalledTimes(1);
  });

  it("shows a not-found state when the selected bot disappears", async () => {
    api.getAgent.mockRejectedValue(new ApiError(404, "Not found"));
    render(
      <RuntimeKeyProvider>
        <BotsPage />
      </RuntimeKeyProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Alice Research/ }));
    expect(await screen.findByRole("heading", { name: "Bot not found" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit bot" })).not.toBeInTheDocument();
  });

  it("requires confirmation to delete and preserves the bot on failure", async () => {
    await openAliceProfile();
    fireEvent.click(screen.getByRole("button", { name: "Delete bot" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Alice?" });
    expect(api.deleteAgent).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep bot" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete bot" }));
    api.deleteAgent.mockRejectedValueOnce(new Error("Could not delete"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete bot" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not delete");
    api.deleteAgent.mockResolvedValueOnce(undefined);
    api.listAgents.mockResolvedValue([]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete bot" }));
    expect(await screen.findByText("No bots yet")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("previews and uploads avatars and revokes the preview URL", async () => {
    await openAliceProfile();
    const file = new File(["test-image"], "avatar.png", { type: "image/png" });
    api.uploadAvatar.mockResolvedValue({ avatarUrl: `/agents/${alice.id}/avatar/test.png` });
    fireEvent.change(screen.getByLabelText("Avatar image"), { target: { files: [file] } });
    expect(await screen.findByAltText("Avatar preview")).toHaveAttribute("src", "blob:test-avatar");
    fireEvent.click(screen.getByRole("button", { name: "Upload avatar" }));
    await waitFor(() => expect(api.uploadAvatar).toHaveBeenCalledWith(alice.id, file));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-avatar"));
  });

  it("rejects unsupported avatar files without making a request", async () => {
    await openAliceProfile();
    fireEvent.change(screen.getByLabelText("Avatar image"), {
      target: { files: [new File(["<svg/>"], "avatar.svg", { type: "image/svg+xml" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("PNG, JPEG or WebP");
    expect(api.uploadAvatar).not.toHaveBeenCalled();
  });

  it("shows list failures and supports retry", async () => {
    api.listAgents.mockRejectedValueOnce(new Error("API unavailable"));
    render(
      <RuntimeKeyProvider>
        <BotsPage />
      </RuntimeKeyProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("API unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: /Alice Research/ })).toBeInTheDocument();
  });
});

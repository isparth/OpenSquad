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
  sandboxEnabled: false,
  toolGrants: [],
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
  vi.mocked(window.opensquad.listToolConnections).mockResolvedValue({ items: [] });
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
    const sandboxStatus = screen.getByText(
      "Off. This bot chats without a sandbox. Turn it on in Edit bot.",
    );
    expect(sandboxStatus).toHaveClass("muted");
    expect(screen.getByRole("heading", { name: "Memory" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Edit bot" })).toBeInTheDocument();
  });

  it("shows the enabled sandbox details for a bot", async () => {
    api.getAgent.mockResolvedValue({ ...alice, sandboxEnabled: true });
    await openAliceProfile();
    expect(
      screen.getByText(
        "On. New conversations get an OpenAI-hosted sandbox for running code and working with files.",
      ),
    ).toBeInTheDocument();
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
    expect(screen.getByRole("switch", { name: "Sandbox" })).not.toBeChecked();
    expect(
      screen.getByText(
        "Lets this bot run code and work with files in an OpenAI-hosted sandbox. Off by default, and it may add cost on your OpenAI account. Changes apply to new conversations.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    expect(await screen.findByRole("heading", { name: "Bob" })).toBeInTheDocument();
    expect(api.createAgent).toHaveBeenCalledWith({
      name: "Bob",
      label: null,
      description: "A helpful bot",
      instructions: "",
      sandboxEnabled: false,
      toolGrants: [],
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
    fireEvent.click(screen.getByRole("switch", { name: "Sandbox" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(api.updateAgent).toHaveBeenCalledWith(alice.id, {
        name: "Alice updated",
        label: "Research",
        description: "Find reliable sources.",
        instructions: "Cite your sources.",
        sandboxEnabled: true,
        toolGrants: [],
      }),
    );
  });

  it("turns sandbox off when editing an enabled bot", async () => {
    const enabled = { ...alice, sandboxEnabled: true };
    api.getAgent.mockResolvedValue(enabled);
    await openAliceProfile();
    api.updateAgent.mockResolvedValue({ ...enabled, sandboxEnabled: false });
    fireEvent.click(screen.getByRole("button", { name: "Edit bot" }));
    const sandbox = screen.getByRole("switch", { name: "Sandbox" });
    expect(sandbox).toBeChecked();
    fireEvent.click(sandbox);
    expect(sandbox).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(api.updateAgent).toHaveBeenCalledWith(alice.id, {
        name: "Alice",
        label: "Research",
        description: "Find reliable sources.",
        instructions: "Cite your sources.",
        sandboxEnabled: false,
        toolGrants: [],
      }),
    );
  });

  it("shows no apps in bot details, or each granted app with its access", async () => {
    await openAliceProfile();
    const apps = screen.getByRole("heading", { name: "Apps" }).parentElement as HTMLElement;
    expect(within(apps).getByText("None")).toHaveClass("muted");
    cleanup();
    api.getAgent.mockResolvedValue({
      ...alice,
      toolGrants: [
        { toolkit: "github", access: "read" },
        { toolkit: "gmail", access: "write" },
      ],
    });
    await openAliceProfile();
    const granted = screen.getByRole("heading", { name: "Apps" }).parentElement as HTMLElement;
    expect(within(granted).getByText("github — Read")).toBeInTheDocument();
    expect(within(granted).getByText("gmail — Read and write")).toBeInTheDocument();
  });

  it("sets app access per connected app and saves only enabled apps", async () => {
    const connection = (id: string, toolkit: string, status = "active") => ({
      id,
      toolkit,
      status,
      createdAt: "2026-09-20T00:00:00.000Z",
    });
    vi.mocked(window.opensquad.listToolConnections).mockResolvedValue({
      items: [
        connection("ca_1", "github"),
        connection("ca_2", "github"),
        connection("ca_3", "slack"),
        connection("ca_4", "notion", "pending"),
      ],
    } as never);
    api.getAgent.mockResolvedValue({
      ...alice,
      toolGrants: [
        { toolkit: "github", access: "read" },
        { toolkit: "linear", access: "write" },
      ],
    });
    await openAliceProfile();
    api.updateAgent.mockResolvedValue(alice);
    fireEvent.click(screen.getByRole("button", { name: "Edit bot" }));
    const github = await screen.findByRole("combobox", { name: "Access for github" });
    const slack = screen.getByRole("combobox", { name: "Access for slack" });
    const linear = screen.getByRole("combobox", { name: "Access for linear" });
    expect(screen.getAllByRole("combobox", { name: /^Access for / })).toHaveLength(3);
    expect(screen.queryByRole("combobox", { name: "Access for notion" })).not.toBeInTheDocument();
    expect(github).toHaveValue("read");
    expect(slack).toHaveValue("off");
    expect(linear).toHaveValue("write");
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Changes apply to new conversations.")).toHaveClass("muted");
    const warning =
      "This bot can create and change things in these apps without asking you first. Actions Composio marks as destructive, like deleting, are always blocked.";
    expect(screen.getByText(warning)).toBeInTheDocument();
    fireEvent.change(linear, { target: { value: "off" } });
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Access for linear" })).not.toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    fireEvent.change(slack, { target: { value: "write" } });
    expect(screen.getByText(warning)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(api.updateAgent).toHaveBeenCalledWith(
        alice.id,
        expect.objectContaining({
          toolGrants: [
            { toolkit: "github", access: "read" },
            { toolkit: "slack", access: "write" },
          ],
        }),
      ),
    );
  });

  it.each([
    [
      new Error("tools credential unavailable"),
      "Add your Composio key in Tools to see connected apps.",
    ],
    [null, "Connect apps in Tools first."],
    [new Error("service unavailable"), "Couldn't load connected apps."],
  ])("explains why no apps are listed (%#)", async (failure, copy) => {
    if (failure) vi.mocked(window.opensquad.listToolConnections).mockRejectedValue(failure);
    render(
      <RuntimeKeyProvider>
        <BotsPage />
      </RuntimeKeyProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New bot" }));
    expect(await screen.findByText(copy)).toHaveClass("muted");
    expect(screen.queryByRole("combobox", { name: /^Access for / })).not.toBeInTheDocument();
    expect(screen.queryByText("Changes apply to new conversations.")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Bot name"), { target: { value: "Bob" } });
    api.createAgent.mockResolvedValue(alice);
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await waitFor(() =>
      expect(api.createAgent).toHaveBeenCalledWith(expect.objectContaining({ toolGrants: [] })),
    );
  });

  it("keeps granted apps editable without a tools key and asks for the key", async () => {
    vi.mocked(window.opensquad.listToolConnections).mockRejectedValue(
      new Error("tools credential unavailable"),
    );
    api.getAgent.mockResolvedValue({
      ...alice,
      toolGrants: [{ toolkit: "github", access: "read" }],
    });
    await openAliceProfile();
    fireEvent.click(screen.getByRole("button", { name: "Edit bot" }));
    expect(
      await screen.findByText("Add your Composio key in Tools to see connected apps."),
    ).toHaveClass("muted");
    expect(screen.getByRole("combobox", { name: "Access for github" })).toHaveValue("read");
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.queryByText("Connect apps in Tools first.")).not.toBeInTheDocument();
    expect(screen.getByText("Changes apply to new conversations.")).toBeInTheDocument();
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

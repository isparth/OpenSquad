import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App.js";
import { ToolsDialog } from "@/features/tools/ToolsDialog.js";
import type { ToolConnectionsResult } from "../src/shared/ipc.js";

const bridge = vi.mocked(window.opensquad);
const github = { slug: "github", name: "GitHub", description: "Code hosting", toolsCount: 874 };
const gmail = { slug: "gmail", name: "Gmail", description: "Email", toolsCount: 60 };
const connected = (status: "active" | "pending" | "attention", id = "ca_github1") => ({
  id,
  toolkit: "github",
  status,
  createdAt: "2026-09-26T10:20:06.154Z",
});

function renderDialog(props: Partial<Parameters<typeof ToolsDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onStatusChange = vi.fn();
  const view = render(
    <ToolsDialog
      onClose={onClose}
      onStatusChange={onStatusChange}
      searchDelayMs={10}
      pollIntervalMs={10}
      pollTimeoutMs={1_000}
      {...props}
    />,
  );
  return { onClose, onStatusChange, ...view };
}

const sleep = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  bridge.getToolsKeyStatus.mockResolvedValue({ state: "configured" });
  bridge.listToolConnections.mockResolvedValue({ items: [] });
  bridge.listToolkits.mockResolvedValue({ items: [github, gmail], nextCursor: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("tools dialog", () => {
  it("saves and removes the Composio key without showing it again", async () => {
    bridge.getToolsKeyStatus.mockResolvedValue({ state: "unavailable", reason: "not-configured" });
    const { onStatusChange } = renderDialog();
    expect(await screen.findByText("No Composio key saved.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connected apps" })).toBeNull();
    const input = screen.getByLabelText("Composio key");
    fireEvent.change(input, { target: { value: "  ak_test  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bridge.setToolsKey).toHaveBeenCalledWith("ak_test"));
    expect(input).toHaveValue("");
    expect(await screen.findByText("A Composio key is saved on this device.")).toBeInTheDocument();
    expect(onStatusChange).toHaveBeenLastCalledWith({ state: "configured" });
    expect(await screen.findByRole("heading", { name: "Connected apps" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(bridge.deleteToolsKey).toHaveBeenCalled());
    expect(await screen.findByText("No Composio key saved.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connected apps" })).toBeNull();
  });

  it("lists connected apps with status and date", async () => {
    bridge.listToolConnections.mockResolvedValue({
      items: [
        connected("active"),
        { ...connected("pending", "ca_gmail1"), toolkit: "gmail" },
        { ...connected("attention", "ca_slack1"), toolkit: "slack" },
      ],
    });
    renderDialog();
    const list = await screen.findByRole("list", { name: "Connected apps" });
    await waitFor(() => expect(within(list).getByText("GitHub")).toBeInTheDocument());
    expect(within(list).getByText("Connected")).toBeInTheDocument();
    expect(within(list).queryByText("Waiting for approval")).toBeNull();
    expect(within(list).queryByText("Gmail")).toBeNull();
    expect(within(list).getByText("Needs reconnecting")).toBeInTheDocument();
    expect(within(list).getByText("slack")).toBeInTheDocument();
    expect(
      within(list).getAllByText(new Date("2026-09-26T10:20:06.154Z").toLocaleDateString(), {
        exact: false,
      }),
    ).toHaveLength(2);
  });

  it("shows a pending connection only while it is being connected", async () => {
    bridge.startToolConnection.mockResolvedValue({ connectionId: "ca_new1" });
    bridge.listToolConnections.mockResolvedValue({
      items: [connected("pending", "ca_old1"), connected("pending", "ca_new1")],
    });
    renderDialog();
    const results = await screen.findByRole("list", { name: "Available apps" });
    expect(screen.queryByText("Waiting for approval")).toBeNull();
    fireEvent.click(within(results).getByRole("button", { name: "Connect GitHub" }));
    const list = await screen.findByRole("list", { name: "Connected apps" });
    await waitFor(() => expect(within(list).getAllByText("Waiting for approval")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Waiting for approval")).toBeNull());
  });

  it("shows the empty state", async () => {
    renderDialog();
    expect(await screen.findByText("No apps connected yet.")).toBeInTheDocument();
  });

  it("debounces searches", async () => {
    renderDialog({ searchDelayMs: 50 });
    await screen.findByRole("list", { name: "Available apps" });
    bridge.listToolkits.mockClear();
    const search = screen.getByLabelText("Search apps");
    for (const value of ["g", "gm", "gma"]) fireEvent.change(search, { target: { value } });
    await waitFor(() => expect(bridge.listToolkits).toHaveBeenCalledTimes(1));
    expect(bridge.listToolkits).toHaveBeenCalledWith({ search: "gma" });
    await sleep(80);
    expect(bridge.listToolkits).toHaveBeenCalledTimes(1);
  });

  it("marks already connected apps", async () => {
    bridge.listToolConnections.mockResolvedValue({ items: [connected("active")] });
    renderDialog();
    const results = await screen.findByRole("list", { name: "Available apps" });
    await waitFor(() =>
      expect(within(results).getByRole("button", { name: "Connected" })).toBeDisabled(),
    );
    expect(within(results).getByRole("button", { name: "Connect Gmail" })).toBeEnabled();
  });

  it("connects, polls until active, then stops polling", async () => {
    bridge.startToolConnection.mockResolvedValue({ connectionId: "ca_new1" });
    const responses: ToolConnectionsResult[] = [
      { items: [] },
      { items: [] },
      { items: [{ ...connected("pending", "ca_new1") }] },
      { items: [{ ...connected("active", "ca_new1") }] },
    ];
    bridge.listToolConnections.mockImplementation(
      async () => responses.shift() ?? { items: [connected("active", "ca_new1")] },
    );
    renderDialog();
    const results = await screen.findByRole("list", { name: "Available apps" });
    fireEvent.click(within(results).getByRole("button", { name: "Connect GitHub" }));
    await waitFor(() =>
      expect(bridge.startToolConnection).toHaveBeenCalledWith({ toolkit: "github" }),
    );
    expect(await screen.findByText("Finish connecting in your browser…")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Finish connecting in your browser…")).toBeNull(),
    );
    const list = screen.getByRole("list", { name: "Connected apps" });
    expect(within(list).getByText("Connected")).toBeInTheDocument();
    const calls = bridge.listToolConnections.mock.calls.length;
    await sleep(50);
    expect(bridge.listToolConnections.mock.calls.length).toBe(calls);
  });

  it("stops polling when cancelled", async () => {
    bridge.startToolConnection.mockResolvedValue({ connectionId: "ca_new1" });
    renderDialog();
    const results = await screen.findByRole("list", { name: "Available apps" });
    fireEvent.click(within(results).getByRole("button", { name: "Connect GitHub" }));
    await screen.findByText("Finish connecting in your browser…");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const calls = bridge.listToolConnections.mock.calls.length;
    await sleep(50);
    expect(bridge.listToolConnections.mock.calls.length).toBe(calls);
  });

  it("stops polling when closed", async () => {
    bridge.startToolConnection.mockResolvedValue({ connectionId: "ca_new1" });
    const { unmount } = renderDialog();
    const results = await screen.findByRole("list", { name: "Available apps" });
    fireEvent.click(within(results).getByRole("button", { name: "Connect GitHub" }));
    await screen.findByText("Finish connecting in your browser…");
    await sleep(25);
    unmount();
    const calls = bridge.listToolConnections.mock.calls.length;
    await sleep(50);
    expect(bridge.listToolConnections.mock.calls.length).toBe(calls);
  });

  it.each([
    ["tools credential unavailable", "tools credential unavailable"],
    [
      "tools key rejected",
      "Composio rejected this key. Check it's a project key (starts with ak_).",
    ],
  ])("stops polling when a poll fails with %s", async (message, copy) => {
    bridge.startToolConnection.mockResolvedValue({ connectionId: "ca_new1" });
    bridge.listToolConnections
      .mockResolvedValueOnce({ items: [] })
      .mockRejectedValue(new Error(message));
    renderDialog();
    const results = await screen.findByRole("list", { name: "Available apps" });
    fireEvent.click(within(results).getByRole("button", { name: "Connect GitHub" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
    expect(screen.queryByText("Finish connecting in your browser…")).toBeNull();
    const calls = bridge.listToolConnections.mock.calls.length;
    await sleep(50);
    expect(bridge.listToolConnections.mock.calls.length).toBe(calls);
  });

  it("keeps polling silently through other poll errors", async () => {
    bridge.startToolConnection.mockResolvedValue({ connectionId: "ca_new1" });
    bridge.listToolConnections
      .mockResolvedValueOnce({ items: [] })
      .mockRejectedValueOnce(new Error("service unavailable"))
      .mockResolvedValue({ items: [connected("active", "ca_new1")] });
    renderDialog();
    const results = await screen.findByRole("list", { name: "Available apps" });
    fireEvent.click(within(results).getByRole("button", { name: "Connect GitHub" }));
    await screen.findByText("Finish connecting in your browser…");
    await waitFor(() =>
      expect(screen.queryByText("Finish connecting in your browser…")).toBeNull(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(bridge.listToolConnections.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("gives up polling after the timeout", async () => {
    bridge.startToolConnection.mockResolvedValue({ connectionId: "ca_new1" });
    renderDialog({ pollTimeoutMs: 40 });
    const results = await screen.findByRole("list", { name: "Available apps" });
    fireEvent.click(within(results).getByRole("button", { name: "Connect GitHub" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connecting took too long. Try again.",
    );
    const calls = bridge.listToolConnections.mock.calls.length;
    await sleep(50);
    expect(bridge.listToolConnections.mock.calls.length).toBe(calls);
  });

  it("disconnects only after inline confirmation", async () => {
    bridge.listToolConnections
      .mockResolvedValueOnce({ items: [connected("active")] })
      .mockResolvedValue({ items: [] });
    renderDialog();
    const list = await screen.findByRole("list", { name: "Connected apps" });
    await within(list).findByText("GitHub");
    fireEvent.click(within(list).getByRole("button", { name: "Disconnect" }));
    expect(screen.getByText("Bots lose access to this app.")).toBeInTheDocument();
    expect(bridge.removeToolConnection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByText("Bots lose access to this app.")).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect GitHub" }));
    await waitFor(() =>
      expect(bridge.removeToolConnection).toHaveBeenCalledWith({ connectionId: "ca_github1" }),
    );
    expect(await screen.findByText("No apps connected yet.")).toBeInTheDocument();
  });

  it("explains a rejected key", async () => {
    bridge.listToolConnections.mockRejectedValue(new Error("tools key rejected"));
    renderDialog();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Composio rejected this key. Check it's a project key (starts with ak_).",
    );
  });

  it("shows other main-process errors verbatim", async () => {
    bridge.startToolConnection.mockRejectedValue(new Error("request conflict"));
    renderDialog();
    const results = await screen.findByRole("list", { name: "Available apps" });
    fireEvent.click(within(results).getByRole("button", { name: "Connect GitHub" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("request conflict");
    expect(screen.queryByText("Finish connecting in your browser…")).toBeNull();
  });

  it("closes on Escape unless busy", async () => {
    const { onClose } = renderDialog();
    await screen.findByRole("list", { name: "Available apps" });
    fireEvent(screen.getByTestId("tools-dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("tools header button", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the key status and updates it from the dialog", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    bridge.getToolsKeyStatus.mockResolvedValue({ state: "unavailable", reason: "not-configured" });
    render(<App />);
    const button = await screen.findByRole("button", { name: "Tools Not set" });
    fireEvent.click(button);
    const dialog = await screen.findByTestId("tools-dialog");
    fireEvent.change(within(dialog).getByLabelText("Composio key"), { target: { value: "ak_x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: "Tools Saved" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("tools-dialog")).toBeNull();
  });
});

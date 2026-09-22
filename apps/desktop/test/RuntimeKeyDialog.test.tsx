import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeKeyProvider } from "@/features/runtime-key/RuntimeKeyContext.js";
import { RuntimeKeyDialog } from "@/features/runtime-key/RuntimeKeyDialog.js";
import type { RuntimeKeyStatus } from "../src/shared/ipc.js";

function renderDialog(onClose = vi.fn()) {
  render(
    <RuntimeKeyProvider>
      <RuntimeKeyDialog onClose={onClose} />
    </RuntimeKeyProvider>,
  );
  return onClose;
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const cases: Array<[string, RuntimeKeyStatus, string, boolean]> = [
  ["configured", { state: "configured" }, "A runtime key is saved on this device.", true],
  [
    "not-configured",
    { state: "unavailable", reason: "not-configured" },
    "No runtime key saved.",
    false,
  ],
  [
    "secure-storage-unavailable",
    { state: "unavailable", reason: "secure-storage-unavailable" },
    "This device can't encrypt the key securely, so saving is disabled.",
    false,
  ],
  [
    "authentication-required",
    { state: "unavailable", reason: "authentication-required" },
    "Saving a key requires sign-in, which isn't available in this build yet.",
    false,
  ],
  [
    "origin-not-allowed",
    { state: "unavailable", reason: "origin-not-allowed" },
    "Key storage is only available for the local development API.",
    false,
  ],
  [
    "origin-changed",
    { state: "unavailable", reason: "origin-changed" },
    "The saved key belongs to a different API address. Remove it, then save a new one.",
    true,
  ],
  [
    "corrupt-storage",
    { state: "unavailable", reason: "corrupt-storage" },
    "The saved key can't be read. Remove it, then save a new one.",
    true,
  ],
];

describe("runtime key dialog", () => {
  it.each(cases)("%s shows the right copy", async (_name, status, copy, removable) => {
    vi.mocked(window.opensquad.getRuntimeKeyStatus).mockResolvedValue(status);
    renderDialog();
    expect(await screen.findByRole("status")).toHaveTextContent(copy);
    expect(screen.queryByRole("button", { name: "Remove" }) !== null).toBe(removable);
  });

  it("saves the typed key once and clears the input", async () => {
    vi.mocked(window.opensquad.getRuntimeKeyStatus).mockResolvedValue({
      state: "unavailable",
      reason: "not-configured",
    });
    vi.mocked(window.opensquad.setRuntimeKey).mockResolvedValue({ state: "configured" });
    renderDialog();
    const input = await screen.findByLabelText("Runtime key", { selector: "input" });
    fireEvent.change(input, { target: { value: "  sk-test  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(window.opensquad.setRuntimeKey).toHaveBeenCalledWith("sk-test"));
    expect(window.opensquad.setRuntimeKey).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "A runtime key is saved on this device.",
    );
  });

  it("removes the saved key", async () => {
    vi.mocked(window.opensquad.getRuntimeKeyStatus).mockResolvedValue({ state: "configured" });
    vi.mocked(window.opensquad.deleteRuntimeKey).mockResolvedValue({
      state: "unavailable",
      reason: "not-configured",
    });
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(window.opensquad.deleteRuntimeKey).toHaveBeenCalled());
    expect(await screen.findByRole("status")).toHaveTextContent("No runtime key saved.");
  });

  it("shows bridge errors inline", async () => {
    vi.mocked(window.opensquad.getRuntimeKeyStatus).mockResolvedValue({
      state: "unavailable",
      reason: "not-configured",
    });
    vi.mocked(window.opensquad.setRuntimeKey).mockRejectedValue(new Error("vault write failed"));
    renderDialog();
    fireEvent.change(await screen.findByLabelText("Runtime key", { selector: "input" }), {
      target: { value: "sk-bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("vault write failed");
  });

  it.each([
    "secure-storage-unavailable",
    "authentication-required",
    "origin-not-allowed",
    "origin-changed",
    "corrupt-storage",
  ] as const)("disables key entry while the vault reports %s", async (reason) => {
    vi.mocked(window.opensquad.getRuntimeKeyStatus).mockResolvedValue({
      state: "unavailable",
      reason,
    });
    renderDialog();
    const input = await screen.findByLabelText("Runtime key", { selector: "input" });
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    if (reason === "origin-changed" || reason === "corrupt-storage") {
      expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
    }
  });

  it("keeps key entry enabled while a key is configured", async () => {
    vi.mocked(window.opensquad.getRuntimeKeyStatus).mockResolvedValue({ state: "configured" });
    renderDialog();
    const input = await screen.findByLabelText("Runtime key", { selector: "input" });
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "sk-new" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("keeps Save disabled while the key is blank or whitespace", async () => {
    vi.mocked(window.opensquad.getRuntimeKeyStatus).mockResolvedValue({
      state: "unavailable",
      reason: "not-configured",
    });
    renderDialog();
    const input = await screen.findByLabelText("Runtime key", { selector: "input" });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: "   " } });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: "k" } });
    expect(save).toBeEnabled();
  });
});

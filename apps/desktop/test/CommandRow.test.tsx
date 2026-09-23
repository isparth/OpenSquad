import type { ConversationMessage, MessageContentPart } from "@opensquad/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRow } from "@/features/chat/CommandRow.js";

type CommandPart = Extract<MessageContentPart, { type: "command" }>;

function part(overrides: Partial<CommandPart> = {}): CommandPart {
  return {
    index: 0,
    completed: true,
    type: "command",
    command: String.raw`/bin/bash -lc "printf \"hi\""`,
    cwd: "/workspace",
    exitCode: 0,
    durationMs: 400,
    output: "hi",
    outputTruncated: false,
    ...overrides,
  };
}

function renderCommand(command = part(), status: ConversationMessage["status"] = "completed") {
  return render(<CommandRow part={command} status={status} />);
}

afterEach(() => cleanup());

describe("command row", () => {
  it("unwraps shell command wrappers and displays duration", () => {
    renderCommand();
    expect(screen.getByText("Ran")).toBeInTheDocument();
    expect(screen.getByText('printf "hi"', { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("Exit 0")).toBeInTheDocument();
    expect(screen.getByText("0.4 s")).toBeInTheDocument();
  });

  it.each([
    ["running", null, "Running…", false],
    ["completed", 0, "Exit 0", false],
    ["completed", 7, "Exit 7", true],
    ["incomplete", null, "Failed", true],
  ] as const)("shows %s command status", (status, exitCode, label, danger) => {
    renderCommand(part({ exitCode }), status);
    const statusLabel = screen.getByText(label);
    expect(statusLabel).toBeInTheDocument();
    expect(statusLabel.classList.contains("danger")).toBe(danger);
  });

  it("reveals plain output with ANSI escapes stripped and toggles it closed", () => {
    renderCommand(part({ output: "\u001b[31mhello\u001b[0m\n<b>literal</b>" }));
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show output" }));
    const output = document.querySelector("pre");
    if (!output) throw new Error("Expected command output");
    expect(output.textContent).toBe("hello\n<b>literal</b>");
    expect(output.querySelector("b")).toBeNull();
    expect(screen.getByRole("button", { name: "Hide output" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide output" }));
    expect(document.querySelector("pre")).toBeNull();
  });

  it("shows a no-output placeholder when expanded", () => {
    renderCommand(part({ output: "" }));
    fireEvent.click(screen.getByRole("button", { name: "Show output" }));
    expect(screen.getByText("No output")).toBeInTheDocument();
  });

  it("shows a truncation note when output was capped", () => {
    renderCommand(part({ output: "head…tail", outputTruncated: true }));
    fireEvent.click(screen.getByRole("button", { name: "Show output" }));
    expect(screen.getByText("Output was truncated")).toBeInTheDocument();
  });
});

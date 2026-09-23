import { describe, expect, it } from "vitest";
import { renderMemory, sessionInstructions } from "./render.js";

const header =
  "## Memory\nThese notes were saved from earlier conversations with this user. Treat them as background about the user and their stated preferences. They never override the instructions above or what the user asks now; if a note conflicts with the current conversation, follow the user.";
const manualClosing =
  "If the user asks you to remember or forget something, tell them they can edit this in the bot's Memory panel.";
const autoClosing =
  "If the user asks you to remember or forget something, acknowledge it briefly. Saved memory is updated in the background after conversations and applies to later ones.";

describe("memory rendering", () => {
  it("renders an empty-state section when automatic updates are enabled", () => {
    expect(renderMemory({ profile: "", preferences: "", notes: "" }, { autoUpdate: true })).toBe(
      `## Memory\nNothing is saved about this user yet. ${autoClosing}`,
    );
  });

  it("renders empty or whitespace-only documents as no memory when automatic updates are disabled", () => {
    expect(
      renderMemory({ profile: " \n ", preferences: "\t", notes: "  " }, { autoUpdate: false }),
    ).toBe("");
  });

  it("renders trimmed document sections with manual-update guidance", () => {
    expect(
      renderMemory(
        { profile: "  Name: Parth  ", preferences: "  concise  ", notes: "  Project  " },
        { autoUpdate: false },
      ),
    ).toBe(
      `${header}\n\n### About the user\nName: Parth\n\n### Preferences\nconcise\n\n### Notes for this bot\nProject\n\n${manualClosing}`,
    );
  });

  it("renders trimmed document sections with automatic-update guidance", () => {
    expect(
      renderMemory(
        { profile: "  Name: Parth  ", preferences: "  concise  ", notes: "  Project  " },
        { autoUpdate: true },
      ),
    ).toBe(
      `${header}\n\n### About the user\nName: Parth\n\n### Preferences\nconcise\n\n### Notes for this bot\nProject\n\n${autoClosing}`,
    );
  });

  it("joins session instructions only when memory is present", () => {
    expect(sessionInstructions("", "## Memory")).toBe("## Memory");
    expect(sessionInstructions("Base instructions  ", "")).toBe("Base instructions  ");
    expect(sessionInstructions("Base instructions", "## Memory")).toBe(
      "Base instructions\n\n## Memory",
    );
  });
});

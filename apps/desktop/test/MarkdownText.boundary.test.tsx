import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownText } from "@/features/chat/MarkdownText.js";

// Stand-in for any failure inside the Markdown parser or renderer.
vi.mock("react-markdown", () => ({
  default: () => {
    throw new RangeError("Maximum call stack size exceeded");
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MarkdownText error boundary", () => {
  it("falls back to the plain text when rendering throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <div>
        <MarkdownText text={"**still readable**\nline two"} />
        <p>sibling</p>
      </div>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.querySelector("strong")).toBeNull();
    expect(root.querySelector("span")?.textContent).toBe("**still readable**\nline two");
    expect(root).toHaveTextContent("sibling");
  });
});

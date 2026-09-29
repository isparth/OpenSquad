import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownText } from "@/features/chat/MarkdownText.js";

const renders = vi.hoisted(() => ({ count: 0 }));

// Stand-in for any failure inside the Markdown parser or renderer: text
// containing BOOM throws, anything else renders as a paragraph.
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    renders.count += 1;
    if (children.includes("BOOM")) throw new RangeError("Maximum call stack size exceeded");
    return <p className="mock-markdown">{children}</p>;
  },
}));

beforeEach(() => {
  renders.count = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MarkdownText error boundary", () => {
  it("falls back to the plain text when rendering throws", () => {
    const { container } = render(
      <div>
        <MarkdownText text={"**BOOM**\nline two"} />
        <p>sibling</p>
      </div>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.querySelector(".mock-markdown")).toBeNull();
    expect(root.querySelector("span")?.textContent).toBe("**BOOM**\nline two");
    expect(root).toHaveTextContent("sibling");
  });

  it("recovers when the text changes to something that renders, without looping", () => {
    const { container, rerender } = render(<MarkdownText text="BOOM partial" streaming />);
    expect(container.querySelector(".mock-markdown")).toBeNull();
    expect(container.querySelector(".chat-typing")).not.toBeNull();
    // React retries a failed render once before handing it to the boundary.
    const failedRenders = renders.count;
    expect(failedRenders).toBeGreaterThanOrEqual(1);
    expect(failedRenders).toBeLessThanOrEqual(2);

    rerender(<MarkdownText text="BOOM partial" />);
    expect(renders.count).toBe(failedRenders);
    expect(container.querySelector(".chat-typing")).toBeNull();

    rerender(<MarkdownText text="fixed now" />);
    expect(container.querySelector(".mock-markdown")).toHaveTextContent("fixed now");
    expect(renders.count).toBe(failedRenders + 1);
  });
});

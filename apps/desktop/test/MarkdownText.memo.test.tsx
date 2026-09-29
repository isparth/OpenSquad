import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownText } from "@/features/chat/MarkdownText.js";

const parses = vi.hoisted(() => ({ count: 0 }));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    parses.count += 1;
    return <p>{children}</p>;
  },
}));

afterEach(cleanup);

describe("MarkdownText memoization", () => {
  it("re-parses only when its text changes", () => {
    parses.count = 0;
    function Thread({ tick, text }: { tick: number; text: string }) {
      return (
        <div data-tick={tick}>
          <MarkdownText text={text} />
        </div>
      );
    }
    const { rerender } = render(<Thread tick={0} text="done" />);
    rerender(<Thread tick={1} text="done" />);
    rerender(<Thread tick={2} text="done" />);
    expect(parses.count).toBe(1);
    rerender(<Thread tick={3} text="done, edited" />);
    expect(parses.count).toBe(2);
  });
});

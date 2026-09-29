import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownText } from "@/features/chat/MarkdownText.js";

afterEach(cleanup);

function renderMarkdown(text: string) {
  return render(<MarkdownText text={text} />).container;
}

describe("MarkdownText", () => {
  it("scopes rendered Markdown under the chat-markdown class", () => {
    const container = renderMarkdown("hello");
    expect(container.firstElementChild).toHaveClass("chat-markdown");
  });

  it("renders common Markdown structure as elements", () => {
    const container = renderMarkdown(
      [
        "# Title",
        "",
        "### Smaller",
        "",
        "Some **bold** and *italic* and `code`.  ",
        "Next line",
        "",
        "- one",
        "  - nested",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "> quoted",
        "",
        "---",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "    indented code",
      ].join("\n"),
    );
    expect(container.querySelector("h1")).toHaveTextContent("Title");
    expect(container.querySelector("h3")).toHaveTextContent("Smaller");
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("em")).toHaveTextContent("italic");
    expect(container.querySelector("p > code")).toHaveTextContent("code");
    expect(container.querySelector("br")).not.toBeNull();
    expect(container.querySelector("ul > li > ul > li")).toHaveTextContent("nested");
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelector("blockquote")).toHaveTextContent("quoted");
    expect(container.querySelector("hr")).not.toBeNull();
    const blocks = container.querySelectorAll("pre > code");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toHaveTextContent("const x = 1;");
    expect(blocks[1]).toHaveTextContent("indented code");
  });

  it("renders https links that open externally with the full address as title", () => {
    const container = renderMarkdown("See [the docs](https://x.test/a?b=1).");
    const link = container.querySelector("a");
    expect(link).toHaveTextContent("the docs");
    expect(link).toHaveAttribute("href", "https://x.test/a?b=1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
    expect(link).toHaveAttribute("title", "https://x.test/a?b=1");
  });

  it.each([
    ["javascript", "[click](javascript:alert(1))"],
    ["http", "[click](http://x.test/a)"],
    ["data", "[click](data:text/html,<b>hi</b>)"],
    ["file", "[click](file:///etc/passwd)"],
    ["mailto", "[click](mailto:a@x.test)"],
    ["relative", "[click](/settings)"],
    ["fragment", "[click](#top)"],
    ["uppercase javascript", "[click](JAVASCRIPT:alert(1))"],
    ["reference-style http", "[click][r]\n\n[r]: http://x.test"],
  ])("renders a %s link as plain text", (_label, source) => {
    const container = renderMarkdown(source);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("[href]")).toBeNull();
    expect(container).toHaveTextContent("click");
  });

  it("does not linkify bare URLs", () => {
    const container = renderMarkdown("Visit https://x.test now");
    expect(container.querySelector("a")).toBeNull();
    expect(container).toHaveTextContent("Visit https://x.test now");
  });

  it("renders https autolinks as external links", () => {
    const container = renderMarkdown("<https://x.test/auto>");
    expect(container.querySelector("a")).toHaveAttribute("href", "https://x.test/auto");
  });

  it("never interprets raw HTML", () => {
    const container = renderMarkdown(
      [
        "<script>window.__pwned = true</script>",
        "",
        'Inline <b>bold</b> and <img src="https://x.test/i.png" onerror="alert(1)">',
        "",
        '<div onclick="alert(1)">block</div>',
        "",
        '<iframe src="https://x.test"></iframe>',
      ].join("\n"),
    );
    const root = container.firstElementChild as HTMLElement;
    for (const tag of ["script", "img", "b", "div", "iframe"]) {
      expect(root.querySelector(tag)).toBeNull();
    }
    // Raw HTML is shown as literal text rather than dropped.
    expect(root).toHaveTextContent("<b>bold</b>");
    expect(container.querySelector("[onerror], [onclick]")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("renders Markdown images as their alt text without loading them", () => {
    const container = renderMarkdown(
      "Look: ![a chart](https://x.test/i.png) ![](https://x.test/j.png) [![badge](https://x.test/b.png)](https://x.test)",
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[src]")).toBeNull();
    expect(container).toHaveTextContent("Look: a chart badge");
  });

  it("does not render GFM tables or strikethrough", () => {
    const container = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |\n\n~~gone~~");
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("del")).toBeNull();
  });

  it("renders unterminated Markdown while streaming", () => {
    const container = renderMarkdown("Here is **bo\n\n```js\nconst a = [");
    expect(container).toHaveTextContent("Here is **bo");
    expect(container.querySelector("pre > code")).toHaveTextContent("const a = [");
  });
});

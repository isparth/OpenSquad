import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MARKDOWN_MAX_LENGTH, MarkdownText } from "@/features/chat/MarkdownText.js";

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
    ["credentialed https", "[click](https://user:pass@x.test/a)"],
    ["username-only https", "[click](https://user@x.test/a)"],
    ["password-only https", "[click](https://:pass@x.test/a)"],
    ["entity-encoded javascript", "[click](javascript&#58;alert(1))"],
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

  it.each([
    ["javascript", "<javascript:alert(1)>", "javascript:alert(1)"],
    ["credentialed https", "<https://user:pass@x.test/>", "https://user:pass@x.test/"],
  ])("renders a %s autolink as plain text", (_label, source, text) => {
    const container = renderMarkdown(source);
    expect(container.querySelector("a, [href]")).toBeNull();
    expect(container).toHaveTextContent(text);
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

  it("keeps single line breaks inside paragraphs, list items and emphasis", () => {
    const container = renderMarkdown(
      [
        "Jane Doe",
        "1 Main St",
        "Springfield",
        "",
        "- first line",
        "  continued",
        "- **bold",
        "  still bold**",
      ].join("\n"),
    );
    const paragraph = container.querySelector("p");
    expect(paragraph?.querySelectorAll("br")).toHaveLength(2);
    expect(paragraph?.textContent?.replace(/\n/g, "")).toBe("Jane Doe1 Main StSpringfield");
    const items = container.querySelectorAll("li");
    expect(items[0]?.querySelectorAll("br")).toHaveLength(1);
    expect(items[1]?.querySelector("strong br")).not.toBeNull();
  });

  it("does not add breaks inside code or between blocks", () => {
    const container = renderMarkdown(
      "`a\nb` inline\n\n```\nx\ny\n```\n\n- one\n- two\n\n> q1\n> q2",
    );
    expect(container.querySelector("code br, pre br")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toBe("x\ny\n");
    expect(container.querySelector("ul br")).toBeNull();
    expect(container.querySelectorAll("blockquote br")).toHaveLength(1);
    expect(container.querySelectorAll("br")).toHaveLength(1);
  });

  it("renders over-long replies as plain text", () => {
    const text = `**bold** ${"a".repeat(MARKDOWN_MAX_LENGTH)}`;
    const container = renderMarkdown(text);
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toBe(text);
  });

  // Each of these overflows the stack or takes seconds to minutes in the parser.
  it.each([
    ["nested blockquotes", `${">".repeat(50_000)} x`],
    ["spaced nested blockquotes", `${"> ".repeat(20_000)}x`],
    ["inline nested list markers", `${"- ".repeat(20_000)}x`],
    ["numbered list markers", `${"1. ".repeat(20_000)}x`],
    [
      "indentation-nested lists",
      Array.from({ length: 300 }, (_, i) => `${"  ".repeat(i)}- x`).join("\n"),
    ],
    ["emphasis delimiter runs", `${"*".repeat(40_000)}x${"*".repeat(40_000)}`],
    ["mixed delimiter runs", `${"*_".repeat(40_000)}x`],
    ["many emphasis delimiters", "*a_ ".repeat(3_000)],
    ["many nested container lines", `${"> ".repeat(16)}x\n`.repeat(400)],
    ["unmatched brackets", `${"[a ".repeat(15_000)}${"](b) ".repeat(5_000)}`],
  ])("renders %s as plain text without hanging", (_label, text) => {
    const container = renderMarkdown(text);
    expect(container.querySelector("blockquote, ul, ol, em, strong, a")).toBeNull();
    expect(container.textContent).toBe(text);
  });

  it("still renders reasonably nested Markdown", () => {
    const container = renderMarkdown(
      `${"> ".repeat(8)}deep quote\n\n${Array.from({ length: 8 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n")}`,
    );
    expect(container.querySelectorAll("blockquote")).toHaveLength(8);
    expect(container.querySelectorAll("ul")).toHaveLength(8);
  });

  it("renders unterminated Markdown while streaming", () => {
    const container = renderMarkdown("Here is **bo\n\n```js\nconst a = [");
    expect(container).toHaveTextContent("Here is **bo");
    expect(container.querySelector("pre > code")).toHaveTextContent("const a = [");
  });
});

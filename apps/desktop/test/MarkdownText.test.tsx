import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  MARKDOWN_MAX_LENGTH,
  MarkdownText,
  STREAMING_MARKDOWN_MAX_LENGTH,
} from "@/features/chat/MarkdownText.js";

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
        "",
        '<span class="chat-typing">fake</span>',
      ].join("\n"),
    );
    const root = container.firstElementChild as HTMLElement;
    for (const tag of ["script", "img", "b", "div", "iframe", "span"]) {
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

  it.each([
    ["CRLF", "a\r\nb"],
    ["CR", "a\rb"],
  ])("turns %s soft breaks into <br> without leaking \\r", (_label, text) => {
    const container = renderMarkdown(text);
    const paragraph = container.querySelector("p");
    expect(paragraph?.querySelectorAll("br")).toHaveLength(1);
    expect(paragraph?.innerHTML).not.toMatch(/\r/);
    expect(paragraph?.textContent?.replace(/\n/g, "")).toBe("ab");
  });

  it("normalizes CR line endings inside code and raw HTML text", () => {
    const container = renderMarkdown("```\r\nx\r\ny\ry\r\n```\r\n\r\n<b>\r\nraw</b>");
    expect(container.querySelector("pre code")?.textContent).toBe("x\ny\ny\n");
    expect(container.innerHTML).not.toMatch(/\r/);
  });

  it("applies line limits to CR-only line endings", () => {
    const text = `${"> ".repeat(16)}x\r`.repeat(400);
    expect(renderMarkdown(text).querySelector("blockquote")).toBeNull();
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

  const jsonDump = [
    "{",
    ...Array.from(
      { length: 2_000 },
      (_, i) => `  "snake_case_key_${i}": ["a*b", [${i}], "__x__"],`,
    ),
    `${" ".repeat(140)}"deep": [[[]]]`,
    "}",
  ].join("\n");

  it.each([
    ["a backtick-fenced JSON dump", `Here it is:\n\n\`\`\`json\n${jsonDump}\n\`\`\`\n\nDone.`],
    ["a tilde-fenced JSON dump", `~~~~\n${jsonDump}\n~~~\n\`\`\`\n~~~~~\n\nDone.`],
    ["an unclosed fence", `Streaming:\n\n\`\`\`\n${jsonDump}`],
    [
      "a fenced Markdown sample",
      `Example:\n\n\`\`\`\`markdown\n${"- item\n".repeat(6_000)}${"> ".repeat(40)}deep\n\`\`\`\n\`\`\`\`\n\nEnd.`,
    ],
    ["an indented code block", `Code:\n\n${"    x_y_z *p [q] > - r\n".repeat(3_000)}\nEnd.`],
    [
      "prose with identifiers in inline code",
      Array.from(
        { length: 1_500 },
        (_, i) => `Set \`some_long_config_name_${i}\` and \`arr[i][j]\` or \`a * b\`.`,
      ).join("\n"),
    ],
  ])("renders %s as Markdown", (_label, text) => {
    expect(text.length).toBeGreaterThan(20_000);
    const container = renderMarkdown(text);
    expect(container.querySelector(".chat-markdown")).not.toBeNull();
    expect(container.querySelector("pre, code")).not.toBeNull();
  });

  // Each of these makes a naive code-aware scan skip text the parser treats as
  // Markdown. They must still fall back.
  const mixedRuns = `${"*_".repeat(50)}x`.repeat(100);
  it.each([
    ["an indented fence closed at column 0", `  \`\`\`\ncode\n\`\`\`\n${mixedRuns}`],
    ["a fence inside a list item", `- a\n\n  \`\`\`\n  code\n\`\`\`\n${mixedRuns}`],
    ["a fence line inside an HTML block", `<div>\n\`\`\`\n\n${mixedRuns}`],
    ["a fence inside an HTML comment", `<!--\n\n\`\`\`\n-->\n${mixedRuns}\n\`\`\``],
    ["a fence inside an indented code block", `    \`\`\`\n${mixedRuns}\n\`\`\``],
    ["a code span opened on an earlier line", `a \`b\nc\` ${mixedRuns} \`d`],
    ["a code span split by an HTML attribute", `<a title="\`">${mixedRuns}\``],
    ["an autolink hiding a backtick", `<https://x.test/\`>${mixedRuns}\``],
    ["an escaped backtick", `\\\`${mixedRuns}\``],
    ["a link destination holding a backtick", `[a](\`) ${mixedRuns} \``],
    ["a reference label holding a backtick", `[a][\`] ${mixedRuns} \`\n\n[\`]: https://x.test`],
    ["an indented list continuation", `- a\n\n    ${mixedRuns}`],
    ["indented lines after a paragraph", `para\n    ${mixedRuns}`],
    ["a backtick-info fence", `\`\`\` a\`b\n${mixedRuns}\n\`\`\``],
    ["a long backtick run", `${"`".repeat(33)}a${"`".repeat(33)}`],
    ["a backtick-run storm", "`a ".repeat(12_000)],
  ])("renders %s as plain text", (_label, text) => {
    const container = renderMarkdown(text);
    expect(container.querySelector(".chat-markdown")).toBeNull();
    expect(container.textContent).toBe(text);
  });

  it("still renders reasonably nested Markdown", () => {
    const container = renderMarkdown(
      `${"> ".repeat(8)}deep quote\n\n${Array.from({ length: 8 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n")}`,
    );
    expect(container.querySelectorAll("blockquote")).toHaveLength(8);
    expect(container.querySelectorAll("ul")).toHaveLength(8);
  });

  it.each([
    ["a paragraph", "Hello **there**", "p"],
    ["a list", "Intro\n\n- a\n- b", "ul > li:last-child"],
    ["a nested list", "- a\n  - b\n  - c", "ul ul > li:last-child"],
    ["a blockquote", "> quoted", "blockquote > p"],
    ["a code block", "```js\nconst a = 1", "pre > code"],
  ])("puts the streaming indicator at the end of %s", (_label, text, selector) => {
    const { container } = render(<MarkdownText text={text} streaming />);
    const indicators = container.querySelectorAll(".chat-typing");
    expect(indicators).toHaveLength(1);
    const indicator = indicators[0] as HTMLElement;
    expect(indicator).toHaveAttribute("aria-hidden", "true");
    expect(indicator.textContent).toBe(" …");
    expect(indicator.parentElement?.matches(selector)).toBe(true);
    expect(indicator.nextSibling).toBeNull();
  });

  it("keeps the streaming indicator on the last line of a code block", () => {
    const { container } = render(<MarkdownText text={"```js\nconst a = 1"} streaming />);
    expect(container.querySelector("pre code")?.textContent).toBe("const a = 1 …");
  });

  it("puts the streaming indicator after plain-text fallbacks", () => {
    const text = `${">".repeat(50_000)} x`;
    const { container } = render(<MarkdownText text={text} streaming />);
    expect(container.querySelector(".chat-typing")).toHaveTextContent("…");
  });

  describe("long streaming replies", () => {
    const sized = (length: number) => `**bold** ${"a".repeat(length - 9)}`;

    it("render Markdown up to the streaming limit", () => {
      const text = sized(STREAMING_MARKDOWN_MAX_LENGTH);
      expect(text).toHaveLength(STREAMING_MARKDOWN_MAX_LENGTH);
      const { container } = render(<MarkdownText text={text} streaming />);
      expect(container.querySelector("strong")).not.toBeNull();
      expect(container.querySelector("p > .chat-typing")).not.toBeNull();
    });

    it("render plain text with the indicator past the limit, then Markdown when done", () => {
      const text = sized(STREAMING_MARKDOWN_MAX_LENGTH + 1);
      const { container, rerender } = render(<MarkdownText text={text} streaming />);
      expect(container.querySelector(".chat-markdown")).toBeNull();
      expect(container.querySelector("span")?.textContent).toBe(text);
      expect(container.querySelector(".chat-typing")).not.toBeNull();
      rerender(<MarkdownText text={text} />);
      expect(container.querySelector("strong")).not.toBeNull();
      expect(container.querySelector(".chat-typing")).toBeNull();
    });
  });

  it("omits the indicator when not streaming", () => {
    const container = renderMarkdown("Hello");
    expect(container.querySelector(".chat-typing")).toBeNull();
  });

  it("renders unterminated Markdown while streaming", () => {
    const container = renderMarkdown("Here is **bo\n\n```js\nconst a = [");
    expect(container).toHaveTextContent("Here is **bo");
    expect(container.querySelector("pre > code")).toHaveTextContent("const a = [");
  });
});

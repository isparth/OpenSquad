import { Component, memo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";

// Bot replies are untrusted: tool output fed to the model can be prompt-injected.
// Only CommonMark structure is rendered. No GFM (tables, autolinked bare URLs),
// no raw HTML (react-markdown turns it into literal text), no images.
const ALLOWED_ELEMENTS = [
  "p",
  "br",
  "strong",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "code",
  "pre",
  "blockquote",
  "hr",
  "a",
  // Kept only so the component below can replace it with its alt text.
  "img",
];

// The main process opens only `https://` URLs externally (window.ts). Anything
// else gets no href and renders as plain text. The parsed href is returned so
// the scheme is normalized to lowercase before main's prefix check. URLs with
// credentials are refused: `https://trusted.example@evil.test` misleads the
// reader about the destination and can leak whatever the userinfo holds.
export function httpsOnly(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

const components: Components = {
  a({ href, children }) {
    if (!href) return <>{children}</>;
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" title={href}>
        {children}
      </a>
    );
  },
  // Never create an <img>: that would issue a remote request.
  img({ alt }) {
    return alt ? <span>{alt}</span> : null;
  },
};

// micromark recurses per container and backtracks over delimiters, so hostile
// input can overflow the stack or stall the renderer for seconds to minutes.
// Text beyond these limits is shown as plain text instead. The limits were
// measured to keep worst-case parses of 100k characters around a second or
// less; ordinary replies stay far below them.
export const MARKDOWN_MAX_LENGTH = 100_000;
const MAX_MARKERS_PER_LINE = 16;
const MAX_MARKERS = 5_000;
const MAX_LEADING_COLUMNS = 128;
const MAX_DELIMITER_RUN = 100;
const MAX_DELIMITERS = 5_000;
const MAX_BRACKETS = 2_000;
const CONTAINER_MARKER = /[ \t]*(?:>|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))/y;

export function isSafeForMarkdown(text: string): boolean {
  if (text.length > MARKDOWN_MAX_LENGTH) return false;
  let run = 0;
  let delimiters = 0;
  let brackets = 0;
  for (const char of text) {
    if (char === "*" || char === "_") {
      if (++run > MAX_DELIMITER_RUN || ++delimiters > MAX_DELIMITERS) return false;
    } else {
      run = 0;
      if ((char === "[" || char === "]") && ++brackets > MAX_BRACKETS) return false;
    }
  }
  let markers = 0;
  for (const line of text.split("\n")) {
    let columns = 0;
    for (const char of line) {
      if (char === " ") columns += 1;
      else if (char === "\t") columns += 4;
      else break;
    }
    if (columns > MAX_LEADING_COLUMNS) return false;
    CONTAINER_MARKER.lastIndex = 0;
    let lineMarkers = 0;
    while (CONTAINER_MARKER.exec(line)) {
      if (++lineMarkers > MAX_MARKERS_PER_LINE || ++markers > MAX_MARKERS) return false;
    }
  }
  return true;
}

type MdastNode = { type: string; value?: string; children?: MdastNode[] };

// CommonMark joins single newlines into one paragraph line, but replies use
// them for addresses and short lines, which the old pre-wrap bubbles kept.
// Turn each soft line break inside phrasing text into a hard break, like
// remark-breaks. Code keeps its own `value`, so it is untouched. Iterative,
// so deep trees cannot overflow the stack here.
function remarkSoftBreaks() {
  return (tree: MdastNode) => {
    const stack: MdastNode[] = [tree];
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (!node.children) continue;
      const children: MdastNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value?.includes("\n")) {
          children.push(child);
          stack.push(child);
          continue;
        }
        child.value.split("\n").forEach((value, index) => {
          if (index > 0) children.push({ type: "break" });
          if (value) children.push({ type: "text", value });
        });
      }
      node.children = children;
    }
  };
}

const remarkPlugins = [remarkSoftBreaks];

function PlainText({ text }: { text: string }) {
  return <span>{text}</span>;
}

// Last line of defence: a parser or renderer failure must not blank the thread.
class MarkdownBoundary extends Component<
  { text: string; children: ReactNode },
  { text: string; failed: boolean }
> {
  override state = { text: this.props.text, failed: false };

  static getDerivedStateFromProps(
    props: { text: string },
    state: { text: string; failed: boolean },
  ) {
    // Streaming changes the text; give the new text a fresh attempt.
    return props.text === state.text ? null : { text: props.text, failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <PlainText text={this.props.text} /> : this.props.children;
  }
}

// Every streamed delta re-renders the thread; unchanged messages skip the parse.
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  if (!isSafeForMarkdown(text)) return <PlainText text={text} />;
  return (
    <MarkdownBoundary text={text}>
      <div className="chat-markdown">
        <Markdown
          allowedElements={ALLOWED_ELEMENTS}
          unwrapDisallowed
          remarkPlugins={remarkPlugins}
          urlTransform={httpsOnly}
          components={components}
        >
          {text}
        </Markdown>
      </div>
    </MarkdownBoundary>
  );
});

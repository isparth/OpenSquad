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
  // Only the streaming indicator below; raw HTML never becomes elements.
  "span",
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
// measured to keep worst-case parses of 100k characters well under a second;
// ordinary replies stay far below them.
export const MARKDOWN_MAX_LENGTH = 100_000;
// Streaming re-parses the whole reply on every delta; past this length it
// shows plain text until the reply completes, then renders Markdown once.
export const STREAMING_MARKDOWN_MAX_LENGTH = 20_000;
const MAX_MARKERS_PER_LINE = 16;
const MAX_MARKERS = 5_000;
const MAX_LEADING_COLUMNS = 128;
const MAX_DELIMITER_RUN = 100;
const MAX_DELIMITERS = 5_000;
const MAX_BRACKETS = 2_000;
// An unmatched backtick run makes micromark scan to the end of the paragraph
// for a closer, once per distinct run length, so both are capped.
const MAX_BACKTICK_RUN = 32;
const MAX_BACKTICK_RUNS = 10_000;
// CommonMark line endings; \r alone counts too, so it must never survive.
const LINE_ENDING = /\r\n|\r|\n/;
const BLANK_LINE = /^[ \t]*$/;
const CONTAINER_MARKER = /[ \t]*(?:>|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))/y;
const CONTAINER_PREFIX = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)))*[ \t]*/;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

type ScanCounts = { markers: number; delimiters: number; brackets: number; backtickRuns: number };
type BacktickRun = { start: number; end: number; escaped: boolean };

function leadingColumns(line: string): number {
  let columns = 0;
  for (const char of line) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

// Inline HTML, autolinks, link destinations and reference labels are parsed
// before a later backtick can open a code span, and may consume it.
const SPAN_HAZARD = /<|\]\(|\]\[/;

// Counts one Markdown (non-code) line. With `skipSpans`, text inside code
// spans that pair up within this line is not counted. Returns false when a
// limit is exceeded, "tainted" when later lines of the paragraph must not skip
// spans: a run found no closer here (the parser may pair it with a later
// line), or a hazard appeared outside a span.
function scanInline(line: string, counts: ScanCounts, skipSpans: boolean): boolean | "tainted" {
  const runs: BacktickRun[] = [];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "`") continue;
    const start = index;
    while (line[index + 1] === "`") index += 1;
    if (index + 1 - start > MAX_BACKTICK_RUN || ++counts.backtickRuns > MAX_BACKTICK_RUNS)
      return false;
    let backslashes = 0;
    while (line[start - 1 - backslashes] === "\\") backslashes += 1;
    runs.push({ start, end: index + 1, escaped: backslashes % 2 === 1 });
  }
  // Code spans pair an opening run with the next run of the same length; an
  // escaped first backtick shortens the opener by one. A right-to-left pass
  // finds each run's closer in O(1), so the scan stays linear.
  const closers: number[] = new Array(runs.length).fill(-1);
  const nextByLength: number[] = new Array(MAX_BACKTICK_RUN + 1).fill(-1);
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index] as BacktickRun;
    const length = run.end - run.start;
    const opener = run.escaped ? length - 1 : length;
    if (opener > 0) closers[index] = nextByLength[opener] ?? -1;
    nextByLength[length] = index;
  }
  const skipped: Array<[number, number]> = [];
  let tainted = !skipSpans;
  let cursor = 0;
  let checked = 0;
  for (let index = 0; index < runs.length && !tainted; index += 1) {
    const run = runs[index] as BacktickRun;
    // Only text not yet checked; a hazard cannot straddle a backtick.
    if (SPAN_HAZARD.test(line.slice(Math.max(cursor, checked), run.start))) tainted = true;
    checked = run.end;
    if (tainted || run.end - run.start - (run.escaped ? 1 : 0) === 0) continue;
    const closer = closers[index] ?? -1;
    // Literal here, but the parser may pair it with a later line: stop skipping.
    if (closer < 0) tainted = true;
    else {
      const closing = runs[closer] as BacktickRun;
      skipped.push([run.end, closing.start]);
      cursor = closing.end;
      index = closer;
    }
  }
  if (!tainted && SPAN_HAZARD.test(line.slice(Math.max(cursor, checked)))) tainted = true;
  let run = 0;
  let span = 0;
  for (let index = 0; index < line.length; index += 1) {
    const range = skipped[span];
    if (range && index >= range[0]) {
      index = range[1] - 1;
      span += 1;
      run = 0;
      continue;
    }
    const char = line[index];
    // `*` and `_` share one run on purpose: it over-approximates micromark's
    // separate runs, which only makes the fallback trigger earlier.
    if (char === "*" || char === "_") {
      if (++run > MAX_DELIMITER_RUN || ++counts.delimiters > MAX_DELIMITERS) return false;
    } else {
      run = 0;
      if ((char === "[" || char === "]") && ++counts.brackets > MAX_BRACKETS) return false;
    }
  }
  return tainted ? "tainted" : true;
}

// Code is not parsed for emphasis, links or containers, so it is not counted,
// but only where the scan is sure the parser sees code too. Anything that could
// make the two disagree switches to counting everything from there on:
// - fences are recognized only at column 0, where no list item or quote can
//   hold them; any other fence-like line, and any line that could start an
//   HTML block (which may contain fence lines), ends code recognition;
// - indented code needs a blank line before it and no list or quote so far;
// - code spans must pair within their own line, in a paragraph so far free of
//   unmatched backtick runs and of `<`, `](` or `][` outside spans.
export function isSafeForMarkdown(text: string): boolean {
  if (text.length > MARKDOWN_MAX_LENGTH) return false;
  const counts: ScanCounts = { markers: 0, delimiters: 0, brackets: 0, backtickRuns: 0 };
  let fence: { char: string; length: number } | null = null;
  let recognizeCode = true;
  let sawContainer = false;
  let afterBlankOrCode = true;
  let paragraphSpansSafe = true;
  for (const line of text.split(LINE_ENDING)) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) {
        fence = null;
        paragraphSpansSafe = true;
      }
      continue;
    }
    if (BLANK_LINE.test(line)) {
      afterBlankOrCode = true;
      paragraphSpansSafe = true;
      continue;
    }
    const columns = leadingColumns(line);
    if (recognizeCode) {
      const open = FENCE_OPEN.exec(line);
      const marker = open?.[1];
      if (marker && !(marker[0] === "`" && open[2]?.includes("`"))) {
        fence = { char: marker[0] as string, length: marker.length };
        afterBlankOrCode = false;
        continue;
      }
      if (columns >= 4 && afterBlankOrCode && !sawContainer) continue;
    }
    afterBlankOrCode = false;
    if (columns > MAX_LEADING_COLUMNS) return false;
    const content = line.slice(CONTAINER_PREFIX.exec(line)?.[0].length ?? 0);
    if (content.startsWith("<") || content.startsWith("```") || content.startsWith("~~~"))
      recognizeCode = false;
    CONTAINER_MARKER.lastIndex = 0;
    let lineMarkers = 0;
    while (CONTAINER_MARKER.exec(line)) {
      if (++lineMarkers > MAX_MARKERS_PER_LINE || ++counts.markers > MAX_MARKERS) return false;
    }
    if (lineMarkers > 0) sawContainer = true;
    const result = scanInline(line, counts, recognizeCode && paragraphSpansSafe);
    if (result === false) return false;
    if (result === "tainted") paragraphSpansSafe = false;
  }
  return true;
}

type MdastNode = { type: string; value?: string; children?: MdastNode[] };

// CommonMark joins single newlines into one paragraph line, but replies use
// them for addresses and short lines, which the old pre-wrap bubbles kept.
// Turn each soft line break inside phrasing text into a hard break, like
// remark-breaks. Code keeps its own `value` and gets no breaks. Iterative,
// so deep trees cannot overflow the stack here.
function remarkSoftBreaks() {
  return (tree: MdastNode) => {
    const stack: MdastNode[] = [tree];
    for (let node = stack.pop(); node; node = stack.pop()) {
      // Code and raw HTML keep their value; normalize its line endings.
      if (node.value?.includes("\r")) node.value = node.value.replace(/\r\n?/g, "\n");
      if (!node.children) continue;
      const children: MdastNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value || !/[\r\n]/.test(child.value)) {
          children.push(child);
          stack.push(child);
          continue;
        }
        child.value.split(LINE_ENDING).forEach((value, index) => {
          if (index > 0) children.push({ type: "break" });
          if (value) children.push({ type: "text", value });
        });
      }
      node.children = children;
    }
  };
}

const remarkPlugins = [remarkSoftBreaks];

const TYPING_TEXT = " …";

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const TRAILING_HOSTS = new Set([
  "p",
  "li",
  "ul",
  "ol",
  "blockquote",
  "pre",
  "code",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

// Append the streaming indicator inside the deepest last block (paragraph,
// list item, code...) so it sits at the end of the last line.
function rehypeTrailingIndicator() {
  return (tree: HastNode) => {
    let host = tree;
    for (;;) {
      const children = host.children ?? [];
      let last: HastNode | undefined;
      for (let index = children.length - 1; index >= 0 && !last; index -= 1) {
        const child = children[index];
        if (child?.type === "element" || (child?.type === "text" && child.value?.trim()))
          last = child;
      }
      if (last?.type !== "element" || !TRAILING_HOSTS.has(last.tagName ?? "")) break;
      host = last;
    }
    host.children ??= [];
    // Code text ends with a newline, which would push the indicator down a line.
    const tail = host.children.at(-1);
    if (tail?.type === "text" && tail.value?.endsWith("\n")) tail.value = tail.value.slice(0, -1);
    host.children.push({
      type: "element",
      tagName: "span",
      properties: { className: ["chat-typing"], ariaHidden: "true" },
      children: [{ type: "text", value: TYPING_TEXT }],
    });
  };
}

const streamingRehypePlugins = [rehypeTrailingIndicator];

function TypingIndicator() {
  return (
    <span className="chat-typing" aria-hidden="true">
      {TYPING_TEXT}
    </span>
  );
}

function PlainText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <>
      <span>{text}</span>
      {streaming && <TypingIndicator />}
    </>
  );
}

// Last line of defence: a parser or renderer failure must not blank the thread.
class MarkdownBoundary extends Component<
  { text: string; streaming: boolean; children: ReactNode },
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
    return this.state.failed ? (
      <PlainText text={this.props.text} streaming={this.props.streaming} />
    ) : (
      this.props.children
    );
  }
}

// Every streamed delta re-renders the thread; unchanged messages skip the parse.
export const MarkdownText = memo(function MarkdownText({
  text,
  streaming = false,
}: {
  text: string;
  /** Show the running indicator at the end of the last line. */
  streaming?: boolean;
}) {
  if ((streaming && text.length > STREAMING_MARKDOWN_MAX_LENGTH) || !isSafeForMarkdown(text))
    return <PlainText text={text} streaming={streaming} />;
  return (
    <MarkdownBoundary text={text} streaming={streaming}>
      <div className="chat-markdown">
        <Markdown
          allowedElements={ALLOWED_ELEMENTS}
          unwrapDisallowed
          remarkPlugins={remarkPlugins}
          rehypePlugins={streaming ? streamingRehypePlugins : undefined}
          urlTransform={httpsOnly}
          components={components}
        >
          {text}
        </Markdown>
      </div>
    </MarkdownBoundary>
  );
});

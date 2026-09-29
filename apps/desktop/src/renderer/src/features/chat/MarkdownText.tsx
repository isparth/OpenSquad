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

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <Markdown
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        urlTransform={httpsOnly}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
}

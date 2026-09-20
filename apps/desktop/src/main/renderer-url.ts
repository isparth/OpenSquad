import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function expectedRendererUrl(entryUrl?: URL): URL | null {
  const fallback = () => entryUrl ?? pathToFileURL(join(__dirname, "../renderer/index.html"));
  const raw = process.env.ELECTRON_RENDERER_URL;
  if (!raw) return fallback();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  if (url.pathname !== "/") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url;
}

export function isExpectedRendererUrl(candidate: string, entryUrl?: URL): boolean {
  const expected = expectedRendererUrl(entryUrl);
  if (expected === null) return false;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.search !== "" || url.hash !== "") return false;
  if (url.username !== "" || url.password !== "") return false;
  return (
    url.protocol === expected.protocol &&
    url.host === expected.host &&
    url.pathname === expected.pathname
  );
}

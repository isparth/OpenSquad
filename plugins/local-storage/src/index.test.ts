import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStorageProvider } from "./index.js";

describe("LocalStorageProvider", () => {
  let rootDir: string;
  let storage: LocalStorageProvider;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "opensquad-storage-"));
    storage = new LocalStorageProvider({ rootDir, publicBaseUrl: "http://localhost:3000" });
  });

  afterAll(() => rm(rootDir, { recursive: true, force: true }));

  it("writes, reads and deletes an object", async () => {
    const data = new TextEncoder().encode("hello");
    const stored = await storage.put("avatars/a.txt", data, "text/plain");
    expect(stored).toEqual({ key: "avatars/a.txt", size: 5, contentType: "text/plain" });

    const read = await storage.get("avatars/a.txt");
    expect(read && new TextDecoder().decode(read)).toBe("hello");

    await storage.delete("avatars/a.txt");
    expect(await storage.get("avatars/a.txt")).toBeNull();
  });

  it("returns a url for a key", async () => {
    const url = await storage.getSignedUrl("avatars/a.txt", 60);
    expect(url).toMatch(/^http:\/\/localhost:3000\/storage\/avatars%2Fa\.txt\?expires=\d+$/);
  });
});

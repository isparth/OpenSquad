import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { StorageProvider, StoredObject } from "@opensquad/core";

export interface LocalStorageOptions {
  /** Directory files are written to. Created on first write. */
  rootDir: string;
  /** Base URL the API serves files from, used to build "signed" URLs. */
  publicBaseUrl: string;
}

/** Disk-backed StorageProvider for local development. Not for production. */
export class LocalStorageProvider implements StorageProvider {
  readonly name = "local";

  constructor(private readonly options: LocalStorageOptions) {}

  private pathFor(key: string): string {
    const safe = normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
    return join(this.options.rootDir, safe);
  }

  async put(key: string, data: Uint8Array, contentType?: string): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    const { size } = await stat(path);
    return contentType ? { key, size, contentType } : { key, size };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    return `${this.options.publicBaseUrl}/storage/${encodeURIComponent(key)}?expires=${expires}`;
  }
}

import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { RuntimeKeyStatus, RuntimeKeyUnavailableReason } from "../shared/ipc.js";

const VAULT_FILE = "runtime-key.v1.bin";
const TOOLS_VAULT_FILE = "tools-key.v1.bin";
const SUBJECT = "dev-user";
const MAX_CIPHERTEXT_BYTES = 16 * 1024;

export const runtimeKeySchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\s\p{C},]/u.test(value));

const recordSchema = z.strictObject({
  version: z.literal(1),
  subject: z.literal(SUBJECT),
  origin: z.string(),
  key: runtimeKeySchema,
});

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  isAsyncEncryptionAvailable(): Promise<boolean>;
  getSelectedStorageBackend(): string;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>;
}

export interface RuntimeCredentialVaultOptions {
  apiBaseUrl: string;
  development: boolean;
  packaged: boolean;
  platform: NodeJS.Platform;
  userDataPath: string;
  safeStorage: SafeStorageLike;
  /** Vault file inside userData. Defaults to the runtime key file. */
  fileName?: string;
}

export type ReadKeyResult =
  | { ok: true; key: string }
  | { ok: false; reason: RuntimeKeyUnavailableReason };

export interface RuntimeCredentialVault {
  readonly origin: string | null;
  status(): Promise<RuntimeKeyStatus>;
  set(key: string): Promise<RuntimeKeyStatus>;
  delete(): Promise<RuntimeKeyStatus>;
  readKey(): Promise<ReadKeyResult>;
}

function normalizeDevOrigin(apiBaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(apiBaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.origin;
}

export function createRuntimeCredentialVault(
  options: RuntimeCredentialVaultOptions,
): RuntimeCredentialVault {
  const enabled = options.development && !options.packaged;
  const origin = enabled ? normalizeDevOrigin(options.apiBaseUrl) : null;
  const fileName = options.fileName ?? VAULT_FILE;
  if (!/^[a-z][a-z0-9-]*\.v1\.bin$/.test(fileName)) throw new Error("invalid vault file name");
  const file = join(options.userDataPath, fileName);
  const { safeStorage } = options;

  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  }

  type Availability = { ok: true } | { ok: false; reason: RuntimeKeyUnavailableReason };

  async function availability(): Promise<Availability> {
    if (!enabled) return { ok: false, reason: "authentication-required" };
    if (origin === null) return { ok: false, reason: "origin-not-allowed" };
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, reason: "secure-storage-unavailable" };
    }
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      return { ok: false, reason: "secure-storage-unavailable" };
    }
    if (options.platform === "linux") {
      const backend = safeStorage.getSelectedStorageBackend();
      if (backend === "basic_text" || backend === "unknown") {
        return { ok: false, reason: "secure-storage-unavailable" };
      }
    }
    return { ok: true };
  }

  type Stored =
    | { kind: "absent" }
    | { kind: "corrupt" }
    | { kind: "valid"; origin: string; key: string; reEncrypt: boolean };

  async function readStored(): Promise<Stored> {
    let encrypted: Buffer;
    const handle = await open(file, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      return undefined;
    });
    if (handle === null) return { kind: "absent" };
    if (handle === undefined) return { kind: "corrupt" };
    try {
      const buffer = Buffer.alloc(MAX_CIPHERTEXT_BYTES + 1);
      let total = 0;
      for (;;) {
        const { bytesRead } = await handle.read(
          buffer,
          total,
          MAX_CIPHERTEXT_BYTES + 1 - total,
          null,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > MAX_CIPHERTEXT_BYTES) return { kind: "corrupt" };
      }
      encrypted = buffer.subarray(0, total);
    } catch {
      return { kind: "corrupt" };
    } finally {
      await handle.close().catch(() => {});
    }
    let decrypted: { shouldReEncrypt: boolean; result: string };
    try {
      decrypted = await safeStorage.decryptStringAsync(encrypted);
    } catch {
      return { kind: "corrupt" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decrypted.result);
    } catch {
      return { kind: "corrupt" };
    }
    const record = recordSchema.safeParse(parsed);
    if (!record.success) return { kind: "corrupt" };
    return {
      kind: "valid",
      origin: record.data.origin,
      key: record.data.key,
      reEncrypt: decrypted.shouldReEncrypt,
    };
  }

  async function writeEncrypted(ciphertext: Buffer): Promise<void> {
    if (ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) {
      throw new Error("ciphertext exceeds vault bound");
    }
    await mkdir(options.userDataPath, { recursive: true });
    const temp = join(options.userDataPath, `${fileName}.${randomBytes(8).toString("hex")}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(ciphertext);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, file);
      await fsyncDirectory(options.userDataPath);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function fsyncDirectory(dir: string): Promise<void> {
    try {
      const dirHandle = await open(dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {}
  }

  function statusFor(stored: Stored): RuntimeKeyStatus {
    switch (stored.kind) {
      case "absent":
        return { state: "unavailable", reason: "not-configured" };
      case "corrupt":
        return { state: "unavailable", reason: "corrupt-storage" };
      case "valid":
        return stored.origin === origin
          ? { state: "configured" }
          : { state: "unavailable", reason: "origin-changed" };
    }
  }

  async function persistKey(key: string): Promise<void> {
    const plaintext = JSON.stringify({ version: 1, subject: SUBJECT, origin, key });
    await writeEncrypted(await safeStorage.encryptStringAsync(plaintext));
  }

  return {
    origin,

    status: () =>
      serialized(async (): Promise<RuntimeKeyStatus> => {
        const available = await availability();
        if (!available.ok) return { state: "unavailable", reason: available.reason };
        return statusFor(await readStored());
      }),

    set: (key: string) =>
      serialized(async (): Promise<RuntimeKeyStatus> => {
        const available = await availability();
        if (!available.ok) return { state: "unavailable", reason: available.reason };
        if (!runtimeKeySchema.safeParse(key).success) {
          return { state: "unavailable", reason: "not-configured" };
        }
        const stored = await readStored();
        if (stored.kind === "corrupt") {
          return { state: "unavailable", reason: "corrupt-storage" };
        }
        await persistKey(key);
        return { state: "configured" };
      }),

    delete: () =>
      serialized(async (): Promise<RuntimeKeyStatus> => {
        await rm(file, { force: true });
        await fsyncDirectory(options.userDataPath);
        const available = await availability();
        return available.ok
          ? { state: "unavailable", reason: "not-configured" }
          : { state: "unavailable", reason: available.reason };
      }),

    readKey: () =>
      serialized(async (): Promise<ReadKeyResult> => {
        const available = await availability();
        if (!available.ok) return { ok: false, reason: available.reason };
        const stored = await readStored();
        if (stored.kind !== "valid") {
          return {
            ok: false,
            reason: stored.kind === "absent" ? "not-configured" : "corrupt-storage",
          };
        }
        if (stored.origin !== origin) return { ok: false, reason: "origin-changed" };
        if (stored.reEncrypt) {
          const plaintext = JSON.stringify({
            version: 1,
            subject: SUBJECT,
            origin: stored.origin,
            key: stored.key,
          });
          await writeEncrypted(await safeStorage.encryptStringAsync(plaintext));
        }
        return { ok: true, key: stored.key };
      }),
  };
}

export const runtimeVaultFileName = VAULT_FILE;
export const toolsVaultFileName = TOOLS_VAULT_FILE;

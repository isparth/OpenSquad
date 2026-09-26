import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeCredentialVault,
  runtimeVaultFileName,
  type SafeStorageLike,
  toolsVaultFileName,
} from "../src/main/runtime-credentials.js";

const API_URL = "http://localhost:3000";
const KEY = "sk-test-runtime-key";

function fakeSafeStorage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "kwallet6",
    encryptStringAsync: async (plain: string) =>
      Buffer.from(`enc:${Buffer.from(plain, "utf8").toString("base64")}`),
    decryptStringAsync: async (encrypted: Buffer) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("cannot decrypt");
      return {
        shouldReEncrypt: false,
        result: Buffer.from(text.slice(4), "base64").toString("utf8"),
      };
    },
    ...overrides,
  };
}

let dir: string;

function makeVault(overrides: Record<string, unknown> = {}) {
  return createRuntimeCredentialVault({
    apiBaseUrl: API_URL,
    development: true,
    packaged: false,
    platform: "darwin",
    userDataPath: dir,
    safeStorage: fakeSafeStorage(),
    ...overrides,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opensquad-vault-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scope policy", () => {
  it("refuses packaged/production with authentication-required", async () => {
    for (const opts of [
      { packaged: true },
      { development: false },
      { development: false, packaged: true },
    ]) {
      const vault = makeVault(opts);
      expect(await vault.status()).toEqual({
        state: "unavailable",
        reason: "authentication-required",
      });
      expect(await vault.set(KEY)).toEqual({
        state: "unavailable",
        reason: "authentication-required",
      });
      expect(await vault.readKey()).toEqual({ ok: false, reason: "authentication-required" });
    }
  });

  it("packaged cannot be overridden by the development flag", async () => {
    const vault = makeVault({ development: true, packaged: true });
    expect(await vault.status()).toEqual({
      state: "unavailable",
      reason: "authentication-required",
    });
  });

  it.each([
    "https://localhost:3000",
    "http://example.com",
    "http://localhost:3000/api",
    "http://localhost:3000/?x=1",
    "http://user@localhost:3000",
    "not-a-url",
  ])("rejects non-origin or non-loopback url %s", async (apiBaseUrl) => {
    const vault = makeVault({ apiBaseUrl });
    expect(await vault.status()).toEqual({
      state: "unavailable",
      reason: "origin-not-allowed",
    });
  });

  it.each(["http://127.0.0.1:3000", "http://[::1]:3000", "http://localhost:3000"])(
    "accepts origin-only loopback url %s",
    async (apiBaseUrl) => {
      const vault = makeVault({ apiBaseUrl });
      expect(await vault.status()).toEqual({
        state: "unavailable",
        reason: "not-configured",
      });
    },
  );
});

describe("secure storage availability", () => {
  it("requires sync and async encryption", async () => {
    const syncOff = makeVault({
      safeStorage: fakeSafeStorage({ isEncryptionAvailable: () => false }),
    });
    expect(await syncOff.status()).toEqual({
      state: "unavailable",
      reason: "secure-storage-unavailable",
    });
    const asyncOff = makeVault({
      safeStorage: fakeSafeStorage({ isAsyncEncryptionAvailable: async () => false }),
    });
    expect(await asyncOff.status()).toEqual({
      state: "unavailable",
      reason: "secure-storage-unavailable",
    });
  });

  it.each(["basic_text", "unknown"])("rejects unprotected linux backend %s", async (backend) => {
    const vault = makeVault({
      platform: "linux",
      safeStorage: fakeSafeStorage({ getSelectedStorageBackend: () => backend }),
    });
    expect(await vault.status()).toEqual({
      state: "unavailable",
      reason: "secure-storage-unavailable",
    });
    expect(await vault.set(KEY)).toEqual({
      state: "unavailable",
      reason: "secure-storage-unavailable",
    });
  });

  it("accepts a protected linux backend", async () => {
    const vault = makeVault({ platform: "linux" });
    expect(await vault.set(KEY)).toEqual({ state: "configured" });
  });
});

describe("storage lifecycle", () => {
  it("stores ciphertext only; file lacks key, origin, and subject", async () => {
    const vault = makeVault();
    expect(await vault.set(KEY)).toEqual({ state: "configured" });
    expect(await vault.status()).toEqual({ state: "configured" });
    const raw = await readFile(join(dir, runtimeVaultFileName), "utf8");
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain("localhost");
    expect(raw).not.toContain("dev-user");
  });

  it("survives a restart: a new vault decrypts, reports, and reads the key", async () => {
    const safeStorage = fakeSafeStorage();
    await makeVault({ safeStorage }).set(KEY);
    const restarted = makeVault({ safeStorage });
    expect(await restarted.status()).toEqual({ state: "configured" });
    expect(await restarted.readKey()).toEqual({ ok: true, key: KEY });
  });

  it("status never returns the key", async () => {
    const vault = makeVault();
    await vault.set(KEY);
    const status = await vault.status();
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("reports origin-changed for a valid record from another origin and never reads it", async () => {
    const safeStorage = fakeSafeStorage();
    await makeVault({ safeStorage, apiBaseUrl: "http://localhost:3000" }).set(KEY);
    const other = makeVault({ safeStorage, apiBaseUrl: "http://127.0.0.1:3000" });
    expect(await other.status()).toEqual({ state: "unavailable", reason: "origin-changed" });
    expect(await other.readKey()).toEqual({ ok: false, reason: "origin-changed" });
    expect(await other.set("new-key")).toEqual({ state: "configured" });
    expect(await other.readKey()).toEqual({ ok: true, key: "new-key" });
  });

  it("never decrypts when persistence is disabled", async () => {
    const decryptStringAsync = vi.fn();
    const vault = makeVault({
      packaged: true,
      safeStorage: fakeSafeStorage({ decryptStringAsync }),
    });
    await writeFile(join(dir, runtimeVaultFileName), "garbage");
    expect(await vault.status()).toEqual({
      state: "unavailable",
      reason: "authentication-required",
    });
    expect(decryptStringAsync).not.toHaveBeenCalled();
  });

  it("classifies an over-limit ciphertext file as corrupt without reading it fully", async () => {
    const vault = makeVault();
    await writeFile(join(dir, runtimeVaultFileName), Buffer.alloc(17 * 1024, 0x61));
    expect(await vault.status()).toEqual({ state: "unavailable", reason: "corrupt-storage" });
    expect(await vault.readKey()).toEqual({ ok: false, reason: "corrupt-storage" });
  });

  it("reports corrupt-storage for undecryptable or malformed files", async () => {
    const vault = makeVault();
    await writeFile(join(dir, runtimeVaultFileName), "not-ciphertext");
    expect(await vault.status()).toEqual({ state: "unavailable", reason: "corrupt-storage" });
    expect(await vault.readKey()).toEqual({ ok: false, reason: "corrupt-storage" });

    const safeStorage = fakeSafeStorage();
    const malformed = await safeStorage.encryptStringAsync(
      JSON.stringify({
        version: 1,
        subject: "someone-else",
        origin: "http://localhost:3000",
        key: KEY,
      }),
    );
    await writeFile(join(dir, runtimeVaultFileName), malformed);
    expect(await vault.status()).toEqual({ state: "unavailable", reason: "corrupt-storage" });
  });

  it("set refuses to replace corrupt storage until an explicit delete", async () => {
    const vault = makeVault();
    await writeFile(join(dir, runtimeVaultFileName), "garbage");
    expect(await vault.set(KEY)).toEqual({ state: "unavailable", reason: "corrupt-storage" });
    expect(await vault.delete()).toEqual({ state: "unavailable", reason: "not-configured" });
    expect(await vault.set(KEY)).toEqual({ state: "configured" });
  });

  it("delete removes the file without decrypting", async () => {
    const decrypt = async () => {
      throw new Error("decrypt should not be called");
    };
    const vault = makeVault({ safeStorage: fakeSafeStorage({ decryptStringAsync: decrypt }) });
    await writeFile(join(dir, runtimeVaultFileName), "garbage");
    expect(await vault.delete()).toEqual({ state: "unavailable", reason: "not-configured" });
    await expect(stat(join(dir, runtimeVaultFileName))).rejects.toThrow();
  });

  it("refuses oversized ciphertext from encryptStringAsync and leaves no files", async () => {
    const vault = makeVault({
      safeStorage: fakeSafeStorage({
        encryptStringAsync: async () => Buffer.alloc(17 * 1024, 0x61),
      }),
    });
    await expect(vault.set(KEY)).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it("writes with mode 0600 via an exclusive temp file that is cleaned up", async () => {
    const vault = makeVault();
    await vault.set(KEY);
    const fileStat = await stat(join(dir, runtimeVaultFileName));
    expect(fileStat.mode & 0o777).toBe(0o600);
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("serializes concurrent operations", async () => {
    const vault = makeVault();
    const results = await Promise.all([
      vault.set("key-one"),
      vault.delete(),
      vault.set("key-two"),
      vault.status(),
      vault.delete(),
    ]);
    for (const result of results) {
      expect(result).toHaveProperty("state");
    }
    expect(await vault.status()).toEqual({ state: "unavailable", reason: "not-configured" });
  });

  it("rejects keys with whitespace or control characters", async () => {
    const vault = makeVault();
    for (const bad of ["has space", "tab\there", "new\nline", "has,comma", "", "x".repeat(4097)]) {
      expect(await vault.set(bad)).toEqual({ state: "unavailable", reason: "not-configured" });
    }
    expect(await vault.set("x".repeat(4096))).toEqual({ state: "configured" });
  });
});

describe("separate vault files", () => {
  it("keeps the tools key in its own file without touching the runtime key", async () => {
    const runtime = makeVault();
    const tools = makeVault({ fileName: toolsVaultFileName });
    expect(toolsVaultFileName).toBe("tools-key.v1.bin");
    expect(await tools.set("ak_tools")).toEqual({ state: "configured" });
    expect(await runtime.status()).toEqual({ state: "unavailable", reason: "not-configured" });
    expect(await runtime.set(KEY)).toEqual({ state: "configured" });
    expect(await tools.readKey()).toEqual({ ok: true, key: "ak_tools" });
    expect(await runtime.readKey()).toEqual({ ok: true, key: KEY });
    expect((await readdir(dir)).sort()).toEqual([runtimeVaultFileName, toolsVaultFileName].sort());
    expect((await stat(join(dir, toolsVaultFileName))).mode & 0o777).toBe(0o600);
    await tools.delete();
    expect(await tools.status()).toEqual({ state: "unavailable", reason: "not-configured" });
    expect(await runtime.readKey()).toEqual({ ok: true, key: KEY });
  });

  it("applies the same development-only policy to the tools vault", async () => {
    const tools = makeVault({ fileName: toolsVaultFileName, packaged: true });
    expect(await tools.set("ak_tools")).toEqual({
      state: "unavailable",
      reason: "authentication-required",
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects file names that are not plain vault names", () => {
    for (const fileName of ["../escape.bin", "a/b.bin", "", "x.txt"]) {
      expect(() => makeVault({ fileName })).toThrow();
    }
  });
});

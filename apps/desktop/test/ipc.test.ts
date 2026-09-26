import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../src/shared/ipc.js";

const RENDERER_URL = "http://localhost:5173/";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "77777777-7777-4777-8777-777777777777";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, arg: unknown) => Promise<unknown>>(),
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.0-test" },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, arg: unknown) => Promise<unknown>) =>
      mocks.handlers.set(channel, fn),
  },
}));

import { type IpcController, registerIpc } from "../src/main/ipc.js";
import { expectedRendererUrl } from "../src/main/renderer-url.js";
import type { RuntimeCommands } from "../src/main/runtime-commands.js";
import type { RuntimeCredentialVault } from "../src/main/runtime-credentials.js";
import type { ToolsCommands } from "../src/main/tools-commands.js";

class FakeWebContents extends EventEmitter {
  destroyed = false;
  mainFrame: { url: string };
  constructor(url = RENDERER_URL) {
    super();
    this.mainFrame = { url };
  }
  isDestroyed() {
    return this.destroyed;
  }
}

function fakeWindow(wc: FakeWebContents) {
  return { webContents: wc } as never;
}

function eventFor(wc: FakeWebContents, frame: { url: string } | null = wc.mainFrame) {
  return { sender: wc, senderFrame: frame } as never;
}

let controller: IpcController;
let vault: RuntimeCredentialVault;
let commands: RuntimeCommands;
let toolsVault: RuntimeCredentialVault;
let toolsCommands: ToolsCommands;

beforeEach(() => {
  mocks.handlers.clear();
  vi.stubEnv("ELECTRON_RENDERER_URL", RENDERER_URL);
  vault = {
    origin: "http://localhost:3000",
    status: vi.fn(async () => ({ state: "configured" })),
    set: vi.fn(async (key: string) => ({ state: "configured", key })),
    delete: vi.fn(async () => ({ state: "unavailable", reason: "not-configured" })),
    readKey: vi.fn(async () => ({ ok: true, key: "k" })),
  } as unknown as RuntimeCredentialVault;
  commands = {
    sendMessage: vi.fn(async (_c, signal: AbortSignal) => ({ signal })),
    cancelRun: vi.fn(async (_c, signal: AbortSignal) => ({ signal })),
    reconcileRun: vi.fn(async (_c, signal: AbortSignal) => ({ signal })),
    refreshMemory: vi.fn(async (_c, signal: AbortSignal) => ({ update: null, signal })),
    abortAll: vi.fn(),
  } as unknown as RuntimeCommands;
  toolsVault = {
    origin: "http://localhost:3000",
    status: vi.fn(async () => ({ state: "unavailable", reason: "not-configured" })),
    set: vi.fn(async () => ({ state: "configured" })),
    delete: vi.fn(async () => ({ state: "unavailable", reason: "not-configured" })),
    readKey: vi.fn(async () => ({ ok: true, key: "t" })),
  } as unknown as RuntimeCredentialVault;
  toolsCommands = {
    listToolkits: vi.fn(async () => ({ items: [], nextCursor: null })),
    listConnections: vi.fn(async () => ({ items: [] })),
    startConnection: vi.fn(async () => ({ connectionId: "ca_new1" })),
    removeConnection: vi.fn(async () => undefined),
    abortAll: vi.fn(),
  } as unknown as ToolsCommands;
  controller = registerIpc({ vault, commands, toolsVault, toolsCommands });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function invoke(channel: string, event: unknown, arg?: unknown) {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler(event, arg);
}

describe("sender trust", () => {
  it("rejects an unknown webContents", async () => {
    const wc = new FakeWebContents();
    await expect(invoke(IPC.getApiBaseUrl, eventFor(wc))).rejects.toThrow("untrusted sender");
  });

  it("rejects a subframe sender", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    await expect(invoke(IPC.getApiBaseUrl, eventFor(wc, { url: RENDERER_URL }))).rejects.toThrow(
      "untrusted sender",
    );
    await expect(invoke(IPC.getApiBaseUrl, eventFor(wc, null))).rejects.toThrow("untrusted sender");
  });

  it.each([
    "https://evil.example/",
    `${RENDERER_URL}?x=1`,
    `${RENDERER_URL}#hash`,
    `${RENDERER_URL}other/path`,
  ])("rejects untrusted or non-canonical url %s", async (url) => {
    const wc = new FakeWebContents(url);
    controller.trustWindow(fakeWindow(wc));
    await expect(invoke(IPC.getApiBaseUrl, eventFor(wc))).rejects.toThrow("untrusted sender");
  });

  it("accepts a trusted main frame at the canonical renderer URL", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    await expect(invoke(IPC.getApiBaseUrl, eventFor(wc))).resolves.toContain("localhost");
  });

  it("rejects a credential-bearing candidate URL", async () => {
    const wc = new FakeWebContents("http://user:pass@localhost:5173/");
    controller.trustWindow(fakeWindow(wc));
    await expect(invoke(IPC.getApiBaseUrl, eventFor(wc))).rejects.toThrow("untrusted sender");
  });

  it.each(["https://evil.example/", "http://localhost:5173/nested"])(
    "rejects everything when the dev renderer URL is %s",
    async (url) => {
      vi.stubEnv("ELECTRON_RENDERER_URL", url);
      const wc = new FakeWebContents(url);
      controller.trustWindow(fakeWindow(wc));
      await expect(invoke(IPC.getApiBaseUrl, eventFor(wc))).rejects.toThrow("untrusted sender");
      const fileWc = new FakeWebContents("file:///any/renderer/index.html");
      controller.trustWindow(fakeWindow(fileWc));
      await expect(invoke(IPC.getApiBaseUrl, eventFor(fileWc))).rejects.toThrow("untrusted sender");
    },
  );

  it("accepts the local file renderer when ELECTRON_RENDERER_URL is absent", async () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "");
    const expected = expectedRendererUrl();
    expect(expected?.protocol).toBe("file:");
    const wc = new FakeWebContents((expected as URL).href);
    controller.trustWindow(fakeWindow(wc));
    await expect(invoke(IPC.getApiBaseUrl, eventFor(wc))).resolves.toContain("localhost");
  });

  it("trusts a recreated window", async () => {
    const first = new FakeWebContents();
    controller.trustWindow(fakeWindow(first));
    first.destroyed = true;
    first.emit("destroyed");
    const second = new FakeWebContents();
    controller.trustWindow(fakeWindow(second));
    await expect(invoke(IPC.getApiBaseUrl, eventFor(second))).resolves.toBeDefined();
    await expect(invoke(IPC.getApiBaseUrl, eventFor(first))).rejects.toThrow("untrusted sender");
  });
});

describe("revocation", () => {
  it("aborts in-flight commands on main-frame navigation", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    let captured: AbortSignal | undefined;
    (commands.cancelRun as ReturnType<typeof vi.fn>).mockImplementation(
      (_c: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          captured = signal;
          signal.addEventListener("abort", () => resolve({ aborted: true }));
        }),
    );
    const pending = invoke(IPC.cancelRun, eventFor(wc), { runId: RUN_ID });
    await Promise.resolve();
    wc.emit("did-start-navigation", { isMainFrame: true });
    await expect(pending).resolves.toEqual({ aborted: true });
    expect(captured?.aborted).toBe(true);
  });

  it("aborts in-flight commands on destroy and fails post-await recheck", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    (commands.cancelRun as ReturnType<typeof vi.fn>).mockImplementation(
      (_c: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ late: true }));
        }),
    );
    const pending = invoke(IPC.cancelRun, eventFor(wc), { runId: RUN_ID });
    await Promise.resolve();
    wc.destroyed = true;
    wc.emit("destroyed");
    await expect(pending).rejects.toThrow("untrusted sender");
  });

  it("rejects when the frame URL changes during await without destroying", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    (commands.cancelRun as ReturnType<typeof vi.fn>).mockImplementation(
      (_c: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          queueMicrotask(() => {
            wc.mainFrame.url = "https://evil.example/";
          });
          signal.addEventListener("abort", () => resolve({ aborted: true }));
        }),
    );
    const pending = invoke(IPC.cancelRun, eventFor(wc), { runId: RUN_ID });
    await Promise.resolve();
    wc.emit("did-start-navigation", { isMainFrame: true });
    await expect(pending).rejects.toThrow("untrusted sender");
  });

  it("rejects when the main frame object changes during await", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    (commands.cancelRun as ReturnType<typeof vi.fn>).mockImplementation(() => {
      wc.mainFrame = { url: RENDERER_URL };
      return Promise.resolve({ ok: true });
    });
    await expect(invoke(IPC.cancelRun, eventFor(wc), { runId: RUN_ID })).rejects.toThrow(
      "untrusted sender",
    );
  });

  it("ignores subframe navigation", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    let captured: AbortSignal | undefined;
    (commands.cancelRun as ReturnType<typeof vi.fn>).mockImplementation(
      (_c: unknown, signal: AbortSignal) => {
        captured = signal;
        return Promise.resolve({ ok: true });
      },
    );
    const pending = invoke(IPC.cancelRun, eventFor(wc), { runId: RUN_ID });
    wc.emit("did-start-navigation", { isMainFrame: false });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(captured?.aborted).toBe(false);
  });

  it("shutdown aborts all in-flight requests", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    (commands.cancelRun as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}),
    );
    const pending = invoke(IPC.cancelRun, eventFor(wc), { runId: RUN_ID });
    pending.catch(() => {});
    await Promise.resolve();
    controller.shutdown();
    expect(commands.abortAll).toHaveBeenCalled();
    expect(toolsCommands.abortAll).toHaveBeenCalled();
  });
});

describe("argument validation", () => {
  it("rejects oversized and malformed arguments with a static error", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    await expect(
      invoke(IPC.sendMessage, eventFor(wc), {
        conversationId: "nope",
        text: "hi",
        clientRequestId: RUN_ID,
      }),
    ).rejects.toThrow("invalid request");
    await expect(invoke(IPC.setRuntimeKey, eventFor(wc), "has spaces")).rejects.toThrow(
      "invalid request",
    );
    await expect(invoke(IPC.setRuntimeKey, eventFor(wc), "has,comma")).rejects.toThrow(
      "invalid request",
    );
    await expect(invoke(IPC.setRuntimeKey, eventFor(wc), { key: "x" })).rejects.toThrow(
      "invalid request",
    );
    expect(commands.sendMessage).not.toHaveBeenCalled();
    expect(vault.set).not.toHaveBeenCalled();
  });

  it("registers and validates the refreshMemory command", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    await expect(
      invoke(IPC.refreshMemory, eventFor(wc), { agentId: AGENT_ID }),
    ).resolves.toMatchObject({ update: null, signal: expect.any(AbortSignal) });
    expect(commands.refreshMemory).toHaveBeenCalledWith(
      { agentId: AGENT_ID },
      expect.any(AbortSignal),
    );
    await expect(invoke(IPC.refreshMemory, eventFor(wc), { agentId: "invalid" })).rejects.toThrow(
      "invalid request",
    );
    expect(commands.refreshMemory).toHaveBeenCalledOnce();
  });

  it("rejects a provided argument on no-argument methods", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    for (const channel of [
      IPC.getAppInfo,
      IPC.getApiBaseUrl,
      IPC.getRuntimeKeyStatus,
      IPC.deleteRuntimeKey,
      IPC.getToolsKeyStatus,
      IPC.deleteToolsKey,
      IPC.listToolConnections,
    ]) {
      await expect(invoke(channel, eventFor(wc), { extra: 1 })).rejects.toThrow("invalid request");
    }
  });
});

describe("tools channels", () => {
  it("routes key operations to the tools vault only", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    await expect(invoke(IPC.getToolsKeyStatus, eventFor(wc))).resolves.toEqual({
      state: "unavailable",
      reason: "not-configured",
    });
    await expect(invoke(IPC.setToolsKey, eventFor(wc), "ak_valid")).resolves.toEqual({
      state: "configured",
    });
    await invoke(IPC.deleteToolsKey, eventFor(wc));
    expect(toolsVault.set).toHaveBeenCalledWith("ak_valid");
    expect(toolsVault.delete).toHaveBeenCalled();
    expect(vault.set).not.toHaveBeenCalled();
    expect(vault.delete).not.toHaveBeenCalled();
    await expect(invoke(IPC.setToolsKey, eventFor(wc), "has space")).rejects.toThrow(
      "invalid request",
    );
  });

  it("validates and forwards tools commands with an abort signal", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    await invoke(IPC.listToolkits, eventFor(wc), { search: "git" });
    expect(toolsCommands.listToolkits).toHaveBeenCalledWith(
      { search: "git" },
      expect.any(AbortSignal),
    );
    await invoke(IPC.listToolConnections, eventFor(wc));
    expect(toolsCommands.listConnections).toHaveBeenCalledWith(expect.any(AbortSignal));
    await expect(
      invoke(IPC.startToolConnection, eventFor(wc), { toolkit: "github" }),
    ).resolves.toEqual({ connectionId: "ca_new1" });
    await invoke(IPC.removeToolConnection, eventFor(wc), { connectionId: "ca_github1" });
    expect(toolsCommands.removeConnection).toHaveBeenCalledWith(
      { connectionId: "ca_github1" },
      expect.any(AbortSignal),
    );
    for (const [channel, arg] of [
      [IPC.listToolkits, { search: "x".repeat(101) }],
      [IPC.listToolkits, { search: "git", extra: 1 }],
      [IPC.listToolkits, undefined],
      [IPC.startToolConnection, { toolkit: "GitHub" }],
      [IPC.startToolConnection, { toolkit: "github", url: "https://evil.example" }],
      [IPC.removeToolConnection, { connectionId: "../x" }],
    ] as const) {
      await expect(invoke(channel, eventFor(wc), arg)).rejects.toThrow("invalid request");
    }
    expect(toolsCommands.startConnection).toHaveBeenCalledOnce();
  });

  it("passes static tools errors through and hides others", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    for (const message of [
      "tools credential unavailable",
      "tools key rejected",
      "unable to open browser",
      "too many active tools commands",
      "tools command rate limit exceeded",
    ]) {
      (toolsCommands.listConnections as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error(message),
      );
      await expect(invoke(IPC.listToolConnections, eventFor(wc))).rejects.toThrow(message);
    }
    (toolsCommands.listConnections as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("https://connect.composio.dev/link/lk_secret"),
    );
    await expect(invoke(IPC.listToolConnections, eventFor(wc))).rejects.toThrow(/^request failed$/);
  });

  it("shares the vault mutation limit with the runtime key", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    for (let i = 0; i < 10; i += 1) await invoke(IPC.deleteToolsKey, eventFor(wc));
    await expect(invoke(IPC.deleteRuntimeKey, eventFor(wc))).rejects.toThrow("rate limited");
  });
});

describe("rate limits", () => {
  it("limits each webContents to 120 invokes per minute", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    for (let i = 0; i < 120; i += 1) {
      await invoke(IPC.getApiBaseUrl, eventFor(wc));
    }
    await expect(invoke(IPC.getApiBaseUrl, eventFor(wc))).rejects.toThrow("rate limited");
    const other = new FakeWebContents();
    controller.trustWindow(fakeWindow(other));
    await expect(invoke(IPC.getApiBaseUrl, eventFor(other))).resolves.toBeDefined();
  });

  it("limits vault status polls without starving mutations", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    for (let i = 0; i < 60; i += 1) {
      await invoke(IPC.getRuntimeKeyStatus, eventFor(wc));
    }
    await expect(invoke(IPC.getRuntimeKeyStatus, eventFor(wc))).rejects.toThrow("rate limited");
    await expect(invoke(IPC.deleteRuntimeKey, eventFor(wc))).resolves.toBeDefined();
    expect(vault.delete).toHaveBeenCalled();
  });

  it("rate-limits the 11th vault mutation per minute", async () => {
    const wc = new FakeWebContents();
    controller.trustWindow(fakeWindow(wc));
    for (let i = 0; i < 10; i += 1) {
      await invoke(IPC.deleteRuntimeKey, eventFor(wc));
    }
    await expect(invoke(IPC.deleteRuntimeKey, eventFor(wc))).rejects.toThrow("rate limited");
    await expect(invoke(IPC.setRuntimeKey, eventFor(wc), "valid-key")).rejects.toThrow(
      "rate limited",
    );
  });
});

describe("bridge surface", () => {
  it("exposes no plaintext key getter or generic invoke", async () => {
    const { contextBridge } = await import("electron");
    await import("../src/preload/index.js");
    const expose = contextBridge.exposeInMainWorld as ReturnType<typeof vi.fn>;
    const bridge = expose.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(bridge).sort()).toEqual(
      [
        "cancelRun",
        "deleteRuntimeKey",
        "deleteToolsKey",
        "getToolsKeyStatus",
        "listToolConnections",
        "listToolkits",
        "removeToolConnection",
        "setToolsKey",
        "startToolConnection",
        "getApiBaseUrl",
        "getAppInfo",
        "getRuntimeKeyStatus",
        "reconcileRun",
        "refreshMemory",
        "sendMessage",
        "setRuntimeKey",
      ].sort(),
    );
    expect(bridge).not.toHaveProperty("getRuntimeKey");
    expect(bridge).not.toHaveProperty("getToolsKey");
    expect(bridge).not.toHaveProperty("invoke");
  });
});

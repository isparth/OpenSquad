import {
  app,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  type WebContents,
} from "electron";
import { z } from "zod";
import { type AppInfo, IPC } from "../shared/ipc.js";
import { config } from "./config.js";
import { isExpectedRendererUrl } from "./renderer-url.js";
import {
  type RuntimeCommands,
  refreshMemoryCommandSchema,
  runCommandSchema,
  sendMessageCommandSchema,
} from "./runtime-commands.js";
import { type RuntimeCredentialVault, runtimeKeySchema } from "./runtime-credentials.js";

const STATIC_ERRORS = new Set([
  "untrusted sender",
  "rate limited",
  "invalid request",
  "request failed",
  "request aborted",
  "request timed out",
  "invalid response",
  "response too large",
  "runtime credential unavailable",
  "too many active runtime commands",
  "runtime command rate limit exceeded",
  "request rejected",
  "authentication required",
  "resource not found",
  "request conflict",
  "service unavailable",
]);

const MAX_INVOKES_PER_MINUTE = 120;
const MAX_VAULT_STATUS_PER_MINUTE = 60;
const MAX_VAULT_MUTATIONS_PER_MINUTE = 10;
const RATE_WINDOW_MS = 60_000;

const noArgs = z.undefined();

export interface IpcController {
  trustWindow(window: BrowserWindow): void;
  shutdown(): void;
}

export interface RegisterIpcDeps {
  vault: RuntimeCredentialVault;
  commands: RuntimeCommands;
}

export function registerIpc(deps: RegisterIpcDeps): IpcController {
  const { vault, commands } = deps;
  const trusted = new Set<WebContents>();
  const inFlight = new Map<WebContents, Set<AbortController>>();
  const invokeTimes = new Map<WebContents, number[]>();
  const vaultStatusTimes: number[] = [];
  const vaultMutationTimes: number[] = [];

  function revokeInFlight(sender: WebContents): void {
    const controllers = inFlight.get(sender);
    if (!controllers) return;
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }

  function revoke(sender: WebContents): void {
    revokeInFlight(sender);
    inFlight.delete(sender);
    invokeTimes.delete(sender);
    trusted.delete(sender);
  }

  /** Reject IPC from anything that is not our own renderer. Security checklist item 17. */
  function trustedSender(event: IpcMainInvokeEvent): boolean {
    const sender = event.sender;
    if (!trusted.has(sender)) return false;
    const frame = event.senderFrame;
    if (frame === null || frame !== sender.mainFrame) return false;
    return isExpectedRendererUrl(frame.url);
  }

  function consumeInvokeQuota(sender: WebContents): boolean {
    const now = Date.now();
    const times = invokeTimes.get(sender) ?? [];
    while (times.length > 0 && (times[0] ?? 0) <= now - RATE_WINDOW_MS) times.shift();
    if (times.length >= MAX_INVOKES_PER_MINUTE) return false;
    times.push(now);
    invokeTimes.set(sender, times);
    return true;
  }

  function consumeQuota(times: number[], max: number): boolean {
    const now = Date.now();
    while (times.length > 0 && (times[0] ?? 0) <= now - RATE_WINDOW_MS) times.shift();
    if (times.length >= max) return false;
    times.push(now);
    return true;
  }

  function track(sender: WebContents, controller: AbortController): void {
    let set = inFlight.get(sender);
    if (!set) {
      set = new Set();
      inFlight.set(sender, set);
    }
    set.add(controller);
  }

  function untrack(sender: WebContents, controller: AbortController): void {
    const set = inFlight.get(sender);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) inFlight.delete(sender);
  }

  function staticError(error: unknown): Error {
    if (error instanceof Error && STATIC_ERRORS.has(error.message)) return error;
    return new Error("request failed");
  }

  function handle<A, R>(
    channel: string,
    argSchema: z.ZodType<A>,
    fn: (arg: A, signal: AbortSignal) => R | Promise<R>,
  ): void {
    ipcMain.handle(channel, async (event, rawArg) => {
      try {
        if (!trustedSender(event)) throw new Error("untrusted sender");
        if (!consumeInvokeQuota(event.sender)) throw new Error("rate limited");
        const parsed = argSchema.safeParse(rawArg);
        if (!parsed.success) throw new Error("invalid request");
        const controller = new AbortController();
        track(event.sender, controller);
        try {
          const result = await fn(parsed.data, controller.signal);
          if (!trustedSender(event) || event.sender.isDestroyed()) {
            throw new Error("untrusted sender");
          }
          return result;
        } finally {
          untrack(event.sender, controller);
        }
      } catch (error) {
        throw staticError(error);
      }
    });
  }

  function vaultOp<A, R>(
    times: number[],
    max: number,
    fn: (arg: A) => R | Promise<R>,
  ): (arg: A) => Promise<R> {
    return async (arg: A) => {
      if (!consumeQuota(times, max)) throw new Error("rate limited");
      return fn(arg);
    };
  }

  handle(
    IPC.getAppInfo,
    noArgs,
    (): AppInfo => ({
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron ?? "unknown",
    }),
  );

  handle(IPC.getApiBaseUrl, noArgs, () => config.apiBaseUrl);

  handle(
    IPC.getRuntimeKeyStatus,
    noArgs,
    vaultOp(vaultStatusTimes, MAX_VAULT_STATUS_PER_MINUTE, () => vault.status()),
  );
  handle(
    IPC.setRuntimeKey,
    runtimeKeySchema,
    vaultOp(vaultMutationTimes, MAX_VAULT_MUTATIONS_PER_MINUTE, (key: string) => vault.set(key)),
  );
  handle(
    IPC.deleteRuntimeKey,
    noArgs,
    vaultOp(vaultMutationTimes, MAX_VAULT_MUTATIONS_PER_MINUTE, () => vault.delete()),
  );

  handle(IPC.sendMessage, sendMessageCommandSchema, (command, signal) =>
    commands.sendMessage(command, signal),
  );
  handle(IPC.cancelRun, runCommandSchema, (command, signal) => commands.cancelRun(command, signal));
  handle(IPC.reconcileRun, runCommandSchema, (command, signal) =>
    commands.reconcileRun(command, signal),
  );
  handle(IPC.refreshMemory, refreshMemoryCommandSchema, (command, signal) =>
    commands.refreshMemory(command, signal),
  );

  return {
    trustWindow(window: BrowserWindow): void {
      const sender = window.webContents;
      trusted.add(sender);
      sender.on("did-start-navigation", (details) => {
        if (details.isMainFrame) revokeInFlight(sender);
      });
      sender.on("destroyed", () => revoke(sender));
    },
    shutdown(): void {
      for (const sender of [...inFlight.keys()]) revokeInFlight(sender);
      commands.abortAll();
    },
  };
}

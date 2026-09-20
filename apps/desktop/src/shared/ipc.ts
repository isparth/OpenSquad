/**
 * The contract between renderer and main. Both sides import from here so a
 * renamed channel or changed payload fails typecheck instead of failing at runtime.
 */
import type { ConversationMessage, ConversationRun } from "@opensquad/core";

export const IPC = {
  getAppInfo: "app:get-info",
  getApiBaseUrl: "config:get-api-base-url",
  getRuntimeKeyStatus: "runtime:get-key-status",
  setRuntimeKey: "runtime:set-key",
  deleteRuntimeKey: "runtime:delete-key",
  sendMessage: "runtime:send-message",
  cancelRun: "runtime:cancel-run",
  reconcileRun: "runtime:reconcile-run",
} as const;

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  electron: string;
}

export type RuntimeKeyUnavailableReason =
  | "not-configured"
  | "secure-storage-unavailable"
  | "authentication-required"
  | "origin-not-allowed"
  | "origin-changed"
  | "corrupt-storage";

export type RuntimeKeyStatus =
  | { state: "configured" }
  | { state: "unavailable"; reason: RuntimeKeyUnavailableReason };

export interface SendMessageCommand {
  conversationId: string;
  text: string;
  clientRequestId: string;
}

export interface RunCommand {
  runId: string;
}

export interface SendMessageResult {
  message: ConversationMessage;
  run: ConversationRun;
}

export interface RunResult {
  run: ConversationRun;
}

/** What the renderer sees as `window.opensquad`. */
export interface DesktopBridge {
  getAppInfo(): Promise<AppInfo>;
  getApiBaseUrl(): Promise<string>;
  getRuntimeKeyStatus(): Promise<RuntimeKeyStatus>;
  setRuntimeKey(key: string): Promise<RuntimeKeyStatus>;
  deleteRuntimeKey(): Promise<RuntimeKeyStatus>;
  sendMessage(command: SendMessageCommand): Promise<SendMessageResult>;
  cancelRun(command: RunCommand): Promise<RunResult>;
  reconcileRun(command: RunCommand): Promise<RunResult>;
}

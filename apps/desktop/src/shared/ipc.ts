/**
 * The contract between renderer and main. Both sides import from here so a
 * renamed channel or changed payload fails typecheck instead of failing at runtime.
 */
import type {
  ConversationMessage,
  ConversationRun,
  MemoryUpdate,
  ToolConnection,
  Toolkit,
} from "@opensquad/core";

export const IPC = {
  getAppInfo: "app:get-info",
  getApiBaseUrl: "config:get-api-base-url",
  getRuntimeKeyStatus: "runtime:get-key-status",
  setRuntimeKey: "runtime:set-key",
  deleteRuntimeKey: "runtime:delete-key",
  sendMessage: "runtime:send-message",
  cancelRun: "runtime:cancel-run",
  reconcileRun: "runtime:reconcile-run",
  refreshMemory: "runtime:refresh-memory",
  getToolsKeyStatus: "tools:get-key-status",
  setToolsKey: "tools:set-key",
  deleteToolsKey: "tools:delete-key",
  listToolkits: "tools:list-toolkits",
  listToolConnections: "tools:list-connections",
  startToolConnection: "tools:start-connection",
  removeToolConnection: "tools:remove-connection",
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

export interface RefreshMemoryCommand {
  agentId: string;
}

export interface SendMessageResult {
  message: ConversationMessage;
  run: ConversationRun;
}

export interface RunResult {
  run: ConversationRun;
}

export interface RefreshMemoryResult {
  update: MemoryUpdate | null;
}

export type ToolsKeyStatus = RuntimeKeyStatus;

export interface ListToolkitsCommand {
  search?: string | undefined;
  cursor?: string | undefined;
}

export interface ListToolkitsResult {
  items: Toolkit[];
  nextCursor: string | null;
}

export interface ToolConnectionsResult {
  items: ToolConnection[];
}

export interface StartToolConnectionCommand {
  toolkit: string;
}

/** The Connect Link is opened by main and never returned to the renderer. */
export interface StartToolConnectionResult {
  connectionId: string;
}

export interface RemoveToolConnectionCommand {
  connectionId: string;
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
  refreshMemory(command: RefreshMemoryCommand): Promise<RefreshMemoryResult>;
  getToolsKeyStatus(): Promise<ToolsKeyStatus>;
  setToolsKey(key: string): Promise<ToolsKeyStatus>;
  deleteToolsKey(): Promise<ToolsKeyStatus>;
  listToolkits(command: ListToolkitsCommand): Promise<ListToolkitsResult>;
  listToolConnections(): Promise<ToolConnectionsResult>;
  startToolConnection(command: StartToolConnectionCommand): Promise<StartToolConnectionResult>;
  removeToolConnection(command: RemoveToolConnectionCommand): Promise<void>;
}

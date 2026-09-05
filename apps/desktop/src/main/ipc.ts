import { app, type IpcMainInvokeEvent, ipcMain } from "electron";
import { type AppInfo, IPC } from "../shared/ipc.js";
import { config } from "./config.js";

/** Reject IPC from anything that is not our own renderer. Security checklist item 17. */
function trusted(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? "";
  return url.startsWith("file://") || url.startsWith(process.env.ELECTRON_RENDERER_URL ?? "\0");
}

function handle<T>(channel: string, fn: () => T | Promise<T>) {
  ipcMain.handle(channel, (event) => {
    if (!trusted(event)) throw new Error(`untrusted ipc sender for ${channel}`);
    return fn();
  });
}

export function registerIpc(): void {
  handle<AppInfo>(IPC.getAppInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron ?? "unknown",
  }));

  handle<string>(IPC.getApiBaseUrl, () => config.apiBaseUrl);
}

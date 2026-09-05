import { contextBridge, ipcRenderer } from "electron";
import { type DesktopBridge, IPC } from "../shared/ipc.js";

/**
 * The only surface the renderer gets. Add a method here and to DesktopBridge,
 * never expose ipcRenderer directly. Security checklist item 20.
 */
const bridge: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  getApiBaseUrl: () => ipcRenderer.invoke(IPC.getApiBaseUrl),
};

contextBridge.exposeInMainWorld("opensquad", bridge);

import { contextBridge, ipcRenderer } from "electron";
import { type DesktopBridge, IPC } from "../shared/ipc.js";

/**
 * The only surface the renderer gets. Add a method here and to DesktopBridge,
 * never expose ipcRenderer directly. Security checklist item 20.
 */
const bridge: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  getApiBaseUrl: () => ipcRenderer.invoke(IPC.getApiBaseUrl),
  getRuntimeKeyStatus: () => ipcRenderer.invoke(IPC.getRuntimeKeyStatus),
  setRuntimeKey: (key) => ipcRenderer.invoke(IPC.setRuntimeKey, key),
  deleteRuntimeKey: () => ipcRenderer.invoke(IPC.deleteRuntimeKey),
  sendMessage: (command) => ipcRenderer.invoke(IPC.sendMessage, command),
  cancelRun: (command) => ipcRenderer.invoke(IPC.cancelRun, command),
  reconcileRun: (command) => ipcRenderer.invoke(IPC.reconcileRun, command),
};

contextBridge.exposeInMainWorld("opensquad", bridge);

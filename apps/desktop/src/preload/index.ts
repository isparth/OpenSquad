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
  refreshMemory: (command) => ipcRenderer.invoke(IPC.refreshMemory, command),
  getToolsKeyStatus: () => ipcRenderer.invoke(IPC.getToolsKeyStatus),
  setToolsKey: (key) => ipcRenderer.invoke(IPC.setToolsKey, key),
  deleteToolsKey: () => ipcRenderer.invoke(IPC.deleteToolsKey),
  listToolkits: (command) => ipcRenderer.invoke(IPC.listToolkits, command),
  listToolConnections: () => ipcRenderer.invoke(IPC.listToolConnections),
  startToolConnection: (command) => ipcRenderer.invoke(IPC.startToolConnection, command),
  removeToolConnection: (command) => ipcRenderer.invoke(IPC.removeToolConnection, command),
};

contextBridge.exposeInMainWorld("opensquad", bridge);

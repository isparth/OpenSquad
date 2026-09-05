import { electronApp, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow } from "electron";
import { registerIpc } from "./ipc.js";
import { createMainWindow } from "./window.js";

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.opensquad.app");

  // F12 toggles devtools in dev, and Cmd/Ctrl+R is ignored in production.
  app.on("browser-window-created", (_, window) => optimizer.watchWindowShortcuts(window));

  registerIpc();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

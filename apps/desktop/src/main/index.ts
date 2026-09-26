import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, safeStorage, shell } from "electron";
import { config } from "./config.js";
import { registerIpc } from "./ipc.js";
import { createRuntimeCommands } from "./runtime-commands.js";
import { createRuntimeCredentialVault, toolsVaultFileName } from "./runtime-credentials.js";
import { createToolsCommands } from "./tools-commands.js";
import { createMainWindow } from "./window.js";

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let ipc: ReturnType<typeof registerIpc> | null = null;

  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    electronApp.setAppUserModelId("com.opensquad.app");

    // F12 toggles devtools in dev, and Cmd/Ctrl+R is ignored in production.
    app.on("browser-window-created", (_, window) => optimizer.watchWindowShortcuts(window));

    const vaultOptions = {
      apiBaseUrl: config.apiBaseUrl,
      development: is.dev,
      packaged: app.isPackaged,
      platform: process.platform,
      userDataPath: app.getPath("userData"),
      safeStorage,
    };
    const vault = createRuntimeCredentialVault(vaultOptions);
    const toolsVault = createRuntimeCredentialVault({
      ...vaultOptions,
      fileName: toolsVaultFileName,
    });
    const commands = createRuntimeCommands({ vault, fetch });
    const toolsCommands = createToolsCommands({
      vault: toolsVault,
      fetch,
      openExternal: (url) => shell.openExternal(url),
    });
    ipc = registerIpc({ vault, commands, toolsVault, toolsCommands });

    mainWindow = createMainWindow(ipc);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow(ipc as NonNullable<typeof ipc>);
      }
    });
  });

  app.on("will-quit", () => ipc?.shutdown());

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

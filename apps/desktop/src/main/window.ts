import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import { BrowserWindow, shell } from "electron";
import { config } from "./config.js";
import type { IpcController } from "./ipc.js";
import { isExpectedRendererUrl } from "./renderer-url.js";

// Dev needs inline script + style for Vite HMR and React Fast Refresh. Production is strict.
const CSP = [
  "default-src 'self'",
  is.dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
  is.dev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
  `connect-src 'self' ${config.apiBaseUrl}${is.dev ? " ws://localhost:*" : ""}`,
  `img-src 'self' data: blob: https: ${new URL(config.apiBaseUrl).origin}`,
].join("; ");

export function createMainWindow(ipc: IpcController): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Surface renderer errors in the terminal so a blank window is never silent.
  window.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning") {
      console.error(`[renderer:${event.level}] ${event.message}`);
    }
  });

  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP] },
    });
  });

  // Links open in the system browser, never in the app. Only https leaves the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });

  // The renderer only ever shows our own bundle. Any other navigation is blocked.
  window.webContents.on("will-navigate", (event, url) => {
    if (!isExpectedRendererUrl(url)) event.preventDefault();
  });

  // No camera, mic, geolocation, notifications etc. until a feature needs one.
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );

  window.on("ready-to-show", () => window.show());

  ipc.trustWindow(window);

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}

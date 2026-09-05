/**
 * The contract between renderer and main. Both sides import from here so a
 * renamed channel or changed payload fails typecheck instead of failing at runtime.
 */

export const IPC = {
  getAppInfo: "app:get-info",
  getApiBaseUrl: "config:get-api-base-url",
} as const;

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  electron: string;
}

/** What the renderer sees as `window.opensquad`. */
export interface DesktopBridge {
  getAppInfo(): Promise<AppInfo>;
  getApiBaseUrl(): Promise<string>;
}

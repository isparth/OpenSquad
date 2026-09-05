import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// The preload bridge does not exist under jsdom. Tests override per case as needed.
window.opensquad = {
  getAppInfo: vi.fn().mockResolvedValue({ version: "0.0.0", platform: "darwin", electron: "test" }),
  getApiBaseUrl: vi.fn().mockResolvedValue("http://localhost:3000"),
};

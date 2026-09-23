import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// The preload bridge does not exist under jsdom. Tests override per case as needed.
window.opensquad = {
  getAppInfo: vi.fn().mockResolvedValue({ version: "0.0.0", platform: "darwin", electron: "test" }),
  getApiBaseUrl: vi.fn().mockResolvedValue("http://localhost:3000"),
  getRuntimeKeyStatus: vi
    .fn()
    .mockResolvedValue({ state: "unavailable", reason: "not-configured" }),
  setRuntimeKey: vi.fn().mockResolvedValue({ state: "configured" }),
  deleteRuntimeKey: vi.fn().mockResolvedValue({ state: "unavailable", reason: "not-configured" }),
  sendMessage: vi.fn().mockRejectedValue(new Error("not implemented in test bridge")),
  cancelRun: vi.fn().mockRejectedValue(new Error("not implemented in test bridge")),
  reconcileRun: vi.fn().mockRejectedValue(new Error("not implemented in test bridge")),
  refreshMemory: vi.fn().mockResolvedValue({ update: null }),
};

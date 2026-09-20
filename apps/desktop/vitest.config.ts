import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": resolve(__dirname, "src/renderer/src") } },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}", "src/renderer/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
  },
});

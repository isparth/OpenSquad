import { defineConfig } from "vitest/config";
import { testDatabaseUrl } from "./test/database-url.js";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: testDatabaseUrl,
      STORAGE_PROVIDER: "local",
      LOCAL_STORAGE_DIR: ".data/test-storage",
    },
  },
});

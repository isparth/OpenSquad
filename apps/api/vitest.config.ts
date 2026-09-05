import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://opensquad:opensquad@localhost:5432/opensquad",
      STORAGE_PROVIDER: "local",
      LOCAL_STORAGE_DIR: ".data/test-storage",
    },
  },
});

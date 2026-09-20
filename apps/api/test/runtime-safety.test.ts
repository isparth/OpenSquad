import { randomUUID } from "node:crypto";
import { createDatabase, requestRateLimits } from "@opensquad/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { type App, buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { chargeRequest } from "../src/modules/conversations/limits.js";

const databaseUrl = "postgres://opensquad:opensquad@localhost:5432/opensquad";

describe("runtime safety gates", () => {
  it("refuses production startup when either authentication key is absent", async () => {
    for (const keys of [{}, { CLERK_SECRET_KEY: "dummy" }, { CLERK_PUBLISHABLE_KEY: "dummy" }]) {
      let opened: App | undefined;
      try {
        opened = await buildApp(
          loadEnv({
            NODE_ENV: "production",
            LOG_LEVEL: "fatal",
            DATABASE_URL: databaseUrl,
            ...keys,
          }),
        );
        expect.fail("Production authentication guard did not run");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Production requires both Clerk keys");
      } finally {
        await opened?.close();
      }
    }
  });

  it("enforces request limits atomically across separate database clients", async () => {
    const first = createDatabase(databaseUrl);
    const second = createDatabase(databaseUrl);
    const owner = `rate-test-${randomUUID()}`;
    try {
      await first.db
        .insert(requestRateLimits)
        .values({ ownerId: owner, windowStart: new Date(), count: 119 });
      const results = await Promise.allSettled([
        chargeRequest(first.db, owner),
        chargeRequest(second.db, owner),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    } finally {
      await first.db.delete(requestRateLimits).where(eq(requestRateLimits.ownerId, owner));
      await first.close();
      await second.close();
    }
  });
});

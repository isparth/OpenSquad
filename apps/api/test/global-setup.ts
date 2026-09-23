import { fileURLToPath } from "node:url";
import { createDatabase } from "@opensquad/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { testDatabaseUrl } from "./database-url.js";

export default async function globalSetup() {
  const databaseUrl = new URL(testDatabaseUrl);
  const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));

  if (/^[a-z0-9_]+_test$/.test(databaseName)) {
    databaseUrl.pathname = "/postgres";
    const admin = createDatabase(databaseUrl.toString());
    try {
      const existing = await admin.db.execute(
        sql`select datname from pg_database where datname = ${databaseName}`,
      );
      if (existing.length === 0) {
        await admin.db.execute(sql.raw(`create database "${databaseName}"`));
      }
    } finally {
      await admin.close();
    }
  }

  const migrationsFolder = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));
  const database = createDatabase(testDatabaseUrl);
  try {
    await migrate(database.db, { migrationsFolder });
  } finally {
    await database.close();
  }
}

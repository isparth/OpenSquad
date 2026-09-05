import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Database = ReturnType<typeof createDatabase>["db"];

export function createDatabase(url: string) {
  const sql = postgres(url, { max: 10 });
  const db = drizzle(sql, { schema });
  return { db, close: () => sql.end() };
}

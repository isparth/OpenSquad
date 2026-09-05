import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./client.js";

const url = process.env.DATABASE_URL ?? "postgres://opensquad:opensquad@localhost:5432/opensquad";
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

const { db, close } = createDatabase(url);
await migrate(db, { migrationsFolder });
await close();
console.log("migrations applied");

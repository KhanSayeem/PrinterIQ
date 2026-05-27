import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

let client: postgres.Sql | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL");
  }

  if (!client) {
    client = postgres(databaseUrl, { connect_timeout: 10, prepare: false });
  }

  if (!db) {
    db = drizzle(client);
  }

  return db;
}

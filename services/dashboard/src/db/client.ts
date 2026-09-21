import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

let client: postgres.Sql | null = null;
let db: ReturnType<typeof drizzle> | null = null;

/**
 * The dashboard's own connection string, for Supabase's transaction pooler.
 *
 * Supabase's session pooler (port 5432) holds one server connection per client
 * connection for as long as the client keeps it, and this project's session
 * pool is 15. Every service shared it: this client alone could take 10, the two
 * reply processes 5 each, the pipeline 6 and the stall monitor 2, so a leads
 * page load could leave nothing for anyone else. The stall monitor logged
 * `EMAXCONNSESSION max clients reached` and /leads logged "Failed to load
 * leads".
 *
 * The transaction pooler (port 6543) lends a server connection only for the
 * length of one transaction, so this client stops competing for the session
 * pool at all. It needs prepared statements off, which `prepare: false`
 * already does. DATABASE_URL stays the fallback so a missing variable degrades
 * to the old behaviour rather than to no dashboard.
 */
export function dashboardDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.DASHBOARD_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || undefined;
}

export function getDb() {
  const databaseUrl = dashboardDatabaseUrl();
  if (!databaseUrl) {
    throw new Error("Missing DASHBOARD_DATABASE_URL and DATABASE_URL");
  }

  if (!client) {
    client = postgres(databaseUrl, {
      connect_timeout: 10,
      prepare: false,
      // One operator, a handful of parallel queries per page. Idle connections
      // are closed, so a burst does not keep holding slots afterwards.
      max: 5,
      idle_timeout: 20,
    });
  }

  if (!db) {
    db = drizzle(client);
  }

  return db;
}

import "server-only";

import postgres from "postgres";

import { ASK_SQL_STATEMENT_TIMEOUT_MS } from "./readonly-sql";

/**
 * Runs an already guarded select on the read-only login.
 *
 * Three things hold the line, because any one of them can be wrong:
 * assertReadOnlySql on the text, this transaction opened READ ONLY with a
 * statement timeout, and a Postgres role with no write grants. The role is the
 * one that matters: the other two are there to fail fast and to keep a
 * runaway query from holding the panel open.
 */

let client: postgres.Sql | null = null;
let clientUrl: string | null = null;

function readOnlyClient(url: string): postgres.Sql {
  if (client && clientUrl === url) {
    return client;
  }

  client = postgres(url, {
    connect_timeout: 10,
    idle_timeout: 20,
    max: 2,
    prepare: false,
  });
  clientUrl = url;

  return client;
}

export async function runReadOnlyQuery({
  url,
  sql,
}: {
  readonly url: string;
  readonly sql: string;
}): Promise<unknown[]> {
  const db = readOnlyClient(url);

  return db.begin(async (tx) => {
    await tx.unsafe("set transaction read only");
    await tx.unsafe(`set local statement_timeout = ${ASK_SQL_STATEMENT_TIMEOUT_MS}`);
    const rows = await tx.unsafe(sql);
    return [...rows];
  });
}

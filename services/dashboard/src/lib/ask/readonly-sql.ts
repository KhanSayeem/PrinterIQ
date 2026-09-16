import type { MetricAvailability } from "@/lib/deliverability";

/**
 * The escape hatch behind the ask panel: a select the model writes itself, for
 * the questions no fixed tool covers.
 *
 * Three separate things keep it read-only, because any one of them can be
 * wrong: this guard, a transaction opened READ ONLY with a statement timeout,
 * and a Postgres login that has no write grants at all. The guard is the
 * weakest of the three (a parser it is not), so it is deliberately strict:
 * one statement, starting with select or with, no comments, no write keyword
 * anywhere in the text.
 */

/** Rows past this are cut, so one wide question cannot drag the whole table in. */
export const ASK_SQL_ROW_LIMIT = 200;

/** A runaway query fails instead of holding the panel open. */
export const ASK_SQL_STATEMENT_TIMEOUT_MS = 5_000;

/** Long enough for a real join, short enough to stay readable in the panel. */
export const ASK_SQL_MAX_LENGTH = 2_000;

/**
 * Write and side-effecting keywords. Matched on word boundaries, so a column
 * called updated_at or deleted_at is still allowed.
 */
const FORBIDDEN_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "merge",
  "upsert",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "comment",
  "reindex",
  "vacuum",
  "analyze",
  "cluster",
  "lock",
  "listen",
  "notify",
  "unlisten",
  "prepare",
  "execute",
  "deallocate",
  "discard",
  "copy",
  "call",
  "do",
  "set",
  "reset",
  "refresh",
  "import",
  "export",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "pg_sleep",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_logical_emit_message",
  "lo_import",
  "lo_export",
  "dblink",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_authid",
  "pg_shadow",
  "current_setting",
  "set_config",
] as const;

export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim();

  if (trimmed.length === 0) {
    throw new Error("Query is empty.");
  }

  if (trimmed.length > ASK_SQL_MAX_LENGTH) {
    throw new Error(`Query is too long: ${trimmed.length} characters, cap is ${ASK_SQL_MAX_LENGTH}.`);
  }

  if (trimmed.includes("--") || trimmed.includes("/*")) {
    throw new Error("SQL comments are not allowed, because a comment can hide a second statement.");
  }

  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "");

  if (withoutTrailingSemicolon.includes(";")) {
    throw new Error("Only one statement is allowed per query.");
  }

  if (!/^(select|with)\b/i.test(withoutTrailingSemicolon)) {
    throw new Error("This tool is read-only: a query must start with select or with.");
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword}\\b`, "i");
    if (pattern.test(withoutTrailingSemicolon)) {
      throw new Error(`This tool is read-only: "${keyword}" is not allowed in a query.`);
    }
  }
}

/**
 * Caps the rows a query can return. A limit the model wrote is kept when it is
 * already under the cap, so a deliberate "top 5" stays a top 5.
 */
export function applyRowLimit(sql: string): string {
  const base = sql.trim().replace(/;\s*$/, "");
  const existing = base.match(/\blimit\s+(\d+)\s*$/i);

  if (!existing) {
    return `${base} limit ${ASK_SQL_ROW_LIMIT}`;
  }

  const requested = Number.parseInt(existing[1], 10);
  if (requested <= ASK_SQL_ROW_LIMIT) {
    return base;
  }

  return base.replace(/\blimit\s+\d+\s*$/i, `limit ${ASK_SQL_ROW_LIMIT}`);
}

/**
 * The read-only login, and never the read-write one. A missing login makes the
 * tool unavailable with a reason the panel can show, which is the honest
 * answer: falling back to DATABASE_URL would hand the model write grants.
 */
export function readOnlyDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): MetricAvailability<string> {
  const url = env.ASK_READONLY_DATABASE_URL?.trim();

  if (!url) {
    return {
      available: false,
      reason:
        "ASK_READONLY_DATABASE_URL is not configured, so the SQL tool has no read-only login to use.",
    };
  }

  return { available: true, value: url };
}

#!/usr/bin/env node
/**
 * Apply pending SQL migrations, and fail loudly when one does not apply.
 *
 * Why this exists: the deploy called `npm --prefix database run migrate` with
 * `2>/dev/null || true`, and there was no `migrate` script in package.json. So
 * it failed silently on every deploy since it was written, and every migration
 * reached production only because someone applied it by hand. On 2026-09-16
 * migration 0015 shipped, deployed green, and was simply not there: the column
 * the new code writes did not exist. Nothing said so.
 *
 * No dependencies on purpose. It shells out to `psql`, which the deploy already
 * assumes, so this runs on a fresh box without an install step, and the tests
 * run under `node --test` with nothing to install either.
 *
 * Each migration is applied in a single transaction together with the row that
 * records it, so a migration cannot be applied without being recorded, or
 * recorded without being applied.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, "migrations");

export function migrationChecksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

/** What still has to run, and what has changed underneath us.
 *
 * Sorted by filename rather than by directory order: `readdirSync` is not
 * required to return anything in particular, and these files must run in the
 * order they were numbered.
 */
export function planMigrations({ files, applied }) {
  const sorted = [...files].sort((left, right) => left.filename.localeCompare(right.filename));
  const recordedByName = new Map(applied.map((record) => [record.filename, record]));
  const pending = [];
  const changed = [];

  for (const file of sorted) {
    const recorded = recordedByName.get(file.filename);
    if (!recorded) {
      pending.push(file);
      continue;
    }
    // A missing checksum is an older row, not a mismatch. Only a checksum that
    // is present and different means the file changed after it was applied.
    if (recorded.checksum && recorded.checksum !== migrationChecksum(file.sql)) {
      changed.push(file.filename);
    }
  }

  return { pending, changed };
}

/** Record existing migrations as applied without running them.
 *
 * One-time, for a database whose schema was already applied by hand. It is only
 * correct when someone has checked that the schema really is there, which is
 * why it is a separate command and not something the normal run decides on its
 * own.
 */
export function planBaseline({ files, applied }) {
  const { pending } = planMigrations({ files, applied });
  return { record: pending, run: [] };
}

function psql(databaseUrl, args) {
  return execFileSync("psql", [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function readMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .map((filename) => ({
      filename,
      sql: readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8"),
    }));
}

function readApplied(databaseUrl) {
  psql(databaseUrl, [
    "-q",
    "-c",
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename text PRIMARY KEY,
       checksum text,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  ]);

  const rows = psql(databaseUrl, [
    "-q",
    "-t",
    "-A",
    "-F",
    "\t",
    "-c",
    "SELECT filename, coalesce(checksum, '') FROM schema_migrations",
  ]);

  return rows
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [filename, checksum] = line.split("\t");
      return { filename, checksum: checksum ? checksum : null };
    });
}

/** Names are checked, not trusted, because they are interpolated into SQL. */
const SAFE_FILENAME = /^[0-9A-Za-z._-]+$/;

export function recordSql(file) {
  if (!SAFE_FILENAME.test(file.filename)) {
    throw new Error(`Refusing a migration filename that is not a plain name: ${file.filename}`);
  }

  const checksum = migrationChecksum(file.sql);
  return `INSERT INTO schema_migrations (filename, checksum) VALUES ('${file.filename}', '${checksum}')`;
}

function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set, so no migration can be applied.");
    process.exit(1);
  }

  const baseline = process.argv.includes("--baseline");
  const files = readMigrationFiles();
  const applied = readApplied(databaseUrl);
  const { pending, changed } = planMigrations({ files, applied });

  if (changed.length > 0) {
    console.error(
      `These migrations were applied and have changed since: ${changed.join(", ")}. ` +
        "The database ran the old text. Fix the files or the records by hand.",
    );
    process.exit(1);
  }

  if (baseline) {
    const plan = planBaseline({ files, applied });
    for (const file of plan.record) {
      psql(databaseUrl, ["-q", "-c", recordSql(file)]);
      console.log(`baselined without running: ${file.filename}`);
    }
    console.log(
      `Recorded ${plan.record.length} migration(s) as applied without running them. ` +
        "Only correct on a database whose schema is already in place.",
    );
    return;
  }

  if (pending.length === 0) {
    console.log(`No pending migrations. ${applied.length} already applied.`);
    return;
  }

  for (const file of pending) {
    console.log(`applying ${file.filename}`);
    psql(databaseUrl, [
      "--single-transaction",
      "-q",
      "-f",
      path.join(MIGRATIONS_DIR, file.filename),
      "-c",
      recordSql(file),
    ]);
  }

  console.log(`Applied ${pending.length} migration(s).`);
}

// Only run when invoked as a script, so the tests can import the pure parts.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}

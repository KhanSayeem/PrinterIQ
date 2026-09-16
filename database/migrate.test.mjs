import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { migrationChecksum, planBaseline, planMigrations, recordSql } from "./migrate.mjs";

const files = [
  { filename: "0001_init.sql", sql: "create table a();" },
  { filename: "0002_add_indexes.sql", sql: "create index i on a(id);" },
  { filename: "0003_queue_job_idempotency.sql", sql: "alter table a add b int;" },
];

describe("planMigrations", () => {
  it("applies everything in filename order on an empty database", () => {
    const plan = planMigrations({ files, applied: [] });

    assert.deepEqual(
      plan.pending.map((file) => file.filename),
      ["0001_init.sql", "0002_add_indexes.sql", "0003_queue_job_idempotency.sql"],
    );
    assert.deepEqual(plan.changed, []);
  });

  it("orders by filename even when the directory listing is shuffled", () => {
    const shuffled = [files[2], files[0], files[1]];

    const plan = planMigrations({ files: shuffled, applied: [] });

    assert.deepEqual(
      plan.pending.map((file) => file.filename),
      ["0001_init.sql", "0002_add_indexes.sql", "0003_queue_job_idempotency.sql"],
    );
  });

  /**
   * The whole point. Production ran migrations 0001 to 0015 by hand because the
   * deploy called a script that did not exist and swallowed the error, so this
   * has to apply only what is missing and never re-run what is already there.
   */
  it("applies only what is missing", () => {
    const applied = [
      { filename: "0001_init.sql", checksum: migrationChecksum(files[0].sql) },
      { filename: "0002_add_indexes.sql", checksum: migrationChecksum(files[1].sql) },
    ];

    const plan = planMigrations({ files, applied });

    assert.deepEqual(
      plan.pending.map((file) => file.filename),
      ["0003_queue_job_idempotency.sql"],
    );
  });

  it("reports nothing to do when every migration is recorded", () => {
    const applied = files.map((file) => ({
      filename: file.filename,
      checksum: migrationChecksum(file.sql),
    }));

    const plan = planMigrations({ files, applied });

    assert.deepEqual(plan.pending, []);
    assert.deepEqual(plan.changed, []);
  });

  /**
   * An applied migration whose text changed is a hazard, not a no-op: the
   * database ran the old version and the file now says something else. It is
   * reported so the deploy can stop rather than carry on quietly.
   */
  it("reports an applied migration whose text has changed", () => {
    const applied = [{ filename: "0001_init.sql", checksum: migrationChecksum("something else") }];

    const plan = planMigrations({ files, applied });

    assert.deepEqual(plan.changed, ["0001_init.sql"]);
  });

  it("does not treat a recorded migration with no checksum as changed", () => {
    // Rows baselined by an older runner may carry no checksum.
    const applied = [{ filename: "0001_init.sql", checksum: null }];

    const plan = planMigrations({ files, applied });

    assert.deepEqual(plan.changed, []);
    assert.deepEqual(
      plan.pending.map((file) => file.filename),
      ["0002_add_indexes.sql", "0003_queue_job_idempotency.sql"],
    );
  });
});

describe("planBaseline", () => {
  /**
   * One-time use on a database whose schema was already applied by hand. It
   * records the files as applied without running them, which is only correct
   * when someone has checked that the schema really is there.
   */
  it("records every file as applied without running any of it", () => {
    const plan = planBaseline({ files, applied: [] });

    assert.deepEqual(
      plan.record.map((file) => file.filename),
      ["0001_init.sql", "0002_add_indexes.sql", "0003_queue_job_idempotency.sql"],
    );
    assert.equal(plan.run.length, 0);
  });

  it("leaves already recorded migrations alone", () => {
    const applied = [{ filename: "0001_init.sql", checksum: migrationChecksum(files[0].sql) }];

    const plan = planBaseline({ files, applied });

    assert.deepEqual(
      plan.record.map((file) => file.filename),
      ["0002_add_indexes.sql", "0003_queue_job_idempotency.sql"],
    );
  });
});

describe("migrationChecksum", () => {
  it("is stable for the same text and different for changed text", () => {
    assert.equal(migrationChecksum("create table a();"), migrationChecksum("create table a();"));
    assert.notEqual(migrationChecksum("create table a();"), migrationChecksum("create table b();"));
  });
});

describe("recordSql", () => {
  it("writes the filename and checksum for the row that records a migration", () => {
    const sql = recordSql({ filename: "0016_thing.sql", sql: "select 1;" });

    assert.match(sql, /INSERT INTO schema_migrations/);
    assert.match(sql, /0016_thing\.sql/);
    assert.match(sql, new RegExp(migrationChecksum("select 1;")));
  });

  /**
   * The filename is interpolated into SQL, so it is checked rather than
   * trusted. These files come from the repository today, but a quoted name
   * would break the statement and a crafted one could do worse.
   */
  it("refuses a filename that is not a plain migration name", () => {
    assert.throws(() => recordSql({ filename: "0016'; drop table conversations; --.sql", sql: "" }), /filename/);
    assert.throws(() => recordSql({ filename: "../outside.sql", sql: "" }), /filename/);
  });
});

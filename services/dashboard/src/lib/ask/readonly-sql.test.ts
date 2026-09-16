import { describe, expect, it } from "vitest";

import {
  ASK_SQL_MAX_LENGTH,
  ASK_SQL_ROW_LIMIT,
  ASK_SQL_STATEMENT_TIMEOUT_MS,
  applyRowLimit,
  assertReadOnlySql,
  readOnlyDatabaseUrl,
} from "./readonly-sql";

describe("assertReadOnlySql", () => {
  it("allows a plain select", () => {
    expect(() => assertReadOnlySql("select count(*) from leads")).not.toThrow();
  });

  it("allows a common table expression", () => {
    expect(() =>
      assertReadOnlySql("with recent as (select id from leads limit 5) select * from recent"),
    ).not.toThrow();
  });

  it("allows column names that merely contain a write keyword", () => {
    expect(() =>
      assertReadOnlySql("select updated_at, created_at, deleted_at from leads"),
    ).not.toThrow();
  });

  it("rejects anything that is not a select", () => {
    expect(() => assertReadOnlySql("delete from leads")).toThrow(/must start with select or with/i);
    expect(() => assertReadOnlySql("table leads")).toThrow(/must start with select or with/i);
    expect(() => assertReadOnlySql("show search_path")).toThrow(/must start with select or with/i);
  });

  it("rejects a write hidden after a select", () => {
    expect(() => assertReadOnlySql("select 1; drop table leads")).toThrow(/one statement/i);
  });

  it("allows a single trailing semicolon", () => {
    expect(() => assertReadOnlySql("select 1;")).not.toThrow();
  });

  it("rejects each write keyword on its own", () => {
    const statements = [
      "select * from leads where id in (insert into leads values (1))",
      "select 1 from update_log update leads set x = 1",
      "select grant from t",
      "select 1 from t truncate",
      "select 1 from t alter",
      "select 1 from t copy",
      "select pg_sleep(10)",
      "select lo_import('/etc/passwd')",
      "select pg_read_file('/etc/passwd')",
    ];
    for (const statement of statements) {
      expect(() => assertReadOnlySql(statement), statement).toThrow();
    }
  });

  it("rejects comments, which can hide a second statement", () => {
    expect(() => assertReadOnlySql("select 1 -- drop table leads")).toThrow(/comment/i);
    expect(() => assertReadOnlySql("select 1 /* drop */ from t")).toThrow(/comment/i);
  });

  it("rejects an empty query", () => {
    expect(() => assertReadOnlySql("   ")).toThrow(/empty/i);
  });

  it("rejects a query longer than the cap", () => {
    const long = `select ${"a".repeat(ASK_SQL_MAX_LENGTH)} from leads`;
    expect(() => assertReadOnlySql(long)).toThrow(/too long/i);
  });
});

describe("applyRowLimit", () => {
  it("adds the row cap when the query has no limit", () => {
    expect(applyRowLimit("select * from leads")).toBe(
      `select * from leads limit ${ASK_SQL_ROW_LIMIT}`,
    );
  });

  it("strips a trailing semicolon before adding the cap", () => {
    expect(applyRowLimit("select * from leads;")).toBe(
      `select * from leads limit ${ASK_SQL_ROW_LIMIT}`,
    );
  });

  it("lowers a limit that is above the cap", () => {
    expect(applyRowLimit("select * from leads limit 5000")).toBe(
      `select * from leads limit ${ASK_SQL_ROW_LIMIT}`,
    );
  });

  it("keeps a limit that is already under the cap", () => {
    expect(applyRowLimit("select * from leads limit 10")).toBe("select * from leads limit 10");
  });
});

describe("readOnlyDatabaseUrl", () => {
  it("returns the read-only login when it is configured", () => {
    expect(readOnlyDatabaseUrl({ ASK_READONLY_DATABASE_URL: "postgres://ro@host/db" })).toEqual({
      available: true,
      value: "postgres://ro@host/db",
    });
  });

  it("is unavailable, with a reason, when the read-only login is missing", () => {
    const result = readOnlyDatabaseUrl({});
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toMatch(/ASK_READONLY_DATABASE_URL/);
  });

  it("never falls back to the read-write login", () => {
    const result = readOnlyDatabaseUrl({ DATABASE_URL: "postgres://rw@host/db" });
    expect(result.available).toBe(false);
  });
});

describe("timeout", () => {
  it("is short enough that a runaway query cannot hold the panel open", () => {
    expect(ASK_SQL_STATEMENT_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

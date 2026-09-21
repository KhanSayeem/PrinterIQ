import { describe, expect, it } from "vitest";

import { describeDbError } from "./db-error";

function drizzleError(causeMessage: string, code?: string) {
  const cause = Object.assign(new Error(causeMessage), code ? { code } : {});
  return new Error('Failed query: select count(*) from "leads"\nparams: tenant-1,false', { cause });
}

describe("describeDbError", () => {
  it("surfaces the reason behind a failed query, not just the query", () => {
    const summary = describeDbError(
      drizzleError("(EMAXCONNSESSION) max clients reached in session mode", "XX000"),
    );

    expect(summary.cause).toContain("max clients reached");
    expect(summary.code).toBe("XX000");
    expect(summary.query).toBe('Failed query: select count(*) from "leads"');
  });

  it("drops the params line", () => {
    expect(describeDbError(drizzleError("boom")).query).not.toContain("params");
  });

  it("masks an email the database quoted back", () => {
    const summary = describeDbError(drizzleError("duplicate key value (email)=(jo@example.com)"));

    expect(summary.cause).not.toContain("jo@example.com");
    expect(summary.cause).toContain("[email]");
  });

  it("copes with something that is not an Error", () => {
    expect(describeDbError("nope")).toEqual({ query: "unknown", cause: "unknown error", code: null });
  });
});

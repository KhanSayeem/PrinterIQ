import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { dashboardDatabaseUrl } = await import("./client");

describe("dashboardDatabaseUrl", () => {
  it("prefers the dashboard's own transaction pooler URL", () => {
    expect(
      dashboardDatabaseUrl({
        DASHBOARD_DATABASE_URL: "postgres://u@host:6543/db",
        DATABASE_URL: "postgres://u@host:5432/db",
      }),
    ).toBe("postgres://u@host:6543/db");
  });

  it("falls back to the shared URL, so a missing variable degrades rather than breaks", () => {
    expect(dashboardDatabaseUrl({ DATABASE_URL: "postgres://u@host:5432/db" })).toBe(
      "postgres://u@host:5432/db",
    );
  });

  it("treats a blank dashboard URL as missing", () => {
    expect(
      dashboardDatabaseUrl({ DASHBOARD_DATABASE_URL: "  ", DATABASE_URL: "postgres://u@host:5432/db" }),
    ).toBe("postgres://u@host:5432/db");
  });

  it("is undefined when neither is set", () => {
    expect(dashboardDatabaseUrl({})).toBeUndefined();
  });
});

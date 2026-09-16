import { describe, expect, it, vi } from "vitest";

import { askToolNames, buildAskTools, runAskTool } from "./tools";

const tools = buildAskTools();

describe("buildAskTools", () => {
  it("gives every tool a unique name", () => {
    const names = askToolNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("describes every tool well enough for the model to choose it", () => {
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
    }
  });

  it("closes every schema, so an invented argument is rejected rather than ignored", () => {
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  it("holds no tool named for an action, because the panel can only read", () => {
    const writeVerb = /^(pause|resume|update|delete|create|insert|drop|write|refund|restart|move|set)_/;
    for (const tool of tools) {
      expect(tool.name, tool.name).not.toMatch(writeVerb);
    }
  });

  /**
   * An exact list, not a subset. A new tool has to be added here on purpose,
   * so a write path cannot arrive in the toolbox unnoticed.
   */
  it("is exactly the read toolbox", () => {
    expect([...askToolNames()].sort()).toEqual(
      [
        "instantly_campaigns",
        "lead_counts",
        "lead_detail",
        "leads_search",
        "pipeline_funnel",
        "replies_recent",
        "reply_counts",
        "reply_ingest_health",
        "revenue",
        "sends_to_date",
        "sends_today",
        "sending_accounts",
        "sql_query",
        "system_health",
      ].sort(),
    );
  });

  it("requires the arguments it cannot work without", () => {
    const leadDetail = tools.find((tool) => tool.name === "lead_detail");
    expect(leadDetail?.inputSchema.required).toEqual(["leadId"]);

    const sql = tools.find((tool) => tool.name === "sql_query");
    expect(sql?.inputSchema.required).toEqual(["query"]);
  });
});

describe("runAskTool", () => {
  const context = { tenantId: "tenant-123" };

  it("reports an unknown tool as not available, and lists the real ones", async () => {
    const result = await runAskTool("drop_everything", {}, context);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^not available:/);
    expect(result.text).toContain("sends_today");
  });

  it("turns a thrown read into not available with its reason, never a zero", async () => {
    const result = await runAskTool("lead_detail", {}, context);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^not available: "leadId" is required/);
  });

  it("rejects a write dressed up as a query", async () => {
    const result = await runAskTool("sql_query", { query: "delete from leads" }, context);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not available: .*read-only/i);
  });

  it("says so when the read-only login is missing, rather than using the read-write one", async () => {
    vi.stubEnv("ASK_READONLY_DATABASE_URL", "");
    try {
      const result = await runAskTool("sql_query", { query: "select 1" }, context);
      expect(result.isError).toBe(false);
      expect(result.text).toContain("ASK_READONLY_DATABASE_URL");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects an unknown health check without running anything", async () => {
    const result = await runAskTool("system_health", { check: "rm -rf /" }, context);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Unknown health check/);
  });

  it("serialises a Date rather than crashing on it", async () => {
    const serialised = JSON.stringify({ when: new Date("2026-09-16T00:00:00.000Z") });
    expect(serialised).toContain("2026-09-16T00:00:00.000Z");
  });
});

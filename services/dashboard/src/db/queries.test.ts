import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import {
  buildAiCostByModelQuery,
  buildLatestConversationsForLeadsQuery,
  buildLeadDetailQuery,
  buildLeadListQuery,
  buildPipelineStageSampleLeadsQuery,
  buildPipelineStageScoreSummaryQuery,
  buildPipelineStatusCountsQuery,
  buildPipelineWeaknessRowsQuery,
  buildRelatedLeadDataQueries,
  buildRevenueImportedCountQuery,
  buildRevenuePaymentsSummaryQuery,
  normalizePipelineAnalytics,
  normalizePipelineStage,
} from "./queries";

const sql = postgres("postgres://user:pass@localhost:5432/printeriq", { prepare: false });
const db = drizzle(sql);
const tenantId = "10000000-0000-0000-0000-000000000001";
const leadId = "00000000-0000-0000-0001-000000000001";
const periodStart = new Date("2026-05-27T00:00:00.000Z");

describe("dashboard lead queries", () => {
  it("scopes lead list queries by tenant_id and filters", () => {
    const query = buildLeadListQuery(db, {
      tenantId,
      status: "qualified",
      state: "NSW",
      tradeType: "tradies",
      scoreMin: 50,
      scoreMax: 90,
      page: 2,
      pageSize: 25,
    }).toSQL();

    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"enrichments"."tenant_id" =');
    expect(query.sql).toContain('"weaknesses"');
    expect(query.sql).toContain('"leads"."status" =');
    expect(query.sql).toContain('"leads"."state" =');
    expect(query.sql).toContain('"leads"."vertical" =');
    expect(query.params).toContain(tenantId);
  });

  it("scopes latest conversation lookups by tenant_id and visible lead ids", () => {
    const query = buildLatestConversationsForLeadsQuery(db, {
      tenantId,
      leadIds: [leadId, "00000000-0000-0000-0001-000000000002"],
    }).toSQL();

    expect(query.sql).toContain('"conversations"."tenant_id" =');
    expect(query.sql).toContain('"conversations"."lead_id" in');
    expect(query.sql).toContain("distinct on");
    expect(query.sql).toContain('order by "conversations"."lead_id", "conversations"."created_at" desc');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain(leadId);
  });

  it("scopes lead detail queries by tenant_id and lead id", () => {
    const query = buildLeadDetailQuery(db, { tenantId, leadId }).toSQL();

    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"leads"."id" =');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain(leadId);
  });

  it("scopes related tab data by the same tenant_id and lead id", () => {
    const queries = buildRelatedLeadDataQueries(db, { tenantId, leadId }).map((query) => query.toSQL());

    expect(queries).toHaveLength(5);
    for (const query of queries) {
      expect(query.sql).toContain('"tenant_id" = $1');
      expect(query.sql).toContain('"lead_id" = $2');
      expect(query.params).toContain(tenantId);
      expect(query.params).toContain(leadId);
    }
  });
});

describe("dashboard D2 analytics queries", () => {
  it("scopes pipeline status counts by tenant_id and active leads", () => {
    const query = buildPipelineStatusCountsQuery(db, { tenantId }).toSQL();

    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"leads"."is_deleted" =');
    expect(query.sql).toContain('group by "leads"."status"');
    expect(query.params).toContain(tenantId);
  });

  it("scopes revenue payment totals by tenant_id, paid status, and period", () => {
    const query = buildRevenuePaymentsSummaryQuery(db, { tenantId, periodStart }).toSQL();

    expect(query.sql).toContain('"payments"."tenant_id" =');
    expect(query.sql).toContain('"payments"."status" =');
    expect(query.sql).toContain('"payments"."paid_at" >=');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain("paid");
  });

  it("scopes imported lead denominator by tenant_id and import period", () => {
    const query = buildRevenueImportedCountQuery(db, { tenantId, periodStart }).toSQL();

    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"leads"."is_deleted" =');
    expect(query.sql).toContain('"leads"."imported_at" >=');
    expect(query.params).toContain(tenantId);
  });

  it("scopes AI cost rows by tenant_id and qualification period", () => {
    const query = buildAiCostByModelQuery(db, { tenantId, periodStart }).toSQL();

    expect(query.sql).toContain('"qualifications"."tenant_id" =');
    expect(query.sql).toContain('"qualifications"."qualified_at" >=');
    expect(query.sql).toContain('group by "qualifications"."model_haiku", "qualifications"."model_sonnet"');
    expect(query.params).toContain(tenantId);
  });

  it("zero-fills pipeline statuses and avoids divide-by-zero conversions", () => {
    const analytics = normalizePipelineAnalytics([
      { status: "imported", count: 3 },
      { status: "qualified", count: "1" },
      { status: "archived", count: 2 },
    ]);

    expect(analytics.stages.map((stage) => stage.status)).toEqual([
      "imported",
      "enriched",
      "qualified",
      "contacted",
      "replied",
      "paid",
      "archived",
    ]);
    expect(analytics.stages.map((stage) => stage.count)).toEqual([3, 0, 1, 0, 0, 0, 2]);
    expect(analytics.conversions[0]).toMatchObject({
      from: "imported",
      to: "enriched",
      rate: 0,
    });
    expect(analytics.conversions[1]).toMatchObject({
      from: "enriched",
      to: "qualified",
      rate: null,
      label: "--",
    });
  });

  it("normalizes selected pipeline stages to a valid default", () => {
    expect(normalizePipelineStage("qualified")).toBe("qualified");
    expect(normalizePipelineStage("not-real")).toBe("imported");
    expect(normalizePipelineStage(undefined)).toBe("imported");
  });

  it("adds non-negative drop-off counts to conversion rows", () => {
    const analytics = normalizePipelineAnalytics([
      { status: "imported", count: 2 },
      { status: "enriched", count: 5 },
      { status: "qualified", count: 3 },
    ]);

    expect(analytics.conversions[0]).toMatchObject({
      from: "imported",
      to: "enriched",
      droppedCount: 0,
    });
    expect(analytics.conversions[1]).toMatchObject({
      from: "enriched",
      to: "qualified",
      droppedCount: 2,
    });
  });

  it("scopes pipeline stage score summaries by tenant_id and stage", () => {
    const query = buildPipelineStageScoreSummaryQuery(db, {
      tenantId,
      selectedStage: "qualified",
    }).toSQL();

    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"qualifications"."tenant_id" =');
    expect(query.sql).toContain('"leads"."status" =');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain("qualified");
  });

  it("scopes pipeline weakness rows by tenant_id and stage", () => {
    const query = buildPipelineWeaknessRowsQuery(db, {
      tenantId,
      selectedStage: "qualified",
    }).toSQL();

    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"enrichments"."tenant_id" =');
    expect(query.sql).toContain('"leads"."status" =');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain("qualified");
  });

  it("scopes pipeline sample leads by tenant_id and stage", () => {
    const query = buildPipelineStageSampleLeadsQuery(db, {
      tenantId,
      selectedStage: "qualified",
      limit: 5,
    }).toSQL();

    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"leads"."status" =');
    expect(query.sql).toContain('"qualifications"."tenant_id" =');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain("qualified");
  });
});

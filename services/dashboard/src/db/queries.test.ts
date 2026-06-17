import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import {
  buildAiCostByModelQuery,
  buildLatestConversationsForLeadsQuery,
  buildLeadFilterCountsQuery,
  buildLeadDetailQuery,
  buildLeadListCountQuery,
  buildLeadListQuery,
  buildInsertOperatorConversationQuery,
  buildLeadStatusTransitionCheckQuery,
  buildLatestInstantlyLeadIdQuery,
  buildLatestInstantlyReplyMetadataQuery,
  buildPipelineStageSampleLeadsQuery,
  buildPipelineStageScoreSummaryQuery,
  buildPipelineStatusCountsQuery,
  buildPipelineWeaknessRowsQuery,
  buildRelatedLeadDataQueries,
  buildRevenueImportedCountQuery,
  buildRevenuePaymentsSummaryQuery,
  buildUpdateLeadStatusQuery,
  buildDeleteOperatorNoteQuery,
  normalizeWebsitePreview,
  normalizeLeadFilterCounts,
  normalizeLeadListPageMeta,
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
      search: "coolcats",
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
    expect(query.sql).toContain("ilike");
    expect(query.sql).toContain('"leads"."business_name"');
    expect(query.sql).toContain('"leads"."email"');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain("%coolcats%");
  });

  it("orders lead list queries by the most recently updated lead first", () => {
    const query = buildLeadListQuery(db, {
      tenantId,
      page: 2,
      pageSize: 25,
    }).toSQL();

    expect(query.sql).toContain('order by "leads"."updated_at" desc');
    expect(query.sql).toContain("limit");
    expect(query.sql).toContain("offset");
  });

  it("counts lead filter pills from tenant-scoped active leads only", () => {
    const query = buildLeadFilterCountsQuery(db, { tenantId }).toSQL();

    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"leads"."is_deleted" =');
    expect(query.sql).toContain('group by "leads"."status"');
    expect(query.sql).not.toContain('join "conversations"');
    expect(query.sql).not.toContain("limit");
    expect(query.params).toContain(tenantId);
  });

  it("normalizes lead filter counts with an all total and zero-filled visible statuses", () => {
    expect(
      normalizeLeadFilterCounts([
        { status: "imported", count: "3" },
        { status: "qualified", count: 2 },
        { status: "paid", count: "1" },
      ]),
    ).toEqual({
      all: 6,
      qualified: 2,
      replied: 0,
      paid: 1,
      archived: 0,
    });
  });

  it("counts filtered lead-list totals without applying page limits", () => {
    const query = buildLeadListCountQuery(db, {
      tenantId,
      status: "qualified",
      state: "NSW",
      tradeType: "tradies",
      search: "coolcats",
      scoreMin: 50,
      scoreMax: 90,
      page: 3,
      pageSize: 25,
    }).toSQL();

    expect(query.sql).toContain('count(*)');
    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"leads"."is_deleted" =');
    expect(query.sql).toContain('"leads"."status" =');
    expect(query.sql).toContain('"leads"."state" =');
    expect(query.sql).toContain('"leads"."vertical" =');
    expect(query.sql).toContain("ilike");
    expect(query.sql).toContain('"qualifications"."score" >=');
    expect(query.sql).toContain('"qualifications"."score" <=');
    expect(query.sql).not.toContain("limit");
    expect(query.sql).not.toContain("offset");
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain("%coolcats%");
  });

  it("clamps lead-list pagination metadata to the available page range", () => {
    expect(normalizeLeadListPageMeta({ total: 73, page: 999, pageSize: 25 })).toEqual({
      total: 73,
      page: 3,
      pageSize: 25,
      totalPages: 3,
    });

    expect(normalizeLeadListPageMeta({ total: 0, page: 4, pageSize: 25 })).toEqual({
      total: 0,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });
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
    expect(query.sql).toContain('left join "website_previews"');
    expect(query.sql).toContain('"website_previews"."tenant_id" =');
    expect(query.sql).toContain('"website_previews"."lead_id" =');
    expect(query.sql).toContain('"website_previews"."template_used"');
    expect(query.sql).toContain('"website_previews"."preview_url"');
    expect(query.sql).toContain('"website_previews"."personalisation_data"');
    expect(query.sql).toContain('"website_previews"."prompt_version"');
    expect(query.sql).toContain('"website_previews"."cost_usd"');
    expect(query.sql).toContain('"website_previews"."generated_at"');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain(leadId);
  });

  it("normalizes missing lead preview rows to null", () => {
    expect(normalizeWebsitePreview(null)).toBeNull();
    expect(
      normalizeWebsitePreview({
        templateUsed: null,
        previewUrl: null,
        personalisationData: null,
        promptVersion: null,
        costUsd: null,
        generatedAt: null,
      }),
    ).toBeNull();
  });

  it("normalizes populated lead preview rows to the dashboard contract", () => {
    const generatedAt = new Date("2026-06-10T08:30:00.000Z");

    expect(
      normalizeWebsitePreview({
        templateUsed: "plumbing",
        previewUrl: "https://preview.presciaiq.com/p/demo-preview/",
        personalisationData: { business_name: "Aqua Options" },
        promptVersion: "preview-personalise-v1",
        costUsd: "0.000100",
        generatedAt,
      }),
    ).toEqual({
      templateUsed: "plumbing",
      previewUrl: "https://preview.presciaiq.com/p/demo-preview/",
      personalisationData: { business_name: "Aqua Options" },
      promptVersion: "preview-personalise-v1",
      costUsd: "0.000100",
      generatedAt,
    });
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

  it("inserts operator conversation rows with tenant scope and override metadata", () => {
    const query = buildInsertOperatorConversationQuery(db, {
      tenantId,
      leadId,
      direction: "note",
      channel: "note",
      body: "Called and left a voicemail",
    }).getQuery();

    const normalizedSql = query.sql.toLowerCase();
    expect(normalizedSql).toContain('insert into "conversations"');
    expect(normalizedSql).toContain('select');
    expect(normalizedSql).toContain('"leads"."tenant_id"');
    expect(normalizedSql).toContain('from "leads"');
    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"leads"."id" =');
    expect(query.sql).toContain('"tenant_id"');
    expect(query.sql).toContain('"lead_id"');
    expect(query.sql).toContain('"direction"');
    expect(query.sql).toContain('"channel"');
    expect(query.sql).toContain('"body"');
    expect(query.sql).toContain('"operator_override"');
    expect(normalizedSql).toContain("returning");
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain(leadId);
    expect(query.params).toContain("note");
    expect(query.params).toContain("Called and left a voicemail");
    expect(query.params).toContain(true);
  });

  it("updates lead status only for allowed current states on the matching tenant-scoped lead", () => {
    const query = buildUpdateLeadStatusQuery(db, {
      tenantId,
      leadId,
      status: "replied",
    }).toSQL();

    expect(query.sql).toContain('update "leads"');
    expect(query.sql).toContain('"status" =');
    expect(query.sql).toContain('"updated_at" =');
    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"leads"."id" =');
    expect(query.sql).toContain('"leads"."status" in');
    expect(query.sql).toContain("returning");
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain(leadId);
    expect(query.params).toContain("replied");
    expect(query.params).toContain("contacted");
  });

  it("checks lead status transition eligibility before external side effects", () => {
    const query = buildLeadStatusTransitionCheckQuery(db, {
      tenantId,
      leadId,
      status: "archived",
    }).toSQL();

    expect(query.sql).toContain('from "leads"');
    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"leads"."id" =');
    expect(query.sql).toContain('"leads"."status" in');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain(leadId);
    expect(query.params).toContain("contacted");
    expect(query.params).toContain("replied");
  });

  it("fetches the latest Instantly lead id without exposing other tenants", () => {
    const query = buildLatestInstantlyLeadIdQuery(db, { tenantId, leadId }).toSQL();

    expect(query.sql).toContain('from "outreach_sends"');
    expect(query.sql).toContain('"outreach_sends"."tenant_id" =');
    expect(query.sql).toContain('"outreach_sends"."lead_id" =');
    expect(query.sql).toContain('"outreach_sends"."instantly_lead_id" is not null');
    expect(query.sql).toContain('"instantly_campaign_id"');
    expect(query.sql).toContain('order by "outreach_sends"."sent_at" desc');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain(leadId);
  });

  it("fetches the latest inbound Instantly reply metadata for override replies", () => {
    const query = buildLatestInstantlyReplyMetadataQuery(db, { tenantId, leadId }).toSQL();

    expect(query.sql).toContain('from "conversations"');
    expect(query.sql).toContain('"conversations"."tenant_id" =');
    expect(query.sql).toContain('"conversations"."lead_id" =');
    expect(query.sql).toContain('"conversations"."direction" =');
    expect(query.sql).toContain('"conversations"."instantly_email_id" is not null');
    expect(query.sql).toContain('"conversations"."instantly_account_id" is not null');
    expect(query.sql).toContain('order by "conversations"."created_at" desc');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain(leadId);
    expect(query.params).toContain("inbound");
  });

  it("deletes only tenant-scoped operator note conversations", () => {
    const query = buildDeleteOperatorNoteQuery(db, {
      tenantId,
      leadId,
      conversationId: "33333333-3333-4333-8333-333333333333",
    }).toSQL();

    expect(query.sql).toContain('delete from "conversations"');
    expect(query.sql).toContain('"conversations"."tenant_id" =');
    expect(query.sql).toContain('"conversations"."lead_id" =');
    expect(query.sql).toContain('"conversations"."id" =');
    expect(query.sql).toContain('"conversations"."direction" =');
    expect(query.sql).toContain('"conversations"."operator_override" =');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain(leadId);
    expect(query.params).toContain("33333333-3333-4333-8333-333333333333");
    expect(query.params).toContain("note");
    expect(query.params).toContain(true);
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

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
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
  buildPipelineStatusCountsQuery,
  buildPipelineImportedCountQuery,
  buildPipelineEnrichedCountQuery,
  buildPipelineScoredCountQuery,
  buildPipelineQualifiedCountQuery,
  buildPipelineContactedCountQuery,
  buildPipelineContactedQualifiedCountQuery,
  buildPipelineThresholdCohortQueries,
  buildPipelineRepliedCountQuery,
  buildPipelinePaidCountQuery,
  buildRelatedLeadDataQueries,
  buildRevenueImportedCountQuery,
  buildTodayReplyCountQuery,
  buildTodayUnsubscribeCountQuery,
  normalizeTodaySoFar,
  BOUNCE_RATE_WARNING_PERCENT,
  UNSUBSCRIBE_RATE_WARNING_PERCENT,
  buildRevenuePaymentsSummaryQuery,
  buildUpdateLeadStatusQuery,
  buildDeleteOperatorNoteQuery,
  buildCreateDiscoveryRunQuery,
  buildFailStaleActiveDiscoveryRunsQuery,
  buildInsertManualProspectReviewQuery,
  buildLatestDiscoveryRunQuery,
  buildListProspectEvidenceForRunQuery,
  buildMarkDiscoveryRunFailedQuery,
  buildProspectReviewExportRowsQuery,
  buildProspectReviewMetricsQuery,
  normalizeWebsitePreview,
  normalizeLeadFilterCounts,
  normalizeLeadListPageMeta,
  normalizePipelineAnalytics,
} from "./queries";
import * as queryModule from "./queries";
import type { MetricAvailability } from "@/lib/deliverability";

const sql = postgres("postgres://user:pass@localhost:5432/printeriq", { prepare: false });
const db = drizzle(sql);
const tenantId = "10000000-0000-0000-0000-000000000001";
const leadId = "00000000-0000-0000-0001-000000000001";
const periodStart = new Date("2026-05-27T00:00:00.000Z");
const discoveryQuerySpec = {
  key: "greater-brisbane-plumbers-v1",
  categories: ["Plumber", "Drainage service", "Gas fitter"],
  localities: ["Brisbane", "Logan", "Ipswich", "Moreton Bay", "Redlands"],
  region: "AU",
  totalLimit: 500,
};
const dialect = new PgDialect();

function toRawSQL(query: { getSQL(): Parameters<typeof dialect.sqlToQuery>[0] }) {
  return dialect.sqlToQuery(query.getSQL());
}

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

  it("tallies unsubscribed and preview pills inside the single filter-count aggregate", () => {
    const query = buildLeadFilterCountsQuery(db, { tenantId }).toSQL();

    // One pass over the tenant's leads: no second aggregate is issued per page load.
    expect(query.sql.match(/select/g)).toHaveLength(2);
    expect(query.sql).toContain('from "leads"');
    expect(query.sql).toContain('left join "website_previews"');
    expect(query.sql).toContain('"website_previews"."tenant_id" =');
    expect(query.sql).toContain('exists');
    expect(query.sql).toContain('"outreach_sends"."unsubscribed" = true');
    expect(query.sql).toContain('"website_previews"."first_viewed_at" is not null');
    expect(query.sql).toContain('"website_previews"."first_viewed_at" is null');
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
      contacted: 0,
      replied: 0,
      paid: 1,
      archived: 0,
      unsubscribed: 0,
      previewSeen: 0,
      previewUnseen: 0,
    });
  });

  it("counts the contacted status group for the contacted filter pill", () => {
    expect(
      normalizeLeadFilterCounts([
        { status: "contacted", count: "4" },
        { status: "replied", count: 2 },
      ]),
    ).toMatchObject({ all: 6, contacted: 4, replied: 2 });
  });

  it("sums the unsubscribed and preview tallies across every status group", () => {
    expect(
      normalizeLeadFilterCounts([
        { status: "contacted", count: "4", unsubscribedCount: "1", previewSeenCount: "2", previewUnseenCount: "2" },
        { status: "archived", count: "2", unsubscribedCount: 2, previewSeenCount: 0, previewUnseenCount: "1" },
      ]),
    ).toEqual({
      all: 6,
      qualified: 0,
      contacted: 4,
      replied: 0,
      paid: 0,
      archived: 2,
      unsubscribed: 3,
      previewSeen: 2,
      previewUnseen: 3,
    });
  });

  it("filters the lead list to leads with an unsubscribed outreach send", () => {
    const query = buildLeadListQuery(db, { tenantId, unsubscribed: true, page: 1, pageSize: 25 }).toSQL();

    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('exists');
    expect(query.sql).toContain('from "outreach_sends"');
    expect(query.sql).toContain('"outreach_sends"."unsubscribed" = true');
    expect(query.sql).toContain('"outreach_sends"."tenant_id" =');
    expect(query.params.filter((param) => param === tenantId).length).toBeGreaterThan(1);
  });

  it("filters the lead list to leads whose preview has been viewed", () => {
    const query = buildLeadListQuery(db, { tenantId, previewView: "seen", page: 1, pageSize: 25 }).toSQL();

    expect(query.sql).toContain('left join "website_previews"');
    expect(query.sql).toContain('"website_previews"."tenant_id" =');
    expect(query.sql).toContain('"website_previews"."first_viewed_at" is not null');
  });

  it("filters the lead list to leads whose preview exists but has never been viewed", () => {
    const query = buildLeadListQuery(db, { tenantId, previewView: "unseen", page: 1, pageSize: 25 }).toSQL();

    expect(query.sql).toContain('left join "website_previews"');
    expect(query.sql).toContain('"website_previews"."id" is not null');
    expect(query.sql).toContain('"website_previews"."first_viewed_at" is null');
  });

  it("applies the unsubscribed and preview filters to the lead-list total as well", () => {
    const query = buildLeadListCountQuery(db, {
      tenantId,
      unsubscribed: true,
      previewView: "unseen",
      page: 1,
      pageSize: 25,
    }).toSQL();

    expect(query.sql).toContain("count(*)");
    expect(query.sql).toContain('"outreach_sends"."unsubscribed" = true');
    expect(query.sql).toContain('"website_previews"."first_viewed_at" is null');
    expect(query.sql).not.toContain("limit");
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
    const insertTargetList = query.sql.slice(0, query.sql.indexOf("SELECT"));
    expect(normalizedSql).toContain('insert into "conversations"');
    expect(normalizedSql).toContain('select');
    expect(normalizedSql).toContain('"leads"."tenant_id"');
    expect(normalizedSql).toContain('from "leads"');
    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"leads"."id" =');
    expect(normalizedSql).toContain("tenant_id");
    expect(normalizedSql).toContain("lead_id");
    expect(normalizedSql).toContain("direction");
    expect(normalizedSql).toContain("channel");
    expect(normalizedSql).toContain("body");
    expect(normalizedSql).toContain("operator_override");
    expect(insertTargetList).not.toContain('"conversations"."tenant_id"');
    expect(insertTargetList).not.toContain('"conversations"."lead_id"');
    expect(insertTargetList).not.toContain('"conversations"."operator_override"');
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

describe("dashboard discovery run queries", () => {
  it("creates a tenant-scoped shadow Outscraper run", () => {
    const query = buildCreateDiscoveryRunQuery(db, {
      tenantId,
      querySpec: discoveryQuerySpec,
    }).toSQL();

    expect(query.sql).toContain('insert into "discovery_runs"');
    expect(query.sql).toContain('"tenant_id"');
    expect(query.sql).toContain('"query_spec"');
    expect(query.sql).toContain('"shadow_mode"');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain("outscraper");
    expect(query.params).toContain("created");
    expect(query.params).toContain(true);
    expect(query.params).toContain(JSON.stringify(discoveryQuerySpec));
  });

  it("fails tenant-scoped stale discovery runs while preserving active processing jobs", () => {
    const staleBefore = new Date("2026-07-22T12:00:00.000Z");
    const processingStaleBefore = new Date("2026-07-22T10:10:00.000Z");
    const query = buildFailStaleActiveDiscoveryRunsQuery(db, {
      tenantId,
      staleBefore,
      processingStaleBefore,
    }).toSQL();

    expect(query.sql).toContain('update "discovery_runs"');
    expect(query.sql).toContain('"discovery_runs"."tenant_id" =');
    expect(query.sql).toContain('"discovery_runs"."status" in');
    expect(query.sql).toContain('"discovery_runs"."status" =');
    expect(query.sql).toContain('"discovery_runs"."updated_at" <=');
    expect(query.sql).toContain("NOT EXISTS");
    expect(query.sql).toContain("FROM queue_jobs active_prospect_jobs");
    expect(query.sql).toContain("active_prospect_jobs.status = 'active'");
    expect(query.sql).toContain("active_prospect_jobs.job_type IN");
    expect(query.sql).toContain("active_prospect_jobs.started_at >");
    expect(query.sql).toContain("active_prospect_jobs.payload->>'discovery_run_id'");
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain("created");
    expect(query.params).toContain("submitted");
    expect(query.params).toContain("polling");
    expect(query.params).toContain("processing");
    expect(query.params).not.toContain("persisted");
    expect(query.params).toContain("assess_prospects");
    expect(query.params).toContain("enrich_prospect_contacts");
    expect(query.params).toContain("failed");
    expect(query.params).toContain("discovery_run_stale_active");
    expect(query.params.map(String)).toContain(staleBefore.toISOString());
    expect(query.params.map(String)).toContain(processingStaleBefore.toISOString());
    expect(query.params.some((param) => param instanceof Date)).toBe(false);
  });

  it("fetches only the tenant's latest discovery run", () => {
    const query = buildLatestDiscoveryRunQuery(db, { tenantId }).toSQL();

    expect(query.sql).toContain('from "discovery_runs"');
    expect(query.sql).toContain('"discovery_runs"."tenant_id" =');
    expect(query.sql).toContain('order by "discovery_runs"."created_at" desc');
    expect(query.sql).toContain("limit");
    expect(query.params).toContain(tenantId);
  });

  it("fetches tenant-scoped prospect evidence for the latest run without lead pipeline joins", () => {
    const query = buildListProspectEvidenceForRunQuery(db, {
      tenantId,
      discoveryRunId: "20000000-0000-0000-0000-000000000001",
    }).toSQL();

    expect(query.sql).toContain('from "business_prospects"');
    expect(query.sql).toContain('left join "prospect_assessments"');
    expect(query.sql).toContain('left join "prospect_contacts"');
    expect(query.sql).toContain('"business_prospects"."tenant_id" =');
    expect(query.sql).toContain('"business_prospects"."discovery_run_id" =');
    expect(query.sql).toContain('"prospect_assessments"."tenant_id" =');
    expect(query.sql).toContain('"prospect_assessments"."prospect_id" =');
    expect(query.sql).toContain('"prospect_assessments"."assessment_type" =');
    expect(query.sql).toContain('"prospect_assessments"."assessment_version" =');
    expect(query.sql.toLowerCase()).toContain("case");
    expect(query.sql).toContain('"prospect_assessments"."total_score"');
    expect(query.sql).toContain('"prospect_assessments"."category_scores"');
    expect(query.sql).toContain('"prospect_assessments"."forced_route_reason"');
    expect(query.sql).toContain('"business_prospects"."matched_location_count"');
    expect(query.sql).toContain('"business_prospects"."duplicate_evidence"');
    expect(query.sql).toContain('"prospect_contacts"."tenant_id" =');
    expect(query.sql).toContain('"prospect_contacts"."prospect_id" =');
    expect(query.sql).toContain('"prospect_contacts"."provider" =');
    expect(query.sql).toContain("MAX(latest_prospect_contacts.created_at)");
    expect(query.sql).toContain('"prospect_contacts"."status"');
    expect(query.sql).toContain('"prospect_contacts"."match_evidence"');
    expect(query.sql).toContain('"business_prospects"."validation_sample"');
    expect(query.sql).toContain('"business_prospects"."validation_cohort"');
    expect(query.sql).toContain("latest_prospect_assessments.review_decision");
    expect(query.sql).toContain("latest_prospect_assessments.assessment_type = 'manual_review'");
    expect(query.sql).not.toContain('"prospect_contacts"."provider_payload"');
    expect(query.sql).not.toContain('join "leads"');
    expect(query.sql).not.toContain('join "outreach_sends"');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain("20000000-0000-0000-0000-000000000001");
    expect(query.params).toContain("automated");
    expect(query.params).toContain("route-a-normalization-v1");
    expect(query.params).toContain("website-health-v1");
    expect(query.params).toContain("apollo");
  });

  it("inserts manual prospect review from a tenant-run sample target with idempotency", () => {
    const statement = buildInsertManualProspectReviewQuery(db, {
      tenantId,
      discoveryRunId: "20000000-0000-0000-0000-000000000001",
      prospectId: "30000000-0000-0000-0000-000000000001",
      reviewerId: "40000000-0000-0000-0000-000000000001",
      idempotencyKey: "50000000-0000-0000-0000-000000000001",
      decision: "wrong_route",
      correctedRoute: "A",
      note: "Reviewed manually",
    });
    const query = toRawSQL(statement);

    expect(query.sql).toContain("WITH target AS");
    expect(query.sql).toContain('INSERT INTO "prospect_assessments"');
    expect(query.sql).toContain('"business_prospects"."tenant_id" =');
    expect(query.sql).toContain('"business_prospects"."discovery_run_id" =');
    expect(query.sql).toContain('"business_prospects"."validation_sample" = TRUE');
    expect(query.sql).toContain("ON CONFLICT (tenant_id, prospect_id, idempotency_key)");
    expect(query.sql).toContain("WHERE assessment_type = 'manual_review'");
    expect(query.sql).toContain("INNER JOIN target");
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain("40000000-0000-0000-0000-000000000001");
    expect(query.params).toContain("50000000-0000-0000-0000-000000000001");
    expect(query.params).not.toContain("browser-reviewer");
  });

  it("calculates review precision and yield gates from stored run and sample data", () => {
    const statement = buildProspectReviewMetricsQuery(db, {
      tenantId,
      discoveryRunId: "20000000-0000-0000-0000-000000000001",
    });
    const query = toRawSQL(statement);

    expect(query.sql).toContain("eligibilityPrecision");
    expect(query.sql).toContain("routePrecision");
    expect(query.sql).toContain("usableYield");
    expect(query.sql).toContain("routeableYield");
    expect(query.sql).toContain("unexpectedFailureRate");
    expect(query.sql).toContain("verifiedContactCount");
    expect(query.sql).toContain("providerUsagePresent");
    expect(query.sql).toContain("costReconciliationRequired");
    expect(query.sql).toContain("review_decision IN ('correct', 'wrong_route', 'ineligible')");
    expect(query.sql).toContain("review_decision = 'needs_investigation'");
    expect(query.sql).toContain("run.provider_usage ? 'apollo_contact_match'");
    expect(query.params).toContain(tenantId);
  });

  it("exports only normalized review cohort fields without raw provider payloads", () => {
    const statement = buildProspectReviewExportRowsQuery(db, {
      tenantId,
      discoveryRunId: "20000000-0000-0000-0000-000000000001",
    });
    const query = toRawSQL(statement);

    expect(query.sql).toContain('"business_prospects"."validation_sample" = TRUE');
    expect(query.sql).toContain('"business_prospects"."google_profile_url"');
    expect(query.sql).toContain('"prospect_contacts"."email"');
    expect(query.sql).toContain("manual.review_decision");
    expect(query.sql).toContain("automated.total_score");
    expect(query.sql).not.toContain("source_payload");
    expect(query.sql).not.toContain("provider_payload");
    expect(query.sql).not.toContain("raw_audit");
    expect(query.sql).not.toContain("outreach_sends");
    expect(query.params).toContain(tenantId);
  });

  it("marks only the tenant's created run failed after queue rejection", () => {
    const query = buildMarkDiscoveryRunFailedQuery(db, {
      tenantId,
      discoveryRunId: "20000000-0000-0000-0000-000000000001",
      failureCode: "queue_submission_failed",
    }).toSQL();

    expect(query.sql).toContain('update "discovery_runs"');
    expect(query.sql).toContain('"discovery_runs"."tenant_id" =');
    expect(query.sql).toContain('"discovery_runs"."id" =');
    expect(query.sql).toContain('"discovery_runs"."status" =');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain("20000000-0000-0000-0000-000000000001");
    expect(query.params).toContain("created");
    expect(query.params).toContain("failed");
    expect(query.params).toContain("queue_submission_failed");
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

  it("scopes each milestone cohort by tenant_id and excludes deleted leads", () => {
    const builders = [
      buildPipelineImportedCountQuery,
      buildPipelineEnrichedCountQuery,
      buildPipelineScoredCountQuery,
      buildPipelineContactedCountQuery,
      buildPipelineRepliedCountQuery,
      buildPipelinePaidCountQuery,
    ];

    for (const build of builders) {
      const query = build(db, { tenantId }).toSQL();

      expect(query.sql).toContain('"leads"."is_deleted" =');
      expect(query.params).toContain(tenantId);
    }

    for (const build of [
      buildPipelineQualifiedCountQuery,
      buildPipelineContactedQualifiedCountQuery,
    ]) {
      const query = build(db, { tenantId, scoreThreshold: 35 }).toSQL();

      expect(query.sql).toContain('"leads"."is_deleted" =');
      expect(query.params).toContain(tenantId);
    }
  });

  it("counts each milestone cohort from evidence rows that outlive the status change", () => {
    expect(buildPipelineImportedCountQuery(db, { tenantId }).toSQL().sql).toContain('from "leads"');

    const enriched = buildPipelineEnrichedCountQuery(db, { tenantId }).toSQL();
    expect(enriched.sql).toContain('from "enrichments"');
    expect(enriched.sql).toContain('count(distinct "enrichments"."lead_id")');

    const scored = buildPipelineScoredCountQuery(db, { tenantId }).toSQL();
    expect(scored.sql).toContain('from "qualifications"');
    expect(scored.sql).toContain('count(distinct "qualifications"."lead_id")');
    expect(scored.sql).not.toContain('"qualifications"."score" >=');

    const contacted = buildPipelineContactedCountQuery(db, { tenantId }).toSQL();
    expect(contacted.sql).toContain('from "outreach_sends"');
    expect(contacted.sql).toContain('count(distinct "outreach_sends"."lead_id")');

    const replied = buildPipelineRepliedCountQuery(db, { tenantId }).toSQL();
    expect(replied.sql).toContain('from "conversations"');
    expect(replied.sql).toContain('"conversations"."direction" =');
    expect(replied.params).toContain("inbound");

    const paid = buildPipelinePaidCountQuery(db, { tenantId }).toSQL();
    expect(paid.sql).toContain('from "payments"');
    expect(paid.sql).toContain('"payments"."status" =');
    expect(paid.params).toContain("paid");
  });

  /**
   * `qualifications` holds a row for every lead the qualifier scored, pass or
   * fail. The pass or fail decision is not a column: `qualify.py` compares the
   * score against the threshold from the job payload. So the qualified cohort
   * is only a cohort once the score predicate is applied.
   */
  it("counts the qualified cohort from the score threshold, not from every scored row", () => {
    const query = buildPipelineQualifiedCountQuery(db, { tenantId, scoreThreshold: 35 }).toSQL();

    expect(query.sql).toContain('from "qualifications"');
    expect(query.sql).toContain('count(distinct "qualifications"."lead_id")');
    expect(query.sql).toContain('"qualifications"."score" >=');
    expect(query.params).toContain(35);
  });

  it("passes whatever threshold it is given rather than a threshold of its own", () => {
    const query = buildPipelineQualifiedCountQuery(db, { tenantId, scoreThreshold: 60 }).toSQL();

    expect(query.params).toContain(60);
    expect(query.params).not.toContain(35);
  });

  /**
   * 1,960 leads were contacted but only 1,955 of them met the current
   * threshold, so the contacted numerator for the qualified step has to carry
   * the same score predicate or the rate divides two different populations.
   */
  it("scopes the contacted numerator to the leads that met the threshold", () => {
    const query = buildPipelineContactedQualifiedCountQuery(db, {
      tenantId,
      scoreThreshold: 35,
    }).toSQL();

    expect(query.sql).toContain('from "outreach_sends"');
    expect(query.sql).toContain('count(distinct "outreach_sends"."lead_id")');
    expect(query.sql).toContain('"qualifications"');
    expect(query.sql).toContain('"qualifications"."score" >=');
    expect(query.params).toContain(35);
  });

  /** The cohort counts verified against the production database. */
  const productionMilestoneRows = {
    imported: "7574",
    enriched: "7546",
    scored: "7543",
    qualified: "4291",
    contacted: "1960",
    contactedQualified: "1955",
    replied: "0",
    paid: "0",
  };

  /**
   * With no threshold there is no score predicate to build, so the two cohorts
   * that need one are not queried at all. Building them with a threshold of 0
   * would report every scored lead as qualified, which is the reading this
   * stage was corrected for.
   */
  it("builds no score-predicated query when the threshold is not configured", () => {
    expect(
      buildPipelineThresholdCohortQueries(db, { tenantId }, {
        available: false,
        reason: "QUALIFICATION_SCORE_THRESHOLD is not set",
      }),
    ).toBeNull();
  });

  it("builds both score-predicated cohorts from the configured threshold", () => {
    const queries = buildPipelineThresholdCohortQueries(db, { tenantId }, {
      available: true,
      value: 35,
    });

    expect(queries).not.toBeNull();
    for (const query of [queries!.qualified.toSQL(), queries!.contactedQualified.toSQL()]) {
      expect(query.sql).toContain('"qualifications"."score" >=');
      expect(query.params).toContain(35);
      expect(query.params).toContain(tenantId);
    }
  });

  it("reads the funnel from milestone cohorts, never from the status histogram", () => {
    const analytics = normalizePipelineAnalytics({
      milestones: productionMilestoneRows,
      qualificationThreshold: { available: true, value: 35 },
      statusRows: [
        { status: "imported", count: 45 },
        { status: "enriched", count: "2" },
        { status: "qualified", count: 2 },
        { status: "contacted", count: 1951 },
        { status: "archived", count: 5574 },
      ],
    });

    const qualifiedToContacted = analytics.conversions.find(
      (row) => row.from === "qualified" && row.to === "contacted",
    );
    expect(qualifiedToContacted?.rate.available).toBe(true);
    expect(qualifiedToContacted?.rate.available && qualifiedToContacted.rate.value).toBeCloseTo(
      45.6,
      1,
    );
    expect(qualifiedToContacted?.droppedCount).toEqual({ available: true, value: 2336 });

    expect(analytics.stages.map((stage) => stage.status)).toEqual([
      "imported",
      "enriched",
      "scored",
      "qualified",
      "contacted",
      "replied",
      "paid",
      "archived",
    ]);
    expect(analytics.total).toBe(7574);

    const contacted = analytics.stages.find((stage) => stage.status === "contacted");
    expect(contacted?.count).toEqual({ available: true, value: 1960 });
    expect(contacted?.currentCount).toBe(1951);
  });

  /**
   * The correction. Every scored lead has a `qualifications` row whether it
   * passed or failed, so the qualified cohort is the 4,291 that met the
   * threshold and the pass rate is 56.9%, not 100%.
   */
  it("reads the pass rate from the score threshold rather than from scoring coverage", () => {
    const analytics = normalizePipelineAnalytics({
      milestones: productionMilestoneRows,
      qualificationThreshold: { available: true, value: 35 },
      statusRows: [{ status: "contacted", count: 1951 }],
    });

    const scoredToQualified = analytics.conversions.find(
      (row) => row.from === "scored" && row.to === "qualified",
    );

    expect(scoredToQualified?.rate.available && scoredToQualified.rate.value).toBeCloseTo(56.9, 1);
    expect(scoredToQualified?.droppedCount).toEqual({ available: true, value: 3252 });

    const qualified = analytics.stages.find((stage) => stage.status === "qualified");
    expect(qualified?.count).toEqual({ available: true, value: 4291 });
    expect(qualified?.criterion).toBe("score 35 or above");
  });

  it("renders the qualified cohort as unavailable when the threshold is not configured", () => {
    const analytics = normalizePipelineAnalytics({
      milestones: { ...productionMilestoneRows, qualified: null, contactedQualified: null },
      qualificationThreshold: {
        available: false,
        reason: "QUALIFICATION_SCORE_THRESHOLD is not set",
      },
      statusRows: [{ status: "contacted", count: 1951 }],
    });

    const qualified = analytics.stages.find((stage) => stage.status === "qualified");
    expect(qualified?.count.available).toBe(false);
    expect(qualified?.count).not.toEqual({ available: true, value: 7543 });

    const scored = analytics.stages.find((stage) => stage.status === "scored");
    expect(scored?.count).toEqual({ available: true, value: 7543 });
  });

  /**
   * A null count is a cohort that was not measured. `toNumber` reads it as 0,
   * and 0 qualified leads is a measurement, so the two threshold cohorts have
   * to keep their null rather than being coerced.
   */
  it("never reads an uncounted cohort as zero qualified leads", () => {
    const analytics = normalizePipelineAnalytics({
      milestones: { ...productionMilestoneRows, qualified: null, contactedQualified: null },
      qualificationThreshold: { available: true, value: 35 },
      statusRows: [{ status: "contacted", count: 1951 }],
    });

    const qualified = analytics.stages.find((stage) => stage.status === "qualified");
    expect(qualified?.count.available).toBe(false);
    expect(qualified?.count).not.toEqual({ available: true, value: 0 });

    const qualifiedToContacted = analytics.conversions.find(
      (row) => row.from === "qualified" && row.to === "contacted",
    );
    expect(qualifiedToContacted?.count.available).toBe(false);
    expect(qualifiedToContacted?.rate.available).toBe(false);
  });

  it("keeps the replied cohort unavailable rather than reporting a zero reply rate", () => {
    const analytics = normalizePipelineAnalytics({
      milestones: productionMilestoneRows,
      qualificationThreshold: { available: true, value: 35 },
      statusRows: [{ status: "contacted", count: 1951 }],
    });

    const contactedToReplied = analytics.conversions.find(
      (row) => row.from === "contacted" && row.to === "replied",
    );

    expect(contactedToReplied?.rate.available).toBe(false);
    expect(contactedToReplied?.count.available).toBe(false);
  });

});

describe("today so far queries", () => {
  const dayStart = new Date("2026-06-14T14:00:00.000Z");
  const dayEnd = new Date("2026-06-15T14:00:00.000Z");
  const dayLabel = "Mon 15 Jun";

  const sent = (value: number): MetricAvailability<number> => ({ available: true, value });
  const missing = (
    reason = "Instantly daily analytics did not load.",
  ): MetricAvailability<number> => ({ available: false, reason });

  it("counts inbound replies inside the Sydney day and scopes them by tenant_id", () => {
    const query = buildTodayReplyCountQuery(db, { tenantId, dayStart, dayEnd }).toSQL();

    expect(query.sql).toContain('"conversations"."tenant_id" =');
    expect(query.sql).toContain('"conversations"."direction" =');
    expect(query.sql).toContain('"conversations"."created_at" >=');
    expect(query.sql).toContain('"conversations"."created_at" <');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain("inbound");
  });

  it("counts unsubscribes inside the Sydney day and scopes them by tenant_id", () => {
    const query = buildTodayUnsubscribeCountQuery(db, { tenantId, dayStart, dayEnd }).toSQL();

    expect(query.sql).toContain('"outreach_sends"."tenant_id" =');
    expect(query.sql).toContain('"outreach_sends"."updated_at" >=');
    expect(query.sql).toContain('"outreach_sends"."updated_at" <');
    expect(query.sql).toContain('count(*) filter (where "unsubscribed")');
    expect(query.params).toContain(tenantId);
  });

  it("no longer answers sends or bounces from outreach_sends", () => {
    // sent_at is stamped when a lead is handed to Instantly, not when the email
    // is sent, so no query in this module may answer either figure.
    expect(Object.keys(queryModule)).not.toContain("buildTodaySendCountQuery");
    expect(Object.keys(queryModule)).not.toContain("buildTodaySuppressionCountsQuery");

    const query = buildTodayUnsubscribeCountQuery(db, { tenantId, dayStart, dayEnd }).toSQL();
    expect(query.sql).not.toContain("sent_at");
    expect(query.sql).not.toContain("bounced");
  });

  it("takes sends and bounces from Instantly and leaves replies and unsubscribes on the database", () => {
    const summary = normalizeTodaySoFar({
      dayLabel,
      sent: sent(200),
      bounces: sent(4),
      replies: 7,
      unsubscribes: 1,
    });

    expect(summary.sent).toEqual({ available: true, value: 200 });
    expect(summary.bounces).toEqual({ available: true, value: 4 });
    expect(summary.replies).toBe(7);
    expect(summary.unsubscribes).toBe(1);
  });

  it("divides each rate by the Instantly send count, not by the pipeline total", () => {
    const summary = normalizeTodaySoFar({
      dayLabel,
      sent: sent(200),
      bounces: sent(4),
      replies: 7,
      unsubscribes: 1,
    });

    expect(summary.replyRate.available).toBe(true);
    expect(summary.replyRate.available ? summary.replyRate.value : null).toBeCloseTo(3.5, 10);
    expect(summary.bounceRate.available ? summary.bounceRate.value : null).toBeCloseTo(2, 10);
    expect(summary.unsubscribeRate.available ? summary.unsubscribeRate.value : null).toBeCloseTo(
      0.5,
      10,
    );
  });

  it("reads database count columns that postgres returns as strings", () => {
    const summary = normalizeTodaySoFar({
      dayLabel,
      sent: sent(40),
      bounces: sent(1),
      replies: "2",
      unsubscribes: "0",
    });

    expect(summary.replies).toBe(2);
    expect(summary.unsubscribes).toBe(0);
    expect(summary.replyRate.available ? summary.replyRate.value : null).toBeCloseTo(5, 10);
  });

  it("warns only once a bounce rate is above three percent", () => {
    const atThreshold = normalizeTodaySoFar({
      dayLabel,
      sent: sent(100),
      bounces: sent(3),
      replies: 0,
      unsubscribes: 0,
    });
    const overThreshold = normalizeTodaySoFar({
      dayLabel,
      sent: sent(100),
      bounces: sent(4),
      replies: 0,
      unsubscribes: 0,
    });

    expect(atThreshold.bounceRate.available ? atThreshold.bounceRate.value : null).toBeCloseTo(
      3,
      10,
    );
    expect(atThreshold.bounceTone).toBe("neutral");
    expect(overThreshold.bounceRate.available ? overThreshold.bounceRate.value : null).toBeCloseTo(
      4,
      10,
    );
    expect(overThreshold.bounceTone).toBe("warning");
  });

  it("warns only once an unsubscribe rate is above half a percent", () => {
    const atThreshold = normalizeTodaySoFar({
      dayLabel,
      sent: sent(200),
      bounces: sent(0),
      replies: 0,
      unsubscribes: 1,
    });
    const overThreshold = normalizeTodaySoFar({
      dayLabel,
      sent: sent(200),
      bounces: sent(0),
      replies: 0,
      unsubscribes: 2,
    });

    expect(
      atThreshold.unsubscribeRate.available ? atThreshold.unsubscribeRate.value : null,
    ).toBeCloseTo(0.5, 10);
    expect(atThreshold.unsubscribeTone).toBe("neutral");
    expect(
      overThreshold.unsubscribeRate.available ? overThreshold.unsubscribeRate.value : null,
    ).toBeCloseTo(1, 10);
    expect(overThreshold.unsubscribeTone).toBe("warning");
  });

  it("keeps a bounce below the threshold neutral even when unsubscribes are hot", () => {
    const summary = normalizeTodaySoFar({
      dayLabel,
      sent: sent(100),
      bounces: sent(1),
      replies: 0,
      unsubscribes: 3,
    });

    expect(summary.bounceTone).toBe("neutral");
    expect(summary.unsubscribeTone).toBe("warning");
  });

  it("leaves rates unmeasured rather than zero when nothing has been sent", () => {
    const summary = normalizeTodaySoFar({
      dayLabel,
      sent: sent(0),
      bounces: sent(0),
      replies: 0,
      unsubscribes: 0,
    });

    expect(summary.anySent).toBe(false);
    expect(summary.hasActivity).toBe(false);
    expect(summary.replyRate.available).toBe(false);
    expect(summary.bounceRate.available).toBe(false);
    expect(summary.unsubscribeRate.available).toBe(false);
    expect(summary.bounceTone).toBe("neutral");
    expect(summary.unsubscribeTone).toBe("neutral");
  });

  it("carries the unavailable send count through instead of reporting zero sends", () => {
    const summary = normalizeTodaySoFar({
      dayLabel,
      sent: missing(),
      bounces: missing(),
      replies: 2,
      unsubscribes: 0,
    });

    expect(summary.sent.available).toBe(false);
    expect(summary.sent.available ? null : summary.sent.reason).toBe(
      "Instantly daily analytics did not load.",
    );
    expect(summary.bounces.available).toBe(false);
    expect(summary.anySent).toBe(false);
    // The tiles still have to render, otherwise the failure hides behind the
    // quiet day note and reads as "nothing went out".
    expect(summary.hasActivity).toBe(true);
  });

  /**
   * The worst case for this bar: Instantly is unreachable and nothing else
   * happened today either. Every counted figure is zero, so a naive activity
   * check falls through to the quiet day note and the outage renders as
   * "nothing has come back", which is the confusion this branch exists to fix.
   */
  it("keeps the tiles on screen during an outage with no other activity", () => {
    const summary = normalizeTodaySoFar({
      dayLabel,
      sent: missing(),
      bounces: missing(),
      replies: 0,
      unsubscribes: 0,
    });

    expect(summary.hasActivity).toBe(true);
    expect(summary.sent.available).toBe(false);
    expect(summary.anySent).toBe(false);
  });

  it("refuses to compute a rate against a send count it does not have", () => {
    const summary = normalizeTodaySoFar({
      dayLabel,
      sent: missing(),
      bounces: missing(),
      replies: 7,
      unsubscribes: 1,
    });

    expect(summary.replyRate.available).toBe(false);
    expect(summary.unsubscribeRate.available).toBe(false);
    expect(summary.bounceRate.available).toBe(false);
    expect(summary.replies).toBe(7);
    expect(summary.bounceTone).toBe("neutral");
    expect(summary.unsubscribeTone).toBe("neutral");
    expect(summary.replyRate.available ? null : summary.replyRate.reason).toMatch(/send count/i);
  });

  /**
   * The denominator, not the numerator, is the one that was faked before. A
   * real bounce count divided by yesterday's or by a zero would print a
   * confident percentage that today's data does not support.
   */
  it("withholds every rate when the send count is missing but the counts are real", () => {
    const summary = normalizeTodaySoFar({
      dayLabel,
      sent: missing("Instantly daily analytics did not load."),
      bounces: sent(3),
      replies: 7,
      unsubscribes: 1,
    });

    expect(summary.bounces).toEqual({ available: true, value: 3 });
    expect(summary.bounceRate.available).toBe(false);
    expect(summary.replyRate.available).toBe(false);
    expect(summary.unsubscribeRate.available).toBe(false);
    for (const rate of [summary.bounceRate, summary.replyRate, summary.unsubscribeRate]) {
      expect(rate.available ? null : rate.reason).toMatch(/send count/i);
    }
    expect(summary.bounceTone).toBe("neutral");
    expect(summary.unsubscribeTone).toBe("neutral");
  });

  it("keeps the bounce rate unavailable when only the bounce count is missing", () => {
    const summary = normalizeTodaySoFar({
      dayLabel,
      sent: sent(200),
      bounces: missing("Instantly reported no bounce figure."),
      replies: 7,
      unsubscribes: 1,
    });

    expect(summary.bounceRate.available).toBe(false);
    expect(summary.bounceRate.available ? null : summary.bounceRate.reason).toBe(
      "Instantly reported no bounce figure.",
    );
    expect(summary.replyRate.available ? summary.replyRate.value : null).toBeCloseTo(3.5, 10);
  });

  /**
   * Instantly publishes no bounce figure that can be cut at Sydney midnight, so
   * the bounce count is permanently unavailable. That must not be read as a
   * failure: if it forced the tiles open, a genuinely quiet day would never
   * reach the quiet day note again and the note would be dead code.
   */
  it("still shows the quiet day note when only the structurally missing bounce count is absent", () => {
    const summary = normalizeTodaySoFar({
      dayLabel,
      sent: sent(0),
      bounces: missing("Instantly reports bounces only as a whole UTC calendar day."),
      replies: 0,
      unsubscribes: 0,
    });

    expect(summary.hasActivity).toBe(false);
    expect(summary.anySent).toBe(false);
  });

  it("keeps the tiles open on a sending day whose bounce count is unavailable", () => {
    const summary = normalizeTodaySoFar({
      dayLabel,
      sent: sent(30),
      bounces: missing("Instantly reports bounces only as a whole UTC calendar day."),
      replies: 0,
      unsubscribes: 0,
    });

    expect(summary.hasActivity).toBe(true);
    expect(summary.anySent).toBe(true);
  });

  it("counts a reply to yesterday's send as activity even with no sends today", () => {
    const summary = normalizeTodaySoFar({
      dayLabel,
      sent: sent(0),
      bounces: sent(0),
      replies: 2,
      unsubscribes: 0,
    });

    expect(summary.anySent).toBe(false);
    expect(summary.hasActivity).toBe(true);
    expect(summary.replies).toBe(2);
    expect(summary.replyRate.available).toBe(false);
  });

  it("reports opens as untracked rather than as zero", () => {
    const summary = normalizeTodaySoFar({
      dayLabel,
      sent: sent(120),
      bounces: sent(0),
      replies: 3,
      unsubscribes: 0,
    });

    expect(summary.opensTracked).toBe(false);
    expect(summary.opens).toBeNull();
  });

  it("publishes the thresholds a sender has to react to", () => {
    expect(BOUNCE_RATE_WARNING_PERCENT).toBe(3);
    expect(UNSUBSCRIBE_RATE_WARNING_PERCENT).toBe(0.5);
  });
});

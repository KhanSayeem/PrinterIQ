import "server-only";

import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, max, min, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { MetricAvailability } from "@/lib/deliverability";
import type { PreviewViewFilter } from "@/lib/lead-list-params";
import {
  DEFAULT_REPLY_INBOX_FILTER,
  type ReplyInboxFilter,
  type ReplyIntent,
} from "@/lib/reply-inbox-params";
import {
  buildPipelineFunnel,
  PIPELINE_STAGES,
  type PipelineAnalytics,
  type PipelineStageKey,
} from "@/lib/pipeline-funnel";
import { PAID_LEAD_FILTER, PAID_PAYMENT_STATUS } from "@/lib/paid-payments";
import { readQualificationScoreThreshold } from "@/lib/qualification-threshold";
import type { ReplyIngestSignal } from "@/lib/reply-ingest-health";
import type { TodaySendTotals } from "@/lib/today-sends";
import { formatSydneyDayLabel, getSydneyDayRange } from "@/lib/sydney-day";
import { getDb } from "./client";
import {
  conversations,
  discoveryRuns,
  enrichments,
  leads,
  outreachSends,
  payments,
  businessProspects,
  prospectAssessments,
  prospectContacts,
  qualifications,
  websitePreviews,
} from "./schema";

type DashboardDb = ReturnType<typeof getDb>;

const ROUTE_A_ASSESSMENT_VERSION = "route-a-normalization-v1";
const WEBSITE_HEALTH_ASSESSMENT_VERSION = "website-health-v1";
const STALE_PROCESSING_DISCOVERY_MINUTES = 120;
const ACTIVE_PROSPECT_DISCOVERY_JOB_TYPES = [
  "normalize_prospects",
  "assess_prospects",
  "enrich_prospect_contacts",
  "prepare_shadow_review",
] as const;

export const REVENUE_PERIODS = ["today", "week", "month"] as const;

export type PipelineStatus = PipelineStageKey;
export type RevenuePeriod = (typeof REVENUE_PERIODS)[number];

export type LeadListFilters = {
  tenantId: string;
  status?: string;
  state?: string;
  tradeType?: string;
  search?: string;
  scoreMin?: number;
  scoreMax?: number;
  unsubscribed?: boolean;
  previewView?: PreviewViewFilter;
  page?: number;
  pageSize?: number;
};

export type LeadFilterCounts = {
  all: number;
  qualified: number;
  contacted: number;
  replied: number;
  paid: number;
  archived: number;
  unsubscribed: number;
  previewSeen: number;
  previewUnseen: number;
};

export type LeadIdentity = {
  tenantId: string;
  leadId: string;
};

export type CreateDiscoveryRunInput = {
  tenantId: string;
  querySpec: Record<string, unknown>;
};

export type MarkDiscoveryRunFailedInput = {
  tenantId: string;
  discoveryRunId: string;
  failureCode: string;
};

export type FailStaleActiveDiscoveryRunsInput = {
  tenantId: string;
  staleBefore: Date;
  processingStaleBefore: Date;
};

export type ProspectEvidenceView = {
  id: string;
  businessName: string;
  route: string | null;
  status: string;
  validationSample: boolean;
  validationCohort: string | null;
  websiteOwnership: string | null;
  outcomeReason: string | null;
  sourceWebsiteUrl: string | null;
  normalizedDomain: string | null;
  matchedLocationCount: number;
  duplicateEvidence: unknown;
  ruleEvidence: unknown;
  totalScore: number | null;
  categoryScores: unknown;
  forcedRouteReason: string | null;
  contactStatus: string | null;
  contactPersonName: string | null;
  contactPersonTitle: string | null;
  contactEmail: string | null;
  contactEmailStatus: string | null;
  contactEvidence: unknown;
  reviewDecision: string | null;
  correctedRoute: string | null;
  reviewNote: string | null;
  reviewedAt: Date | string | null;
};

export type ManualProspectReviewInput = {
  tenantId: string;
  discoveryRunId: string;
  prospectId: string;
  reviewerId: string;
  idempotencyKey: string;
  decision: "correct" | "wrong_route" | "ineligible" | "needs_investigation";
  correctedRoute?: "A" | "B" | "manual_review" | "healthy";
  note?: string;
};

export type ProspectReviewMetrics = {
  sampleCount: number;
  routeASampleCount: number;
  routeBSampleCount: number;
  healthyRejectedSampleCount: number;
  reviewedCount: number;
  decisiveReviewCount: number;
  missingReviewCount: number;
  needsInvestigationCount: number;
  eligibilityPrecision: number | null;
  routePrecision: number | null;
  usableYield: number | null;
  routeableYield: number | null;
  routeAYield: number | null;
  routeBYield: number | null;
  unexpectedFailureRate: number | null;
  verifiedContactCount: number;
  routeAVerifiedEmailMatchRate: number | null;
  routeBVerifiedEmailMatchRate: number | null;
  providerUsagePresent: boolean;
  costReconciliationRequired: boolean;
};

export type ProspectReviewExportRow = {
  businessName: string;
  normalizedName: string;
  primaryCategory: string | null;
  locality: string | null;
  state: string | null;
  postcode: string | null;
  googleProfileUrl: string | null;
  sourceWebsiteUrl: string | null;
  normalizedDomain: string | null;
  route: string | null;
  status: string;
  validationCohort: string | null;
  outcomeReason: string | null;
  totalScore: number | null;
  contactStatus: string | null;
  contactPersonName: string | null;
  contactPersonTitle: string | null;
  contactEmail: string | null;
  contactEmailStatus: string | null;
  reviewDecision: string | null;
  correctedRoute: string | null;
  reviewNote: string | null;
  reviewedAt: Date | string | null;
  prospectCreatedAt: Date | string;
  prospectUpdatedAt: Date | string;
};

export type OperatorConversationInput = LeadIdentity & {
  direction: "note" | "outbound";
  channel: "note" | "email";
  body: string;
};

export type LeadStatusUpdateInput = LeadIdentity & {
  status: Extract<PipelineStatus, "replied" | "archived">;
};

const STATUS_TRANSITION_ALLOWED_FROM: Record<LeadStatusUpdateInput["status"], PipelineStatus[]> = {
  replied: ["contacted", "replied"],
  archived: ["contacted", "replied"],
};

export type InstantlyReplyMetadata = {
  instantlyEmailId: string;
  instantlyAccountId: string;
};

export type WebsitePreviewDetail = {
  templateUsed: string;
  previewUrl: string;
  personalisationData: Record<string, unknown>;
  promptVersion: string;
  costUsd: string;
  generatedAt: Date | string;
};

export type DeleteOperatorNoteInput = LeadIdentity & {
  conversationId: string;
};

export type LeadLatestConversation = {
  id: string;
  leadId: string;
  direction: string;
  body: string;
  instantlyEmailId: string | null;
  instantlyAccountId: string | null;
  createdAt: Date | string;
};

export type {
  PipelineAnalytics,
  PipelineConversion,
  PipelineStage,
} from "@/lib/pipeline-funnel";

export type RevenueAnalytics = {
  period: RevenuePeriod;
  periodStart: Date;
  totalRevenueAud: number;
  paidCount: number;
  importedCount: number;
  paidConversionRate: number | null;
  aiCosts: AiCostByModel[];
  totalAiCostUsd: number;
};

/**
 * Deliverability limits the operator has to react to before a sending domain
 * is burned. Both are read as strictly above: a day sitting exactly on the
 * line is not yet an alarm.
 */
export const BOUNCE_RATE_WARNING_PERCENT = 3;
export const UNSUBSCRIBE_RATE_WARNING_PERCENT = 0.5;

export type TodayMetricTone = "neutral" | "warning";

export type TodaySoFarCounts = {
  dayLabel: string;
  /**
   * Sends and bounces come from Instantly, which is the only system that knows
   * whether an email left a mailbox. `outreach_sends.sent_at` records the
   * handoff to Instantly, not the send, so it cannot answer either figure.
   */
  sent: MetricAvailability<number>;
  bounces: MetricAvailability<number>;
  /** Database counts, written by the Instantly reply and unsubscribe webhooks. */
  replies: unknown;
  unsubscribes: unknown;
  /**
   * Sends flagged unsubscribed before `unsubscribed_at` existed, whose last
   * write falls in today's window. Optional so a caller with nothing to report
   * can leave it out, and absent reads as none.
   */
  unsubscribesUndated?: unknown;
};

export type TodaySoFarSummary = {
  dayLabel: string;
  /** Not available rather than zero when Instantly could not be read. */
  sent: MetricAvailability<number>;
  /**
   * Always null. Nothing in this system writes `outreach_sends.opened`: there
   * is no Instantly open webhook and no analytics poller, so the column has
   * been false on every row since it was created. Reporting null keeps the
   * gap visible instead of drawing a zero that reads like a bad send day.
   */
  opens: number | null;
  opensTracked: boolean;
  replies: number;
  bounces: MetricAvailability<number>;
  /** Unsubscribes whose own event time falls inside today. */
  unsubscribes: number;
  /**
   * Unsubscribes today's window contains that carry no event time, because the
   * row was flagged before migration 0014. Not added to `unsubscribes`: their
   * day is unknown. They suppress the rate instead, so the gap is stated on the
   * tile rather than hidden inside a smaller count.
   */
  unsubscribesUndated: number;
  /**
   * Percentages of today's sends. A rate is only available when the count and
   * the send count it divides by are both available, so a rate is never
   * reported against a denominator it did not come from.
   */
  replyRate: MetricAvailability<number>;
  bounceRate: MetricAvailability<number>;
  unsubscribeRate: MetricAvailability<number>;
  bounceTone: TodayMetricTone;
  unsubscribeTone: TodayMetricTone;
  anySent: boolean;
  hasActivity: boolean;
};

export type AiCostByModel = {
  modelFamily: "Haiku" | "Sonnet";
  modelName: string;
  promptVersion: string;
  calls: number;
  costUsd: number;
};

function requireTenantId(tenantId: string) {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }
}

function toNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeLeadPagination(filters: { page?: number; pageSize?: number }) {
  return {
    page: Math.max(filters.page ?? 1, 1),
    pageSize: Math.min(Math.max(filters.pageSize ?? 25, 1), 100),
  };
}

export function normalizeLeadListPageMeta({
  total,
  page,
  pageSize,
}: {
  total: number;
  page: number;
  pageSize: number;
}) {
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);

  return {
    total,
    page: Math.min(Math.max(page, 1), totalPages),
    pageSize,
    totalPages,
  };
}

function leadUnsubscribedExists(tenantId: string) {
  return sql`exists (
    select 1 from ${outreachSends}
    where ${outreachSends.leadId} = ${leads.id}
      and ${outreachSends.tenantId} = ${tenantId}
      and ${outreachSends.unsubscribed} = true
  )`;
}

/**
 * A lead with a sale behind it, defined once and used by the Paid pill's count,
 * by the Paid pill's filter and by nothing else.
 *
 * Exported only so a test can render this fragment on its own and assert that
 * the count and the filter contain the same one. A pill whose count disagrees
 * with its own list is invisible until an operator clicks it, which is exactly
 * how the old Paid pill would have failed: the count came from `leads.status`
 * and the dollars on `/revenue` came from `payments`.
 */
export function leadPaidPaymentExists(tenantId: string) {
  return sql`exists (
    select 1 from ${payments}
    where ${payments.leadId} = ${leads.id}
      and ${payments.tenantId} = ${tenantId}
      and ${payments.status} = ${PAID_PAYMENT_STATUS}
  )`;
}

/**
 * Paid is the one pill that is not a `leads.status` bucket. Every other status
 * here is a current state and reads as one; paid is money, and money has to
 * read the same on `/leads`, `/pipeline` and `/revenue`.
 *
 * Replied deliberately stays on `leads.status`. Its milestone evidence,
 * inbound `conversations`, is already reported as a cohort on `/pipeline`, and
 * a lead that replied and has since paid or been archived is no longer sitting
 * in replied. Sourcing the pill from that evidence would count those leads in
 * two pills at once and push the pills past the All total. Paid escapes that
 * because paid is terminal: nothing moves a lead out of it.
 */
function leadStatusCondition(status: string, tenantId: string) {
  return status === PAID_LEAD_FILTER
    ? leadPaidPaymentExists(tenantId)
    : eq(leads.status, status);
}

function previewViewCondition(previewView: PreviewViewFilter) {
  return previewView === "seen"
    ? isNotNull(websitePreviews.firstViewedAt)
    : and(isNotNull(websitePreviews.id), isNull(websitePreviews.firstViewedAt));
}

function buildLeadListWhere(filters: LeadListFilters) {
  const search = filters.search?.trim();
  const searchPattern = search ? `%${search}%` : undefined;

  return [
    eq(leads.tenantId, filters.tenantId),
    eq(leads.isDeleted, false),
    filters.status ? leadStatusCondition(filters.status, filters.tenantId) : undefined,
    filters.state ? eq(leads.state, filters.state) : undefined,
    filters.tradeType ? eq(leads.vertical, filters.tradeType) : undefined,
    searchPattern
      ? or(
          ilike(leads.firstName, searchPattern),
          ilike(leads.lastName, searchPattern),
          sql`${leads.firstName} || ' ' || ${leads.lastName} ilike ${searchPattern}`,
          ilike(leads.email, searchPattern),
          ilike(leads.businessName, searchPattern),
          ilike(leads.websiteUrl, searchPattern),
          ilike(leads.city, searchPattern),
          ilike(leads.state, searchPattern),
        )
      : undefined,
    filters.scoreMin === undefined ? undefined : gte(qualifications.score, filters.scoreMin),
    filters.scoreMax === undefined ? undefined : lte(qualifications.score, filters.scoreMax),
    filters.unsubscribed ? leadUnsubscribedExists(filters.tenantId) : undefined,
    filters.previewView ? previewViewCondition(filters.previewView) : undefined,
  ].filter(Boolean);
}

type PipelineCountRow = number | string;

export type PipelineAnalyticsRows = {
  /**
   * One count per funnel milestone, as returned by the cohort queries. The two
   * cohorts that need the passing score are null when it is not configured,
   * because their queries cannot be built without it.
   */
  milestones: {
    imported: PipelineCountRow;
    enriched: PipelineCountRow;
    scored: PipelineCountRow;
    qualified: PipelineCountRow | null;
    contacted: PipelineCountRow;
    contactedQualified: PipelineCountRow | null;
    replied: PipelineCountRow;
    paid: PipelineCountRow;
  };
  /** The `leads.status` histogram. Used for the current status figures only. */
  statusRows: Array<{ status: string; count: number | string }>;
  /** The passing score, or the reason the funnel cannot name one. */
  qualificationThreshold: MetricAvailability<number>;
};

/**
 * Turns the cohort and status rows into the funnel view model. The funnel
 * itself is computed by `buildPipelineFunnel`; this only coerces the counts,
 * which arrive from postgres as strings.
 *
 * A null count stays null rather than becoming zero. `toNumber` reads an
 * unmeasured value as 0, and 0 qualified leads is a measurement, so the two
 * threshold cohorts are coerced separately.
 */
export function normalizePipelineAnalytics(rows: PipelineAnalyticsRows): PipelineAnalytics {
  const optional = (value: PipelineCountRow | null) => (value === null ? null : toNumber(value));

  const currentCounts: Partial<Record<PipelineStageKey, number>> = {};
  for (const row of rows.statusRows) {
    if ((PIPELINE_STAGES as readonly string[]).includes(row.status)) {
      currentCounts[row.status as PipelineStageKey] = toNumber(row.count);
    }
  }

  return buildPipelineFunnel({
    milestones: {
      imported: toNumber(rows.milestones.imported),
      enriched: toNumber(rows.milestones.enriched),
      scored: toNumber(rows.milestones.scored),
      qualified: optional(rows.milestones.qualified),
      contacted: toNumber(rows.milestones.contacted),
      contactedQualified: optional(rows.milestones.contactedQualified),
      replied: toNumber(rows.milestones.replied),
      paid: toNumber(rows.milestones.paid),
    },
    currentCounts,
    qualificationThreshold: rows.qualificationThreshold,
  });
}

export function normalizeRevenuePeriod(period: string | undefined): RevenuePeriod {
  return REVENUE_PERIODS.includes(period as RevenuePeriod) ? (period as RevenuePeriod) : "today";
}

export function getRevenuePeriodStart(period: RevenuePeriod, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  if (period === "week") {
    const day = start.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + mondayOffset);
  }

  if (period === "month") {
    start.setDate(1);
  }

  return start;
}

export function buildLeadListQuery(db: DashboardDb, filters: LeadListFilters) {
  requireTenantId(filters.tenantId);

  const { page, pageSize } = normalizeLeadPagination(filters);
  const where = buildLeadListWhere(filters);

  return db
    .select({
      id: leads.id,
      firstName: leads.firstName,
      lastName: leads.lastName,
      email: leads.email,
      phone: leads.phone,
      businessName: leads.businessName,
      city: leads.city,
      state: leads.state,
      websiteUrl: leads.websiteUrl,
      vertical: leads.vertical,
      status: leads.status,
      createdAt: leads.createdAt,
      updatedAt: leads.updatedAt,
      score: qualifications.score,
      topWeakness: qualifications.topWeakness,
      personalisedOpener: qualifications.personalisedOpener,
      weaknesses: enrichments.weaknesses,
    })
    .from(leads)
    .leftJoin(
      enrichments,
      and(eq(enrichments.leadId, leads.id), eq(enrichments.tenantId, filters.tenantId)),
    )
    .leftJoin(
      qualifications,
      and(eq(qualifications.leadId, leads.id), eq(qualifications.tenantId, filters.tenantId)),
    )
    .leftJoin(
      websitePreviews,
      and(eq(websitePreviews.leadId, leads.id), eq(websitePreviews.tenantId, filters.tenantId)),
    )
    .where(and(...where))
    .orderBy(desc(leads.updatedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
}

export function buildLeadListCountQuery(db: DashboardDb, filters: LeadListFilters) {
  requireTenantId(filters.tenantId);
  const where = buildLeadListWhere(filters);

  return db
    .select({
      total: sql<string>`count(*)`,
    })
    .from(leads)
    .leftJoin(
      qualifications,
      and(eq(qualifications.leadId, leads.id), eq(qualifications.tenantId, filters.tenantId)),
    )
    .leftJoin(
      websitePreviews,
      and(eq(websitePreviews.leadId, leads.id), eq(websitePreviews.tenantId, filters.tenantId)),
    )
    .where(and(...where));
}

export function buildLeadFilterCountsQuery(db: DashboardDb, identity: { tenantId: string }) {
  requireTenantId(identity.tenantId);

  // website_previews.lead_id is unique, so this join cannot fan the lead rows out.
  // The unsubscribed and preview tallies ride along on the existing single pass
  // instead of adding further tenant-wide aggregates per page load.
  return db
    .select({
      status: leads.status,
      count: sql<string>`count(*)`,
      unsubscribedCount: sql<string>`count(*) filter (where ${leadUnsubscribedExists(identity.tenantId)})`,
      // Counted per status group and summed across them, so a lead that paid
      // while sitting in some other status is still counted once.
      paidCount: sql<string>`count(*) filter (where ${leadPaidPaymentExists(identity.tenantId)})`,
      previewSeenCount: sql<string>`count(*) filter (where ${websitePreviews.firstViewedAt} is not null)`,
      previewUnseenCount: sql<string>`count(*) filter (where ${websitePreviews.id} is not null and ${websitePreviews.firstViewedAt} is null)`,
    })
    .from(leads)
    .leftJoin(
      websitePreviews,
      and(eq(websitePreviews.leadId, leads.id), eq(websitePreviews.tenantId, identity.tenantId)),
    )
    .where(and(eq(leads.tenantId, identity.tenantId), eq(leads.isDeleted, false)))
    .groupBy(leads.status);
}

export function buildLatestConversationsForLeadsQuery(
  db: DashboardDb,
  identity: { tenantId: string; leadIds: string[] },
) {
  requireTenantId(identity.tenantId);

  return db
    .selectDistinctOn([conversations.leadId], {
      id: conversations.id,
      leadId: conversations.leadId,
      direction: conversations.direction,
      body: conversations.body,
      instantlyEmailId: conversations.instantlyEmailId,
      instantlyAccountId: conversations.instantlyAccountId,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(and(eq(conversations.tenantId, identity.tenantId), inArray(conversations.leadId, identity.leadIds)))
    .orderBy(conversations.leadId, desc(conversations.createdAt), desc(conversations.id));
}

export function buildLeadDetailQuery(db: DashboardDb, identity: LeadIdentity) {
  requireTenantId(identity.tenantId);

  return db
    .select({
      lead: leads,
      enrichment: enrichments,
      qualification: qualifications,
      websitePreview: {
        templateUsed: websitePreviews.templateUsed,
        previewUrl: websitePreviews.previewUrl,
        personalisationData: websitePreviews.personalisationData,
        promptVersion: websitePreviews.promptVersion,
        costUsd: websitePreviews.costUsd,
        generatedAt: websitePreviews.generatedAt,
      },
    })
    .from(leads)
    .leftJoin(
      enrichments,
      and(eq(enrichments.leadId, leads.id), eq(enrichments.tenantId, identity.tenantId)),
    )
    .leftJoin(
      qualifications,
      and(eq(qualifications.leadId, leads.id), eq(qualifications.tenantId, identity.tenantId)),
    )
    .leftJoin(
      websitePreviews,
      and(eq(websitePreviews.leadId, leads.id), eq(websitePreviews.tenantId, identity.tenantId)),
    )
    .where(and(eq(leads.tenantId, identity.tenantId), eq(leads.id, identity.leadId)))
    .limit(1);
}

export function buildRelatedLeadDataQueries(db: DashboardDb, identity: LeadIdentity) {
  requireTenantId(identity.tenantId);
  const whereLead = (table: { tenantId: AnyPgColumn; leadId: AnyPgColumn }) =>
    and(eq(table.tenantId, identity.tenantId), eq(table.leadId, identity.leadId));

  return [
    db.select().from(conversations).where(whereLead(conversations)).orderBy(asc(conversations.createdAt)),
    db.select().from(outreachSends).where(whereLead(outreachSends)).orderBy(asc(outreachSends.step)),
    db.select().from(payments).where(whereLead(payments)).limit(1),
    db.select().from(enrichments).where(whereLead(enrichments)).limit(1),
    db.select().from(qualifications).where(whereLead(qualifications)).limit(1),
  ];
}

export function buildInsertOperatorConversationQuery(
  db: DashboardDb,
  input: OperatorConversationInput,
) {
  requireTenantId(input.tenantId);

  return db.execute<{
    id: string;
    leadId: string;
    direction: string;
    channel: string;
    body: string;
    createdAt: Date | string;
  }>(sql`
    INSERT INTO ${conversations} (
      tenant_id,
      lead_id,
      direction,
      channel,
      body,
      operator_override,
      sent_at
    )
    SELECT
      ${leads.tenantId},
      ${leads.id},
      ${input.direction},
      ${input.channel},
      ${input.body},
      ${true},
      ${input.direction === "outbound" ? new Date() : null}
    FROM ${leads}
    WHERE ${leads.tenantId} = ${input.tenantId}
      AND ${leads.id} = ${input.leadId}
    RETURNING
      ${conversations.id} AS "id",
      ${conversations.leadId} AS "leadId",
      ${conversations.direction} AS "direction",
      ${conversations.channel} AS "channel",
      ${conversations.body} AS "body",
      ${conversations.createdAt} AS "createdAt"
  `);
}

export function buildUpdateLeadStatusQuery(db: DashboardDb, input: LeadStatusUpdateInput) {
  requireTenantId(input.tenantId);
  const allowedFrom = STATUS_TRANSITION_ALLOWED_FROM[input.status];

  return db
    .update(leads)
    .set({ status: input.status, updatedAt: new Date() })
    .where(and(eq(leads.tenantId, input.tenantId), eq(leads.id, input.leadId), inArray(leads.status, allowedFrom)))
    .returning({
      id: leads.id,
      status: leads.status,
    });
}

export function buildLeadStatusTransitionCheckQuery(db: DashboardDb, input: LeadStatusUpdateInput) {
  requireTenantId(input.tenantId);
  const allowedFrom = STATUS_TRANSITION_ALLOWED_FROM[input.status];

  return db
    .select({
      id: leads.id,
      status: leads.status,
    })
    .from(leads)
    .where(and(eq(leads.tenantId, input.tenantId), eq(leads.id, input.leadId), inArray(leads.status, allowedFrom)))
    .limit(1);
}

export function buildLatestInstantlyLeadIdQuery(db: DashboardDb, identity: LeadIdentity) {
  requireTenantId(identity.tenantId);

  return db
    .select({
      instantlyLeadId: outreachSends.instantlyLeadId,
      instantlyCampaignId: outreachSends.instantlyCampaignId,
    })
    .from(outreachSends)
    .where(
      and(
        eq(outreachSends.tenantId, identity.tenantId),
        eq(outreachSends.leadId, identity.leadId),
        isNotNull(outreachSends.instantlyLeadId),
      ),
    )
    .orderBy(desc(outreachSends.sentAt), desc(outreachSends.createdAt), desc(outreachSends.id))
    .limit(1);
}

export function buildLatestInstantlyReplyMetadataQuery(db: DashboardDb, identity: LeadIdentity) {
  requireTenantId(identity.tenantId);

  return db
    .select({
      instantlyEmailId: conversations.instantlyEmailId,
      instantlyAccountId: conversations.instantlyAccountId,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, identity.tenantId),
        eq(conversations.leadId, identity.leadId),
        eq(conversations.direction, "inbound"),
        isNotNull(conversations.instantlyEmailId),
        isNotNull(conversations.instantlyAccountId),
      ),
    )
    .orderBy(desc(conversations.createdAt), desc(conversations.id))
    .limit(1);
}

export function buildDeleteOperatorNoteQuery(db: DashboardDb, input: DeleteOperatorNoteInput) {
  requireTenantId(input.tenantId);

  return db
    .delete(conversations)
    .where(
      and(
        eq(conversations.tenantId, input.tenantId),
        eq(conversations.leadId, input.leadId),
        eq(conversations.id, input.conversationId),
        eq(conversations.direction, "note"),
        eq(conversations.operatorOverride, true),
      ),
    )
    .returning({ id: conversations.id });
}


export function buildPipelineStatusCountsQuery(db: DashboardDb, identity: { tenantId: string }) {
  requireTenantId(identity.tenantId);

  return db
    .select({
      status: leads.status,
      count: sql<string>`count(*)`,
    })
    .from(leads)
    .where(and(eq(leads.tenantId, identity.tenantId), eq(leads.isDeleted, false)))
    .groupBy(leads.status);
}

/**
 * The funnel cohort queries. Each one counts the leads that ever reached a
 * stage from evidence rows that are not removed when the lead advances, which
 * is what makes the ratios between them real. `leads.status` cannot do this:
 * it is one mutually exclusive current state that only moves forward.
 *
 * Every cohort joins back to `leads` so a soft-deleted lead is excluded from
 * the numerator as well as from the imported denominator. Without that join a
 * cohort could exceed the imported total.
 */
export function buildPipelineImportedCountQuery(db: DashboardDb, identity: { tenantId: string }) {
  requireTenantId(identity.tenantId);

  return db
    .select({ count: sql<string>`count(*)` })
    .from(leads)
    .where(and(eq(leads.tenantId, identity.tenantId), eq(leads.isDeleted, false)));
}

export function buildPipelineEnrichedCountQuery(db: DashboardDb, identity: { tenantId: string }) {
  requireTenantId(identity.tenantId);

  return db
    .select({ count: sql<string>`count(distinct ${enrichments.leadId})` })
    .from(enrichments)
    .innerJoin(leads, eq(leads.id, enrichments.leadId))
    .where(
      and(
        eq(enrichments.tenantId, identity.tenantId),
        eq(leads.tenantId, identity.tenantId),
        eq(leads.isDeleted, false),
      ),
    );
}

/**
 * Scoring coverage. `qualifications` holds a row for every lead the qualifier
 * looked at, whether it passed or failed, so this counts leads that were
 * scored and says nothing about whether they qualified.
 */
export function buildPipelineScoredCountQuery(db: DashboardDb, identity: { tenantId: string }) {
  requireTenantId(identity.tenantId);

  return db
    .select({ count: sql<string>`count(distinct ${qualifications.leadId})` })
    .from(qualifications)
    .innerJoin(leads, eq(leads.id, qualifications.leadId))
    .where(
      and(
        eq(qualifications.tenantId, identity.tenantId),
        eq(leads.tenantId, identity.tenantId),
        eq(leads.isDeleted, false),
      ),
    );
}

/**
 * The leads that actually qualified. The pass or fail decision is not stored:
 * `qualify.py` compares `score` against the `score_threshold` in the job
 * payload and archives the lead when it falls short, so the only way to name
 * the passing cohort is to apply the same threshold here. The threshold is a
 * required argument rather than a default, because a default would invent the
 * figure the pass rate is entirely made of.
 */
export function buildPipelineQualifiedCountQuery(
  db: DashboardDb,
  identity: { tenantId: string; scoreThreshold: number },
) {
  requireTenantId(identity.tenantId);

  return db
    .select({ count: sql<string>`count(distinct ${qualifications.leadId})` })
    .from(qualifications)
    .innerJoin(leads, eq(leads.id, qualifications.leadId))
    .where(
      and(
        eq(qualifications.tenantId, identity.tenantId),
        gte(qualifications.score, identity.scoreThreshold),
        eq(leads.tenantId, identity.tenantId),
        eq(leads.isDeleted, false),
      ),
    );
}

export function buildPipelineContactedCountQuery(db: DashboardDb, identity: { tenantId: string }) {
  requireTenantId(identity.tenantId);

  return db
    .select({ count: sql<string>`count(distinct ${outreachSends.leadId})` })
    .from(outreachSends)
    .innerJoin(leads, eq(leads.id, outreachSends.leadId))
    .where(
      and(
        eq(outreachSends.tenantId, identity.tenantId),
        eq(leads.tenantId, identity.tenantId),
        eq(leads.isDeleted, false),
      ),
    );
}

/**
 * The part of the contacted cohort that also met the threshold, and the
 * numerator of the qualified to contacted step. On the live tenant 1,960 leads
 * were contacted but only 1,955 of them met the current threshold, because 5
 * were contacted when the threshold was lower. Dividing the full contacted
 * count by the passing cohort would put those 5 in a numerator whose
 * denominator excludes them.
 */
export function buildPipelineContactedQualifiedCountQuery(
  db: DashboardDb,
  identity: { tenantId: string; scoreThreshold: number },
) {
  requireTenantId(identity.tenantId);

  return db
    .select({ count: sql<string>`count(distinct ${outreachSends.leadId})` })
    .from(outreachSends)
    .innerJoin(leads, eq(leads.id, outreachSends.leadId))
    .innerJoin(qualifications, eq(qualifications.leadId, outreachSends.leadId))
    .where(
      and(
        eq(outreachSends.tenantId, identity.tenantId),
        eq(qualifications.tenantId, identity.tenantId),
        gte(qualifications.score, identity.scoreThreshold),
        eq(leads.tenantId, identity.tenantId),
        eq(leads.isDeleted, false),
      ),
    );
}

/**
 * The two cohorts that cannot be counted without the passing score, or null
 * when there is no passing score to count them by.
 *
 * The decision lives here rather than in `getPipelineAnalytics` so it is
 * testable. Falling back to a threshold of 0 would build a predicate that
 * every scored lead satisfies, which reports the whole scored population as
 * qualified: the exact reading this stage was corrected for.
 */
export function buildPipelineThresholdCohortQueries(
  db: DashboardDb,
  identity: { tenantId: string },
  threshold: MetricAvailability<number>,
) {
  requireTenantId(identity.tenantId);

  if (!threshold.available) {
    return null;
  }

  const scoped = { tenantId: identity.tenantId, scoreThreshold: threshold.value };

  return {
    qualified: buildPipelineQualifiedCountQuery(db, scoped),
    contactedQualified: buildPipelineContactedQualifiedCountQuery(db, scoped),
  };
}

export function buildPipelineRepliedCountQuery(db: DashboardDb, identity: { tenantId: string }) {
  requireTenantId(identity.tenantId);

  return db
    .select({ count: sql<string>`count(distinct ${conversations.leadId})` })
    .from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .where(
      and(
        eq(conversations.tenantId, identity.tenantId),
        eq(conversations.direction, "inbound"),
        eq(leads.tenantId, identity.tenantId),
        eq(leads.isDeleted, false),
      ),
    );
}

/**
 * The paid cohort behind the funnel. Same table, same status and the same
 * non-deleted lead join as the Paid pill on `/leads`, so the two screens report
 * one figure. The status literal comes from `@/lib/paid-payments` rather than
 * being written here twice.
 */
export function buildPipelinePaidCountQuery(db: DashboardDb, identity: { tenantId: string }) {
  requireTenantId(identity.tenantId);

  return db
    .select({ count: sql<string>`count(distinct ${payments.leadId})` })
    .from(payments)
    .innerJoin(leads, eq(leads.id, payments.leadId))
    .where(
      and(
        eq(payments.tenantId, identity.tenantId),
        eq(payments.status, PAID_PAYMENT_STATUS),
        eq(leads.tenantId, identity.tenantId),
        eq(leads.isDeleted, false),
      ),
    );
}

export function buildRevenuePaymentsSummaryQuery(
  db: DashboardDb,
  identity: { tenantId: string; periodStart: Date },
) {
  requireTenantId(identity.tenantId);

  return db
    .select({
      paidCount: sql<string>`count(*)`,
      totalRevenueAud: sql<string>`coalesce(sum(${payments.amountAud}), 0)`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.tenantId, identity.tenantId),
        eq(payments.status, "paid"),
        gte(payments.paidAt, identity.periodStart),
      ),
    );
}

export function buildCreateDiscoveryRunQuery(
  db: DashboardDb,
  input: CreateDiscoveryRunInput,
) {
  requireTenantId(input.tenantId);

  return db
    .insert(discoveryRuns)
    .values({
      tenantId: input.tenantId,
      source: "outscraper",
      querySpec: input.querySpec,
      status: "created",
      shadowMode: true,
    })
    .returning();
}

export function buildLatestDiscoveryRunQuery(
  db: DashboardDb,
  identity: { tenantId: string },
) {
  requireTenantId(identity.tenantId);

  return db
    .select()
    .from(discoveryRuns)
    .where(eq(discoveryRuns.tenantId, identity.tenantId))
    .orderBy(desc(discoveryRuns.createdAt))
    .limit(1);
}

export function buildListProspectEvidenceForRunQuery(
  db: DashboardDb,
  identity: { tenantId: string; discoveryRunId: string },
) {
  requireTenantId(identity.tenantId);

  return db
    .select({
      id: businessProspects.id,
      businessName: businessProspects.businessName,
      route: businessProspects.route,
      status: businessProspects.status,
      validationSample: businessProspects.validationSample,
      validationCohort: businessProspects.validationCohort,
      websiteOwnership: businessProspects.websiteOwnership,
      outcomeReason: businessProspects.outcomeReason,
      sourceWebsiteUrl: businessProspects.sourceWebsiteUrl,
      normalizedDomain: businessProspects.normalizedDomain,
      matchedLocationCount: businessProspects.matchedLocationCount,
      duplicateEvidence: businessProspects.duplicateEvidence,
      ruleEvidence: prospectAssessments.ruleEvidence,
      totalScore: prospectAssessments.totalScore,
      categoryScores: prospectAssessments.categoryScores,
      forcedRouteReason: prospectAssessments.forcedRouteReason,
      contactStatus: prospectContacts.status,
      contactPersonName: prospectContacts.personName,
      contactPersonTitle: prospectContacts.personTitle,
      contactEmail: prospectContacts.email,
      contactEmailStatus: prospectContacts.providerEmailStatus,
      contactEvidence: prospectContacts.matchEvidence,
      reviewDecision: sql<string | null>`(
        SELECT latest_prospect_assessments.review_decision
        FROM prospect_assessments latest_prospect_assessments
        WHERE latest_prospect_assessments.tenant_id = ${identity.tenantId}
          AND latest_prospect_assessments.discovery_run_id = ${businessProspects.discoveryRunId}
          AND latest_prospect_assessments.prospect_id = ${businessProspects.id}
          AND latest_prospect_assessments.assessment_type = 'manual_review'
        ORDER BY latest_prospect_assessments.created_at DESC,
                 latest_prospect_assessments.id DESC
        LIMIT 1
      )`,
      correctedRoute: sql<string | null>`(
        SELECT latest_prospect_assessments.corrected_route
        FROM prospect_assessments latest_prospect_assessments
        WHERE latest_prospect_assessments.tenant_id = ${identity.tenantId}
          AND latest_prospect_assessments.discovery_run_id = ${businessProspects.discoveryRunId}
          AND latest_prospect_assessments.prospect_id = ${businessProspects.id}
          AND latest_prospect_assessments.assessment_type = 'manual_review'
        ORDER BY latest_prospect_assessments.created_at DESC,
                 latest_prospect_assessments.id DESC
        LIMIT 1
      )`,
      reviewNote: sql<string | null>`(
        SELECT latest_prospect_assessments.review_note
        FROM prospect_assessments latest_prospect_assessments
        WHERE latest_prospect_assessments.tenant_id = ${identity.tenantId}
          AND latest_prospect_assessments.discovery_run_id = ${businessProspects.discoveryRunId}
          AND latest_prospect_assessments.prospect_id = ${businessProspects.id}
          AND latest_prospect_assessments.assessment_type = 'manual_review'
        ORDER BY latest_prospect_assessments.created_at DESC,
                 latest_prospect_assessments.id DESC
        LIMIT 1
      )`,
      reviewedAt: sql<Date | string | null>`(
        SELECT latest_prospect_assessments.created_at
        FROM prospect_assessments latest_prospect_assessments
        WHERE latest_prospect_assessments.tenant_id = ${identity.tenantId}
          AND latest_prospect_assessments.discovery_run_id = ${businessProspects.discoveryRunId}
          AND latest_prospect_assessments.prospect_id = ${businessProspects.id}
          AND latest_prospect_assessments.assessment_type = 'manual_review'
        ORDER BY latest_prospect_assessments.created_at DESC,
                 latest_prospect_assessments.id DESC
        LIMIT 1
      )`,
    })
    .from(businessProspects)
    .leftJoin(
      prospectAssessments,
      and(
        eq(prospectAssessments.tenantId, identity.tenantId),
        eq(prospectAssessments.discoveryRunId, businessProspects.discoveryRunId),
        eq(prospectAssessments.prospectId, businessProspects.id),
        eq(prospectAssessments.assessmentType, "automated"),
        sql`${prospectAssessments.assessmentVersion} = CASE
          WHEN ${businessProspects.route} IN ('B', 'manual_review', 'healthy')
          THEN ${WEBSITE_HEALTH_ASSESSMENT_VERSION}
          ELSE ${ROUTE_A_ASSESSMENT_VERSION}
        END`,
      ),
    )
    .leftJoin(
      prospectContacts,
      and(
        eq(prospectContacts.tenantId, identity.tenantId),
        eq(prospectContacts.prospectId, businessProspects.id),
        eq(prospectContacts.provider, "apollo"),
        sql`${prospectContacts.createdAt} = (
          SELECT MAX(latest_prospect_contacts.created_at)
          FROM prospect_contacts latest_prospect_contacts
          WHERE latest_prospect_contacts.tenant_id = ${identity.tenantId}
            AND latest_prospect_contacts.prospect_id = ${businessProspects.id}
            AND latest_prospect_contacts.provider = 'apollo'
        )`,
      ),
    )
    .where(
      and(
        eq(businessProspects.tenantId, identity.tenantId),
        eq(businessProspects.discoveryRunId, identity.discoveryRunId),
      ),
    )
    .orderBy(asc(businessProspects.businessName), asc(businessProspects.id));
}

export function buildInsertManualProspectReviewQuery(
  db: DashboardDb,
  input: ManualProspectReviewInput,
) {
  requireTenantId(input.tenantId);

  return db.execute<{
    id: string;
    prospectId: string;
    reviewDecision: string;
    correctedRoute: string | null;
    reviewNote: string | null;
    createdAt: Date | string;
  }>(sql`
    WITH target AS (
      SELECT
        ${businessProspects.tenantId} AS tenant_id,
        ${businessProspects.discoveryRunId} AS discovery_run_id,
        ${businessProspects.id} AS prospect_id,
        ${businessProspects.route} AS route
      FROM ${businessProspects}
      INNER JOIN ${discoveryRuns}
        ON ${discoveryRuns.tenantId} = ${businessProspects.tenantId}
       AND ${discoveryRuns.id} = ${businessProspects.discoveryRunId}
       AND ${discoveryRuns.status} = 'review_ready'
      WHERE ${businessProspects.tenantId} = ${input.tenantId}
        AND ${businessProspects.discoveryRunId} = ${input.discoveryRunId}
        AND ${businessProspects.id} = ${input.prospectId}
        AND ${businessProspects.validationSample} = TRUE
    ),
    automated AS (
      SELECT
        ${prospectAssessments.totalScore} AS total_score,
        ${prospectAssessments.categoryScores} AS category_scores,
        ${prospectAssessments.ruleEvidence} AS rule_evidence
      FROM ${prospectAssessments}
      INNER JOIN target
        ON target.tenant_id = ${prospectAssessments.tenantId}
       AND target.discovery_run_id = ${prospectAssessments.discoveryRunId}
       AND target.prospect_id = ${prospectAssessments.prospectId}
      WHERE ${prospectAssessments.assessmentType} = 'automated'
      ORDER BY ${prospectAssessments.createdAt} DESC,
               ${prospectAssessments.id} DESC
      LIMIT 1
    ),
    inserted AS (
      INSERT INTO ${prospectAssessments} (
        ${prospectAssessments.tenantId},
        ${prospectAssessments.discoveryRunId},
        ${prospectAssessments.prospectId},
        ${prospectAssessments.assessmentType},
        ${prospectAssessments.assessmentVersion},
        ${prospectAssessments.eligible},
        ${prospectAssessments.computedRoute},
        ${prospectAssessments.totalScore},
        ${prospectAssessments.categoryScores},
        ${prospectAssessments.ruleEvidence},
        ${prospectAssessments.reviewerId},
        ${prospectAssessments.idempotencyKey},
        ${prospectAssessments.reviewDecision},
        ${prospectAssessments.correctedRoute},
        ${prospectAssessments.reviewNote}
      )
      SELECT
        target.tenant_id,
        target.discovery_run_id,
        target.prospect_id,
        'manual_review',
        'manual-review-v1',
        CASE
          WHEN ${input.decision} = 'ineligible' THEN FALSE
          WHEN ${input.decision} = 'needs_investigation' THEN NULL
          ELSE TRUE
        END,
        target.route,
        automated.total_score,
        COALESCE(automated.category_scores, '{}'::jsonb),
        COALESCE(automated.rule_evidence, '{}'::jsonb),
        ${input.reviewerId},
        ${input.idempotencyKey},
        ${input.decision},
        ${input.correctedRoute ?? null},
        ${input.note ?? null}
      FROM target
      LEFT JOIN automated ON TRUE
      ON CONFLICT (tenant_id, prospect_id, idempotency_key)
      WHERE assessment_type = 'manual_review'
      DO NOTHING
      RETURNING
        ${prospectAssessments.id} AS "id",
        ${prospectAssessments.prospectId} AS "prospectId",
        ${prospectAssessments.reviewDecision} AS "reviewDecision",
        ${prospectAssessments.correctedRoute} AS "correctedRoute",
        ${prospectAssessments.reviewNote} AS "reviewNote",
        ${prospectAssessments.createdAt} AS "createdAt"
    )
    SELECT * FROM inserted
    UNION ALL
    SELECT
      existing.id AS "id",
      existing.prospect_id AS "prospectId",
      existing.review_decision AS "reviewDecision",
      existing.corrected_route AS "correctedRoute",
      existing.review_note AS "reviewNote",
      existing.created_at AS "createdAt"
    FROM prospect_assessments existing
    INNER JOIN target
      ON target.tenant_id = existing.tenant_id
     AND target.discovery_run_id = existing.discovery_run_id
     AND target.prospect_id = existing.prospect_id
    WHERE existing.tenant_id = ${input.tenantId}
      AND existing.prospect_id = ${input.prospectId}
      AND existing.idempotency_key = ${input.idempotencyKey}
      AND existing.assessment_type = 'manual_review'
    LIMIT 1
  `);
}

export function buildProspectReviewMetricsQuery(
  db: DashboardDb,
  identity: { tenantId: string; discoveryRunId: string },
) {
  requireTenantId(identity.tenantId);

  return db.execute<ProspectReviewMetrics>(sql`
    WITH run AS (
      SELECT *
      FROM ${discoveryRuns}
      WHERE ${discoveryRuns.tenantId} = ${identity.tenantId}
        AND ${discoveryRuns.id} = ${identity.discoveryRunId}
    ),
    sample AS (
      SELECT
        ${businessProspects.id},
        ${businessProspects.validationCohort},
        latest_manual_assessment.review_decision
      FROM ${businessProspects}
      LEFT JOIN LATERAL (
        SELECT review_decision
        FROM prospect_assessments
        WHERE tenant_id = ${identity.tenantId}
          AND discovery_run_id = ${businessProspects.discoveryRunId}
          AND prospect_id = ${businessProspects.id}
          AND assessment_type = 'manual_review'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) latest_manual_assessment ON TRUE
      WHERE ${businessProspects.tenantId} = ${identity.tenantId}
        AND ${businessProspects.discoveryRunId} = ${identity.discoveryRunId}
        AND ${businessProspects.validationSample} = TRUE
    ),
    prospect_counts AS (
      SELECT
        COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed_count
      FROM ${businessProspects}
      WHERE ${businessProspects.tenantId} = ${identity.tenantId}
        AND ${businessProspects.discoveryRunId} = ${identity.discoveryRunId}
    ),
    verified_by_route AS (
      SELECT
        COUNT(DISTINCT ${prospectContacts.prospectId}) FILTER (
          WHERE ${businessProspects.route} = 'A'
        )::integer AS route_a_verified_contact_count,
        COUNT(DISTINCT ${prospectContacts.prospectId}) FILTER (
          WHERE ${businessProspects.route} = 'B'
        )::integer AS route_b_verified_contact_count
      FROM ${prospectContacts}
      INNER JOIN ${businessProspects}
        ON ${businessProspects.tenantId} = ${prospectContacts.tenantId}
       AND ${businessProspects.id} = ${prospectContacts.prospectId}
      WHERE ${prospectContacts.tenantId} = ${identity.tenantId}
        AND ${businessProspects.discoveryRunId} = ${identity.discoveryRunId}
        AND ${prospectContacts.status} = 'verified'
    )
    SELECT
      COUNT(sample.id)::integer AS "sampleCount",
      COUNT(sample.id) FILTER (WHERE sample.validation_cohort = 'A')::integer AS "routeASampleCount",
      COUNT(sample.id) FILTER (WHERE sample.validation_cohort = 'B')::integer AS "routeBSampleCount",
      COUNT(sample.id) FILTER (WHERE sample.validation_cohort = 'healthy_rejected')::integer AS "healthyRejectedSampleCount",
      COUNT(sample.id) FILTER (WHERE sample.review_decision IS NOT NULL)::integer AS "reviewedCount",
      COUNT(sample.id) FILTER (
        WHERE sample.review_decision IN ('correct', 'wrong_route', 'ineligible')
      )::integer AS "decisiveReviewCount",
      COUNT(sample.id) FILTER (WHERE sample.review_decision IS NULL)::integer AS "missingReviewCount",
      COUNT(sample.id) FILTER (WHERE sample.review_decision = 'needs_investigation')::integer AS "needsInvestigationCount",
      CASE
        WHEN COUNT(sample.id) FILTER (
          WHERE sample.review_decision IN ('correct', 'wrong_route', 'ineligible')
        ) = 0 THEN NULL
        ELSE (
          COUNT(sample.id) FILTER (WHERE sample.review_decision IN ('correct', 'wrong_route'))::numeric
          / COUNT(sample.id) FILTER (
            WHERE sample.review_decision IN ('correct', 'wrong_route', 'ineligible')
          )
        )
      END AS "eligibilityPrecision",
      CASE
        WHEN COUNT(sample.id) FILTER (
          WHERE sample.review_decision IN ('correct', 'wrong_route')
        ) = 0 THEN NULL
        ELSE (
          COUNT(sample.id) FILTER (WHERE sample.review_decision = 'correct')::numeric
          / COUNT(sample.id) FILTER (WHERE sample.review_decision IN ('correct', 'wrong_route'))
        )
      END AS "routePrecision",
      CASE WHEN run.discovered_count = 0 THEN NULL ELSE run.usable_count::numeric / run.discovered_count END AS "usableYield",
      CASE WHEN run.discovered_count = 0 THEN NULL ELSE (run.route_a_count + run.route_b_count)::numeric / run.discovered_count END AS "routeableYield",
      CASE WHEN run.discovered_count = 0 THEN NULL ELSE run.route_a_count::numeric / run.discovered_count END AS "routeAYield",
      CASE WHEN run.discovered_count = 0 THEN NULL ELSE run.route_b_count::numeric / run.discovered_count END AS "routeBYield",
      CASE WHEN run.discovered_count = 0 THEN NULL ELSE prospect_counts.failed_count::numeric / run.discovered_count END AS "unexpectedFailureRate",
      run.verified_contact_count::integer AS "verifiedContactCount",
      CASE
        WHEN run.route_a_count = 0 THEN NULL
        ELSE verified_by_route.route_a_verified_contact_count::numeric / run.route_a_count
      END AS "routeAVerifiedEmailMatchRate",
      CASE
        WHEN run.route_b_count = 0 THEN NULL
        ELSE verified_by_route.route_b_verified_contact_count::numeric / run.route_b_count
      END AS "routeBVerifiedEmailMatchRate",
      (run.provider_usage ? 'apollo_contact_match') AS "providerUsagePresent",
      COALESCE(
        (run.provider_usage->'apollo_contact_match'->>'cost_reconciliation_required')::boolean,
        TRUE
      ) AS "costReconciliationRequired"
    FROM run
    CROSS JOIN prospect_counts
    CROSS JOIN verified_by_route
    LEFT JOIN sample ON TRUE
    GROUP BY
      run.discovered_count,
      run.usable_count,
      run.route_a_count,
      run.route_b_count,
      run.verified_contact_count,
      run.provider_usage,
      prospect_counts.failed_count,
      verified_by_route.route_a_verified_contact_count,
      verified_by_route.route_b_verified_contact_count
  `);
}

export function buildProspectReviewExportRowsQuery(
  db: DashboardDb,
  identity: { tenantId: string; discoveryRunId: string },
) {
  requireTenantId(identity.tenantId);

  return db.execute<ProspectReviewExportRow>(sql`
    SELECT
      ${businessProspects.businessName} AS "businessName",
      ${businessProspects.normalizedName} AS "normalizedName",
      ${businessProspects.primaryCategory} AS "primaryCategory",
      ${businessProspects.locality} AS "locality",
      ${businessProspects.state} AS "state",
      ${businessProspects.postcode} AS "postcode",
      ${businessProspects.googleProfileUrl} AS "googleProfileUrl",
      ${businessProspects.sourceWebsiteUrl} AS "sourceWebsiteUrl",
      ${businessProspects.normalizedDomain} AS "normalizedDomain",
      ${businessProspects.route} AS "route",
      ${businessProspects.status} AS "status",
      ${businessProspects.validationCohort} AS "validationCohort",
      ${businessProspects.outcomeReason} AS "outcomeReason",
      automated.total_score AS "totalScore",
      ${prospectContacts.status} AS "contactStatus",
      ${prospectContacts.personName} AS "contactPersonName",
      ${prospectContacts.personTitle} AS "contactPersonTitle",
      ${prospectContacts.email} AS "contactEmail",
      ${prospectContacts.providerEmailStatus} AS "contactEmailStatus",
      manual.review_decision AS "reviewDecision",
      manual.corrected_route AS "correctedRoute",
      manual.review_note AS "reviewNote",
      manual.created_at AS "reviewedAt",
      ${businessProspects.createdAt} AS "prospectCreatedAt",
      ${businessProspects.updatedAt} AS "prospectUpdatedAt"
    FROM ${businessProspects}
    LEFT JOIN LATERAL (
      SELECT total_score
      FROM prospect_assessments
      WHERE tenant_id = ${identity.tenantId}
        AND discovery_run_id = ${businessProspects.discoveryRunId}
        AND prospect_id = ${businessProspects.id}
        AND assessment_type = 'automated'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) automated ON TRUE
    LEFT JOIN LATERAL (
      SELECT review_decision, corrected_route, review_note, created_at
      FROM prospect_assessments
      WHERE tenant_id = ${identity.tenantId}
        AND discovery_run_id = ${businessProspects.discoveryRunId}
        AND prospect_id = ${businessProspects.id}
        AND assessment_type = 'manual_review'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) manual ON TRUE
    LEFT JOIN ${prospectContacts}
      ON ${prospectContacts.tenantId} = ${identity.tenantId}
     AND ${prospectContacts.prospectId} = ${businessProspects.id}
     AND ${prospectContacts.provider} = 'apollo'
     AND ${prospectContacts.createdAt} = (
       SELECT MAX(latest_prospect_contacts.created_at)
       FROM prospect_contacts latest_prospect_contacts
       WHERE latest_prospect_contacts.tenant_id = ${identity.tenantId}
         AND latest_prospect_contacts.prospect_id = ${businessProspects.id}
         AND latest_prospect_contacts.provider = 'apollo'
     )
    WHERE ${businessProspects.tenantId} = ${identity.tenantId}
      AND ${businessProspects.discoveryRunId} = ${identity.discoveryRunId}
      AND ${businessProspects.validationSample} = TRUE
    ORDER BY ${businessProspects.validationCohort}, ${businessProspects.businessName}, ${businessProspects.id}
  `);
}

export function buildFailStaleActiveDiscoveryRunsQuery(
  db: DashboardDb,
  input: FailStaleActiveDiscoveryRunsInput,
) {
  requireTenantId(input.tenantId);
  const processingStaleBeforeIso = input.processingStaleBefore.toISOString();

  return db
    .update(discoveryRuns)
    .set({
      status: "failed",
      failureCode: "discovery_run_stale_active",
      failureDetail: "Discovery run did not advance before the recovery deadline.",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(discoveryRuns.tenantId, input.tenantId),
        or(
          and(
            inArray(discoveryRuns.status, ["created", "submitted", "polling"]),
            lte(discoveryRuns.updatedAt, input.staleBefore),
          ),
          and(
            eq(discoveryRuns.status, "processing"),
            lte(discoveryRuns.updatedAt, input.processingStaleBefore),
            sql`NOT EXISTS (
              SELECT 1
              FROM queue_jobs active_prospect_jobs
              WHERE active_prospect_jobs.tenant_id = ${discoveryRuns.tenantId}
                AND active_prospect_jobs.status = 'active'
                AND active_prospect_jobs.job_type IN (${sql.join(
                  ACTIVE_PROSPECT_DISCOVERY_JOB_TYPES.map((jobType) => sql`${jobType}`),
                  sql`, `,
                )})
                AND active_prospect_jobs.started_at > ${processingStaleBeforeIso}
                AND active_prospect_jobs.payload->>'discovery_run_id' = ${discoveryRuns.id}::text
            )`,
          ),
        ),
      ),
    )
    .returning();
}

export function buildMarkDiscoveryRunFailedQuery(
  db: DashboardDb,
  input: MarkDiscoveryRunFailedInput,
) {
  requireTenantId(input.tenantId);

  return db
    .update(discoveryRuns)
    .set({
      status: "failed",
      failureCode: input.failureCode,
      failureDetail: "Discovery run could not be queued.",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(discoveryRuns.tenantId, input.tenantId),
        eq(discoveryRuns.id, input.discoveryRunId),
        eq(discoveryRuns.status, "created"),
      ),
    )
    .returning();
}

export function buildRevenueImportedCountQuery(
  db: DashboardDb,
  identity: { tenantId: string; periodStart: Date },
) {
  requireTenantId(identity.tenantId);

  return db
    .select({
      importedCount: sql<string>`count(*)`,
    })
    .from(leads)
    .where(
      and(
        eq(leads.tenantId, identity.tenantId),
        eq(leads.isDeleted, false),
        gte(leads.importedAt, identity.periodStart),
      ),
    );
}

export function buildAiCostByModelQuery(
  db: DashboardDb,
  identity: { tenantId: string; periodStart: Date },
) {
  requireTenantId(identity.tenantId);

  return db
    .select({
      modelHaiku: qualifications.modelHaiku,
      modelSonnet: qualifications.modelSonnet,
      promptVersion: qualifications.promptVersion,
      calls: sql<string>`count(*)`,
      costUsd: sql<string>`coalesce(sum(${qualifications.costUsd}), 0)`,
    })
    .from(qualifications)
    .where(
      and(
        eq(qualifications.tenantId, identity.tenantId),
        gte(qualifications.qualifiedAt, identity.periodStart),
      ),
    )
    .groupBy(qualifications.modelHaiku, qualifications.modelSonnet, qualifications.promptVersion);
}

export function buildTodayReplyCountQuery(
  db: DashboardDb,
  identity: { tenantId: string; dayStart: Date; dayEnd: Date },
) {
  requireTenantId(identity.tenantId);

  return db
    .select({
      replyCount: sql<string>`count(*)`,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, identity.tenantId),
        eq(conversations.direction, "inbound"),
        gte(conversations.createdAt, identity.dayStart),
        lt(conversations.createdAt, identity.dayEnd),
      ),
    );
}

/**
 * Unsubscribes today, dated by the unsubscribe itself.
 *
 * `unsubscribed_at` is written by the reply agent's suppression CTE and was
 * added by migration `0014_add_suppression_event_times.sql`. Before it, this
 * query filtered on `updated_at`, the row's last write, which made the tile's
 * rate a ratio between two different cohorts: a lead suppressed today may have
 * been sent to last week, so it counted against today's send count.
 *
 * `undatedUnsubscribeCount` is the rows that were flagged before the column
 * existed and whose `updated_at` falls in today's window. They are exactly the
 * rows the old query counted and this one cannot date. They are reported rather
 * than dropped, and `normalizeTodaySoFar` turns a non-zero tally into the
 * reason printed under the tile, so a missing figure is words on the page
 * instead of a silently smaller number. Once every suppression carries its own
 * time this tally is zero and the caveat clears itself.
 *
 * Bounces are deliberately not counted here. `bounced_at` exists now, but the
 * bounce boolean is only as complete as the webhook deliveries, and the today
 * bar reads bounces from Instantly instead: see `today-sends.ts`.
 *
 * Scoped to suppressed rows rather than to a time window, so the two tallies
 * can be counted in one pass without scanning every send the tenant has ever
 * made.
 */
export function buildTodayUnsubscribeCountQuery(
  db: DashboardDb,
  identity: { tenantId: string; dayStart: Date; dayEnd: Date },
) {
  requireTenantId(identity.tenantId);

  return db
    .select({
      unsubscribeCount: sql<string>`count(*) filter (
        where ${outreachSends.unsubscribedAt} >= ${identity.dayStart}
          and ${outreachSends.unsubscribedAt} < ${identity.dayEnd}
      )`.as("unsubscribe_count"),
      undatedUnsubscribeCount: sql<string>`count(*) filter (
        where ${outreachSends.unsubscribedAt} is null
          and ${outreachSends.updatedAt} >= ${identity.dayStart}
          and ${outreachSends.updatedAt} < ${identity.dayEnd}
      )`.as("undated_unsubscribe_count"),
    })
    .from(outreachSends)
    .where(
      and(
        eq(outreachSends.tenantId, identity.tenantId),
        eq(outreachSends.unsubscribed, true),
      ),
    );
}

/** No sends today is a different answer from no send count today, and both are stated. */
const NO_SENDS_TODAY = "no sends today";
const NO_SEND_COUNT =
  "no rate without today's send count from Instantly";

/**
 * A rate is only reported when the count and the send count it divides by both
 * came back. Dividing a real count by a stale or assumed denominator would
 * print a confident percentage that no data supports.
 */
function rateAgainstSent(
  count: MetricAvailability<number>,
  sent: MetricAvailability<number>,
): MetricAvailability<number> {
  if (!count.available) {
    return { available: false, reason: count.reason };
  }
  if (!sent.available) {
    return { available: false, reason: NO_SEND_COUNT };
  }
  if (sent.value === 0) {
    return { available: false, reason: NO_SENDS_TODAY };
  }

  return { available: true, value: (count.value / sent.value) * 100 };
}

function toneForRate(rate: MetricAvailability<number>, warnAbove: number): TodayMetricTone {
  return rate.available && rate.value > warnAbove ? "warning" : "neutral";
}

/**
 * Rows flagged unsubscribed before `unsubscribed_at` existed cannot be dated,
 * so today's count is incomplete by exactly that many and the rate would be
 * confidently low. The tile prints this in place of the percentage, which is
 * how every other unmeasured figure on this dashboard behaves.
 */
function undatedUnsubscribeReason(undated: number) {
  return `${undated.toLocaleString()} ${undated === 1 ? "unsubscribe was" : "unsubscribes were"} recorded today without an event time, so this rate would read low`;
}

export function normalizeTodaySoFar(counts: TodaySoFarCounts): TodaySoFarSummary {
  const sent = counts.sent;
  const bounces = counts.bounces;
  const replies = toNumber(counts.replies);
  const unsubscribes = toNumber(counts.unsubscribes);
  const unsubscribesUndated = toNumber(counts.unsubscribesUndated ?? 0);

  const bounceRate = rateAgainstSent(bounces, sent);
  const unsubscribeRate =
    unsubscribesUndated > 0
      ? { available: false as const, reason: undatedUnsubscribeReason(unsubscribesUndated) }
      : rateAgainstSent({ available: true, value: unsubscribes }, sent);

  /**
   * A missing send count keeps the tiles on screen. Falling back to the quiet
   * day note would hide an Instantly outage behind "nothing went out today",
   * which is the confusion this bar was reporting in the first place.
   *
   * Only the send count is read for this, deliberately. The bounce count is
   * unavailable by construction rather than by failure: Instantly publishes
   * bounces only summed into a UTC calendar day, and a UTC day cannot be cut at
   * Sydney midnight. Letting that force the tiles open would mean a genuinely
   * quiet day never reached the quiet day note again.
   */
  const sendCountUnavailable = !sent.available;
  const countedActivity =
    (sent.available ? sent.value : 0) +
    (bounces.available ? bounces.value : 0) +
    replies +
    unsubscribes +
    // An undated suppression is still something that happened. Leaving it out
    // would let a day with nothing but old flagged rows fall through to the
    // quiet day note, which is the same hiding this change is undoing.
    unsubscribesUndated;

  return {
    dayLabel: counts.dayLabel,
    sent,
    opens: null,
    opensTracked: false,
    replies,
    bounces,
    unsubscribes,
    unsubscribesUndated,
    replyRate: rateAgainstSent({ available: true, value: replies }, sent),
    bounceRate,
    unsubscribeRate,
    bounceTone: toneForRate(bounceRate, BOUNCE_RATE_WARNING_PERCENT),
    unsubscribeTone: toneForRate(unsubscribeRate, UNSUBSCRIBE_RATE_WARNING_PERCENT),
    anySent: sent.available && sent.value > 0,
    hasActivity: sendCountUnavailable || countedActivity > 0,
  };
}

/**
 * `sendTotals` is passed in rather than fetched here: this module owns database
 * access, and today's sends and bounces are read from Instantly by the caller.
 */
export async function getTodaySoFarSummary(identity: {
  tenantId: string;
  sendTotals: TodaySendTotals;
  now?: Date;
}) {
  requireTenantId(identity.tenantId);

  const db = getDb();
  const now = identity.now ?? new Date();
  const { start: dayStart, end: dayEnd } = getSydneyDayRange(now);
  const window = { tenantId: identity.tenantId, dayStart, dayEnd };

  const [replyRows, unsubscribeRows] = await Promise.all([
    buildTodayReplyCountQuery(db, window),
    buildTodayUnsubscribeCountQuery(db, window),
  ]);

  return normalizeTodaySoFar({
    dayLabel: formatSydneyDayLabel(now),
    sent: identity.sendTotals.sent,
    bounces: identity.sendTotals.bounces,
    replies: replyRows[0]?.replyCount,
    unsubscribes: unsubscribeRows[0]?.unsubscribeCount,
    unsubscribesUndated: unsubscribeRows[0]?.undatedUnsubscribeCount,
  });
}

export async function getLeadList(filters: LeadListFilters) {
  const db = getDb();
  const rows = await buildLeadListQuery(db, filters);
  return addLatestConversationsToLeadRows(db, filters.tenantId, rows);
}

export async function createDiscoveryRun(input: CreateDiscoveryRunInput) {
  const db = getDb();
  const [run] = await buildCreateDiscoveryRunQuery(db, input);
  if (!run) {
    throw new Error("Discovery run insert failed");
  }
  return run;
}

export async function failStaleActiveDiscoveryRuns(input: FailStaleActiveDiscoveryRunsInput) {
  const db = getDb();
  return buildFailStaleActiveDiscoveryRunsQuery(db, input);
}

export async function failStaleActiveDiscoveryRunsForTenant(identity: { tenantId: string }) {
  return failStaleActiveDiscoveryRuns({
    tenantId: identity.tenantId,
    staleBefore: new Date(Date.now() - 10 * 60 * 1000),
    processingStaleBefore: new Date(
      Date.now() - STALE_PROCESSING_DISCOVERY_MINUTES * 60 * 1000,
    ),
  });
}

export async function getLatestDiscoveryRun(identity: string | { tenantId: string }) {
  const tenantId = typeof identity === "string" ? identity : identity.tenantId;
  const db = getDb();
  const [run] = await buildLatestDiscoveryRunQuery(db, { tenantId });
  return run ?? null;
}

export async function listProspectEvidenceForRun(identity: {
  tenantId: string;
  discoveryRunId: string;
}) {
  const db = getDb();
  return buildListProspectEvidenceForRunQuery(db, identity);
}

export async function insertManualProspectReview(input: ManualProspectReviewInput) {
  const db = getDb();
  const rows = await buildInsertManualProspectReviewQuery(db, input);
  const review = rows[0];
  if (!review) {
    throw new Error("Prospect review target not found for tenant/run sample");
  }
  return review;
}

export async function getProspectReviewMetrics(identity: {
  tenantId: string;
  discoveryRunId: string;
}): Promise<ProspectReviewMetrics | null> {
  const db = getDb();
  const rows = await buildProspectReviewMetricsQuery(db, identity);
  const row = rows[0];
  return row ? normalizeProspectReviewMetrics(row) : null;
}

export async function listProspectReviewExportRows(identity: {
  tenantId: string;
  discoveryRunId: string;
}) {
  const db = getDb();
  return buildProspectReviewExportRowsQuery(db, identity);
}

export async function markDiscoveryRunFailed(input: MarkDiscoveryRunFailedInput) {
  const db = getDb();
  const [run] = await buildMarkDiscoveryRunFailedQuery(db, input);
  if (!run) {
    throw new Error("Created discovery run could not be marked failed");
  }
  return run;
}

export async function getLeadListPage(filters: LeadListFilters) {
  const db = getDb();
  const { page, pageSize } = normalizeLeadPagination(filters);
  const totalRows = await buildLeadListCountQuery(db, filters);
  const total = toNumber(totalRows[0]?.total);
  const meta = normalizeLeadListPageMeta({ total, page, pageSize });
  const pageRows = await buildLeadListQuery(db, { ...filters, page: meta.page, pageSize });

  return {
    rows: await addLatestConversationsToLeadRows(db, filters.tenantId, pageRows),
    ...meta,
  };
}

export async function getLeadFilterCounts(identity: { tenantId: string }) {
  const db = getDb();
  return normalizeLeadFilterCounts(await buildLeadFilterCountsQuery(db, identity));
}

async function addLatestConversationsToLeadRows<T extends { id: string; weaknesses: unknown }>(
  db: DashboardDb,
  tenantId: string,
  rows: T[],
) {
  const leadIds = rows.map((row) => row.id);

  if (leadIds.length === 0) {
    return rows.map(normalizeLeadListRow);
  }

  const latestRows = await buildLatestConversationsForLeadsQuery(db, {
    tenantId,
    leadIds,
  });
  const latestByLeadId = new Map<string, LeadLatestConversation>();
  for (const conversation of latestRows) {
    if (!latestByLeadId.has(conversation.leadId)) {
      latestByLeadId.set(conversation.leadId, conversation);
    }
  }

  return rows.map((row) => ({
    ...normalizeLeadListRow(row),
    latestConversation: latestByLeadId.get(row.id) ?? null,
  }));
}

export function normalizeLeadFilterCounts(
  rows: Array<{
    status: string | null;
    count: number | string;
    unsubscribedCount?: number | string | null;
    paidCount?: number | string | null;
    previewSeenCount?: number | string | null;
    previewUnseenCount?: number | string | null;
  }>,
): LeadFilterCounts {
  const counts = new Map(rows.map((row) => [row.status, toNumber(row.count)]));
  const all = rows.reduce((sum, row) => sum + toNumber(row.count), 0);
  const sumColumn = (
    key: "unsubscribedCount" | "paidCount" | "previewSeenCount" | "previewUnseenCount",
  ) => rows.reduce((sum, row) => sum + toNumber(row[key] ?? 0), 0);

  return {
    all,
    qualified: counts.get("qualified") ?? 0,
    contacted: counts.get("contacted") ?? 0,
    replied: counts.get("replied") ?? 0,
    // Not `counts.get("paid")`. A sale is a payments row, and a status without
    // one behind it is not evidence of money.
    paid: sumColumn("paidCount"),
    archived: counts.get("archived") ?? 0,
    unsubscribed: sumColumn("unsubscribedCount"),
    previewSeen: sumColumn("previewSeenCount"),
    previewUnseen: sumColumn("previewUnseenCount"),
  };
}

export async function getPipelineAnalytics(identity: { tenantId: string }) {
  requireTenantId(identity.tenantId);

  const db = getDb();
  const qualificationThreshold = readQualificationScoreThreshold();

  const [statusRows, imported, enriched, scored, contacted, replied, paid] = await Promise.all([
    buildPipelineStatusCountsQuery(db, identity),
    buildPipelineImportedCountQuery(db, identity),
    buildPipelineEnrichedCountQuery(db, identity),
    buildPipelineScoredCountQuery(db, identity),
    buildPipelineContactedCountQuery(db, identity),
    buildPipelineRepliedCountQuery(db, identity),
    buildPipelinePaidCountQuery(db, identity),
  ]);

  /**
   * Without the threshold there is no score predicate to build, so these two
   * cohorts are not queried at all and stay null. The funnel then renders the
   * qualified stage as words rather than as a count that quietly passes every
   * scored lead.
   */
  const thresholdQueries = buildPipelineThresholdCohortQueries(db, identity, qualificationThreshold);
  const [qualified, contactedQualified] =
    thresholdQueries === null
      ? [null, null]
      : await Promise.all([thresholdQueries.qualified, thresholdQueries.contactedQualified]);

  return normalizePipelineAnalytics({
    statusRows,
    qualificationThreshold,
    milestones: {
      imported: imported[0]?.count ?? 0,
      enriched: enriched[0]?.count ?? 0,
      scored: scored[0]?.count ?? 0,
      qualified: qualified === null ? null : (qualified[0]?.count ?? 0),
      contacted: contacted[0]?.count ?? 0,
      contactedQualified: contactedQualified === null ? null : (contactedQualified[0]?.count ?? 0),
      replied: replied[0]?.count ?? 0,
      paid: paid[0]?.count ?? 0,
    },
  });
}

export async function getRevenueAnalytics(identity: { tenantId: string; period: RevenuePeriod }) {
  requireTenantId(identity.tenantId);

  const db = getDb();
  const periodStart = getRevenuePeriodStart(identity.period);
  const [paymentRows, importedRows, aiRows] = await Promise.all([
    buildRevenuePaymentsSummaryQuery(db, { tenantId: identity.tenantId, periodStart }),
    buildRevenueImportedCountQuery(db, { tenantId: identity.tenantId, periodStart }),
    buildAiCostByModelQuery(db, { tenantId: identity.tenantId, periodStart }),
  ]);

  const paymentSummary = paymentRows[0];
  const paidCount = toNumber(paymentSummary?.paidCount);
  const totalRevenueAud = toNumber(paymentSummary?.totalRevenueAud);
  const importedCount = toNumber(importedRows[0]?.importedCount);
  const paidConversionRate = importedCount === 0 ? null : (paidCount / importedCount) * 100;
  const aiCosts = normalizeAiCostRows(aiRows);

  return {
    period: identity.period,
    periodStart,
    totalRevenueAud,
    paidCount,
    importedCount,
    paidConversionRate,
    aiCosts,
    totalAiCostUsd: aiCosts.reduce((sum, row) => sum + row.costUsd, 0),
  };
}

export async function insertOperatorConversation(input: OperatorConversationInput) {
  const db = getDb();
  const [conversation] = await buildInsertOperatorConversationQuery(db, input);
  if (!conversation) {
    throw new Error("Operator conversation insert failed");
  }
  return conversation;
}

export async function updateLeadStatus(input: LeadStatusUpdateInput) {
  const db = getDb();
  const [lead] = await buildUpdateLeadStatusQuery(db, input);
  if (!lead) {
    throw new Error(`Lead ${input.leadId} not found for tenant ${input.tenantId}`);
  }
  return lead;
}

export async function assertLeadStatusTransitionAllowed(input: LeadStatusUpdateInput) {
  const db = getDb();
  const [lead] = await buildLeadStatusTransitionCheckQuery(db, input);
  if (!lead) {
    throw new Error(`Lead ${input.leadId} is not eligible for ${input.status}`);
  }
  return lead;
}

export async function getLatestInstantlyLeadId(identity: LeadIdentity) {
  const db = getDb();
  const [row] = await buildLatestInstantlyLeadIdQuery(db, identity);
  if (!row?.instantlyLeadId) {
    throw new Error("Instantly lead id not found for lead");
  }
  return { instantlyLeadId: row.instantlyLeadId, instantlyCampaignId: row.instantlyCampaignId };
}

export async function getLatestInstantlyReplyMetadata(
  identity: LeadIdentity,
): Promise<InstantlyReplyMetadata> {
  const db = getDb();
  const [row] = await buildLatestInstantlyReplyMetadataQuery(db, identity);
  if (!row?.instantlyEmailId || !row.instantlyAccountId) {
    throw new Error("Instantly reply metadata not found for lead");
  }
  return {
    instantlyEmailId: row.instantlyEmailId,
    instantlyAccountId: row.instantlyAccountId,
  };
}

export async function deleteOperatorNote(input: DeleteOperatorNoteInput) {
  const db = getDb();
  const [deleted] = await buildDeleteOperatorNoteQuery(db, input);
  if (!deleted) {
    throw new Error("Operator note not found for lead");
  }
  return deleted;
}

function normalizeAiCostRows(
  rows: Array<{
    modelHaiku: string;
    modelSonnet: string | null;
    promptVersion: string;
    calls: number | string;
    costUsd: number | string;
  }>,
): AiCostByModel[] {
  return rows
    .flatMap((row) => {
      const family = row.modelSonnet ? "Sonnet" : "Haiku";
      return {
        modelFamily: family as AiCostByModel["modelFamily"],
        modelName: row.modelSonnet ?? row.modelHaiku,
        promptVersion: row.promptVersion,
        calls: toNumber(row.calls),
        costUsd: toNumber(row.costUsd),
      };
    })
    .sort((left, right) => right.costUsd - left.costUsd);
}

function toNullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = toNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeProspectReviewMetrics(row: ProspectReviewMetrics): ProspectReviewMetrics {
  return {
    sampleCount: toNumber(row.sampleCount),
    routeASampleCount: toNumber(row.routeASampleCount),
    routeBSampleCount: toNumber(row.routeBSampleCount),
    healthyRejectedSampleCount: toNumber(row.healthyRejectedSampleCount),
    reviewedCount: toNumber(row.reviewedCount),
    decisiveReviewCount: toNumber(row.decisiveReviewCount),
    missingReviewCount: toNumber(row.missingReviewCount),
    needsInvestigationCount: toNumber(row.needsInvestigationCount),
    eligibilityPrecision: toNullableNumber(row.eligibilityPrecision),
    routePrecision: toNullableNumber(row.routePrecision),
    usableYield: toNullableNumber(row.usableYield),
    routeableYield: toNullableNumber(row.routeableYield),
    routeAYield: toNullableNumber(row.routeAYield),
    routeBYield: toNullableNumber(row.routeBYield),
    unexpectedFailureRate: toNullableNumber(row.unexpectedFailureRate),
    verifiedContactCount: toNumber(row.verifiedContactCount),
    routeAVerifiedEmailMatchRate: toNullableNumber(row.routeAVerifiedEmailMatchRate),
    routeBVerifiedEmailMatchRate: toNullableNumber(row.routeBVerifiedEmailMatchRate),
    providerUsagePresent: row.providerUsagePresent === true,
    costReconciliationRequired: row.costReconciliationRequired !== false,
  };
}

function normalizeLeadListRow<T extends { weaknesses: unknown }>(row: T) {
  return {
    ...row,
    weaknesses: Array.isArray(row.weaknesses)
      ? row.weaknesses.filter((weakness): weakness is string => typeof weakness === "string")
      : [],
    latestConversation: null,
  };
}

export async function getLeadDetail(identity: LeadIdentity) {
  const db = getDb();
  const [leadBundle] = await buildLeadDetailQuery(db, identity);
  if (!leadBundle) {
    return null;
  }

  const [conversationRows, outreachRows, paymentRows, enrichmentRows, qualificationRows] =
    await Promise.all([
      db
        .select()
        .from(conversations)
        .where(and(eq(conversations.tenantId, identity.tenantId), eq(conversations.leadId, identity.leadId)))
        .orderBy(asc(conversations.createdAt)),
      db
        .select()
        .from(outreachSends)
        .where(and(eq(outreachSends.tenantId, identity.tenantId), eq(outreachSends.leadId, identity.leadId)))
        .orderBy(asc(outreachSends.step)),
      db
        .select()
        .from(payments)
        .where(and(eq(payments.tenantId, identity.tenantId), eq(payments.leadId, identity.leadId)))
        .limit(1),
      db
        .select()
        .from(enrichments)
        .where(and(eq(enrichments.tenantId, identity.tenantId), eq(enrichments.leadId, identity.leadId)))
        .limit(1),
      db
        .select()
        .from(qualifications)
        .where(and(eq(qualifications.tenantId, identity.tenantId), eq(qualifications.leadId, identity.leadId)))
        .limit(1),
    ]);

  return {
    ...leadBundle,
    conversations: conversationRows,
    outreachSends: outreachRows,
    payment: paymentRows[0] ?? null,
    enrichment: leadBundle.enrichment ?? enrichmentRows[0] ?? null,
    qualification: leadBundle.qualification ?? qualificationRows[0] ?? null,
    websitePreview: normalizeWebsitePreview(leadBundle.websitePreview),
  };
}

export function normalizeWebsitePreview(preview: {
  templateUsed: string | null;
  previewUrl: string | null;
  personalisationData: unknown;
  promptVersion: string | null;
  costUsd: string | null;
  generatedAt: Date | string | null;
} | null): WebsitePreviewDetail | null {
  if (!preview?.previewUrl || !preview.templateUsed || !preview.promptVersion || !preview.generatedAt) {
    return null;
  }

  return {
    templateUsed: preview.templateUsed,
    previewUrl: preview.previewUrl,
    personalisationData: isRecord(preview.personalisationData) ? preview.personalisationData : {},
    promptVersion: preview.promptVersion,
    costUsd: preview.costUsd ?? "0",
    generatedAt: preview.generatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Reply inbox
//
// Every inbound reply Instantly delivers is persisted by the reply agent as a
// `conversations` row with direction = 'inbound' (see
// services/reply-agent/src/db/queries.ts insertInboundConversation). The
// classification columns (intent, intent_confidence, agent_action, escalated)
// are filled in afterwards by the same worker, so a row can legitimately exist
// with a null intent: the reply landed and Claude has not answered yet, or the
// classification call failed.
//
// There is no read/unread column on `conversations`, and nothing in the
// pipeline writes one, so "unread" cannot be queried. `needs_attention` is the
// honest substitute: unclassified, interested, or escalated.
// ---------------------------------------------------------------------------

export type ReplyInboxFilters = {
  tenantId: string;
  filter?: ReplyInboxFilter;
  page?: number;
  pageSize?: number;
};

export type ReplyInboxRow = {
  id: string;
  leadId: string;
  body: string;
  channel: string;
  intent: string | null;
  intentConfidence: number | null;
  agentAction: string | null;
  escalated: boolean;
  escalationReason: string | null;
  createdAt: Date;
  firstName: string | null;
  lastName: string | null;
  businessName: string | null;
  email: string;
};

export type ReplyInboxFilterCounts = Record<ReplyInboxFilter, number>;

function replyNeedsAttentionCondition() {
  return or(
    isNull(conversations.intent),
    eq(conversations.intent, "interested"),
    eq(conversations.escalated, true),
  );
}

function replyInboxFilterCondition(filter: ReplyInboxFilter) {
  if (filter === "all") return undefined;
  if (filter === "needs_attention") return replyNeedsAttentionCondition();

  return eq(conversations.intent, filter);
}

function buildReplyInboxWhere(filters: ReplyInboxFilters) {
  return [
    eq(conversations.tenantId, filters.tenantId),
    eq(conversations.direction, "inbound"),
    eq(leads.isDeleted, false),
    replyInboxFilterCondition(filters.filter ?? DEFAULT_REPLY_INBOX_FILTER),
  ].filter(Boolean);
}

function joinReplyInboxLead(tenantId: string) {
  return and(eq(leads.id, conversations.leadId), eq(leads.tenantId, tenantId));
}

export function buildReplyInboxQuery(db: DashboardDb, filters: ReplyInboxFilters) {
  requireTenantId(filters.tenantId);

  const { page, pageSize } = normalizeLeadPagination(filters);

  return db
    .select({
      id: conversations.id,
      leadId: conversations.leadId,
      body: conversations.body,
      channel: conversations.channel,
      intent: conversations.intent,
      intentConfidence: conversations.intentConfidence,
      agentAction: conversations.agentAction,
      escalated: conversations.escalated,
      escalationReason: conversations.escalationReason,
      createdAt: conversations.createdAt,
      firstName: leads.firstName,
      lastName: leads.lastName,
      businessName: leads.businessName,
      email: leads.email,
    })
    .from(conversations)
    .innerJoin(leads, joinReplyInboxLead(filters.tenantId))
    .where(and(...buildReplyInboxWhere(filters)))
    .orderBy(desc(conversations.createdAt), desc(conversations.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
}

export function buildReplyInboxCountQuery(db: DashboardDb, filters: ReplyInboxFilters) {
  requireTenantId(filters.tenantId);

  return db
    .select({ total: sql<string>`count(*)` })
    .from(conversations)
    .innerJoin(leads, joinReplyInboxLead(filters.tenantId))
    .where(and(...buildReplyInboxWhere(filters)));
}

export function buildReplyInboxFilterCountsQuery(db: DashboardDb, identity: { tenantId: string }) {
  requireTenantId(identity.tenantId);

  const intentTally = (intent: ReplyIntent) =>
    sql<string>`count(*) filter (where ${conversations.intent} = ${intent})`;

  return db
    .select({
      all: sql<string>`count(*)`,
      needsAttention: sql<string>`count(*) filter (where ${replyNeedsAttentionCondition()})`,
      interested: intentTally("interested"),
      question: intentTally("question"),
      objection: intentTally("objection"),
      notInterested: intentTally("not_interested"),
      unsubscribe: intentTally("unsubscribe"),
      abusive: intentTally("abusive"),
    })
    .from(conversations)
    .innerJoin(leads, joinReplyInboxLead(identity.tenantId))
    .where(
      and(
        eq(conversations.tenantId, identity.tenantId),
        eq(conversations.direction, "inbound"),
        eq(leads.isDeleted, false),
      ),
    );
}

export function normalizeReplyInboxFilterCounts(
  rows: Array<{
    all?: number | string | null;
    needsAttention?: number | string | null;
    interested?: number | string | null;
    question?: number | string | null;
    objection?: number | string | null;
    notInterested?: number | string | null;
    unsubscribe?: number | string | null;
    abusive?: number | string | null;
  }>,
): ReplyInboxFilterCounts {
  const row = rows[0];

  return {
    all: toNumber(row?.all ?? 0),
    needs_attention: toNumber(row?.needsAttention ?? 0),
    interested: toNumber(row?.interested ?? 0),
    question: toNumber(row?.question ?? 0),
    objection: toNumber(row?.objection ?? 0),
    not_interested: toNumber(row?.notInterested ?? 0),
    unsubscribe: toNumber(row?.unsubscribe ?? 0),
    abusive: toNumber(row?.abusive ?? 0),
  };
}

export function normalizeReplyInboxRow(row: {
  id: string;
  leadId: string;
  body: string;
  channel: string;
  intent: string | null;
  intentConfidence: number | string | null;
  agentAction: string | null;
  escalated: boolean | null;
  escalationReason: string | null;
  createdAt: Date | string;
  firstName: string | null;
  lastName: string | null;
  businessName: string | null;
  email: string;
}): ReplyInboxRow {
  return {
    id: row.id,
    leadId: row.leadId,
    body: row.body,
    channel: row.channel,
    intent: row.intent,
    intentConfidence: row.intentConfidence === null ? null : toNumber(row.intentConfidence),
    agentAction: row.agentAction,
    escalated: row.escalated === true,
    escalationReason: row.escalationReason,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    firstName: row.firstName,
    lastName: row.lastName,
    businessName: row.businessName,
    email: row.email,
  };
}

export async function getReplyInboxPage(filters: ReplyInboxFilters) {
  const db = getDb();
  const { page, pageSize } = normalizeLeadPagination(filters);
  const totalRows = await buildReplyInboxCountQuery(db, filters);
  const total = toNumber(totalRows[0]?.total);
  const meta = normalizeLeadListPageMeta({ total, page, pageSize });
  const pageRows = await buildReplyInboxQuery(db, { ...filters, page: meta.page, pageSize });

  return {
    rows: pageRows.map(normalizeReplyInboxRow),
    ...meta,
  };
}

export async function getReplyInboxFilterCounts(identity: { tenantId: string }) {
  const db = getDb();
  return normalizeReplyInboxFilterCounts(await buildReplyInboxFilterCountsQuery(db, identity));
}

// ---------------------------------------------------------------------------
// Inbound reply ingest health
//
// The two timestamps behind the /replies empty state. Neither is a health
// check Instantly answers, so see src/lib/reply-ingest-health.ts for what each
// one does and does not prove.
// ---------------------------------------------------------------------------

/** The last inbound write of any kind, so deleted leads are counted too.
 *
 * The inbox itself hides replies whose lead was deleted, but a write against
 * a since-deleted lead is still proof the ingest path worked, and this
 * question is about the path rather than about the pipeline.
 */
export function buildLastInboundConversationQuery(db: DashboardDb, identity: { tenantId: string }) {
  requireTenantId(identity.tenantId);

  return db
    .select({ lastInboundAt: max(conversations.createdAt) })
    .from(conversations)
    .where(
      and(eq(conversations.tenantId, identity.tenantId), eq(conversations.direction, "inbound")),
    );
}

/** The earliest handoff to Instantly, which is the earliest a reply could exist. */
export function buildFirstOutreachHandoffQuery(db: DashboardDb, identity: { tenantId: string }) {
  requireTenantId(identity.tenantId);

  return db
    .select({ firstHandoffAt: min(outreachSends.sentAt) })
    .from(outreachSends)
    .where(and(eq(outreachSends.tenantId, identity.tenantId), isNotNull(outreachSends.sentAt)));
}

export function normalizeReplyIngestSignal(
  inboundRows: Array<{ lastInboundAt?: Date | string | null }>,
  handoffRows: Array<{ firstHandoffAt?: Date | string | null }>,
): ReplyIngestSignal {
  return {
    lastInboundAt: toDateOrNull(inboundRows[0]?.lastInboundAt),
    firstHandoffAt: toDateOrNull(handoffRows[0]?.firstHandoffAt),
  };
}

export async function getReplyIngestSignal(identity: { tenantId: string }): Promise<ReplyIngestSignal> {
  const db = getDb();
  const [inboundRows, handoffRows] = await Promise.all([
    buildLastInboundConversationQuery(db, identity),
    buildFirstOutreachHandoffQuery(db, identity),
  ]);

  return normalizeReplyIngestSignal(inboundRows, handoffRows);
}

function toDateOrNull(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== "string" || value.trim() === "") return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

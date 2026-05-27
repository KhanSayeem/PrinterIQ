import "server-only";

import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb } from "./client";
import {
  conversations,
  enrichments,
  leads,
  outreachSends,
  payments,
  qualifications,
} from "./schema";

type DashboardDb = ReturnType<typeof getDb>;

export const PIPELINE_STATUSES = [
  "imported",
  "enriched",
  "qualified",
  "contacted",
  "replied",
  "paid",
  "archived",
] as const;

const ACTIVE_PIPELINE_STATUSES = PIPELINE_STATUSES.filter((status) => status !== "archived");

export const REVENUE_PERIODS = ["today", "week", "month"] as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];
export type RevenuePeriod = (typeof REVENUE_PERIODS)[number];

export type LeadListFilters = {
  tenantId: string;
  status?: string;
  state?: string;
  tradeType?: string;
  scoreMin?: number;
  scoreMax?: number;
  page?: number;
  pageSize?: number;
};

export type LeadIdentity = {
  tenantId: string;
  leadId: string;
};

export type LeadLatestConversation = {
  id: string;
  leadId: string;
  direction: string;
  body: string;
  createdAt: Date | string;
};

export type PipelineStage = {
  status: PipelineStatus;
  label: string;
  count: number;
  totalRate: number;
};

export type PipelineConversion = {
  from: PipelineStatus;
  to: PipelineStatus;
  label: string;
  rate: number | null;
  count: number;
  droppedCount: number;
};

export type PipelineAnalytics = {
  stages: PipelineStage[];
  conversions: PipelineConversion[];
  total: number;
  selectedStage: PipelineStatus;
  selectedStageDetail: PipelineStageDetail;
};

export type PipelineSampleLead = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  businessName: string | null;
  city: string | null;
  state: string | null;
  status: string;
  score: number | null;
  updatedAt: Date | string | null;
};

export type PipelineTopWeakness = {
  label: string;
  count: number;
};

export type PipelineStageDetail = {
  status: PipelineStatus;
  label: string;
  count: number;
  shareOfImported: number;
  previousConversionLabel: string;
  droppedFromPrevious: number;
  averageScore: number | null;
  topWeaknesses: PipelineTopWeakness[];
  sampleLeads: PipelineSampleLead[];
};

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

function formatRate(rate: number | null) {
  return rate === null ? "--" : `${rate.toFixed(1)}%`;
}

function labelForStatus(status: PipelineStatus) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function normalizePipelineStage(stage: string | undefined): PipelineStatus {
  return PIPELINE_STATUSES.includes(stage as PipelineStatus) ? (stage as PipelineStatus) : "imported";
}

export function normalizePipelineAnalytics(
  rows: Array<{ status: string; count: number | string }>,
  detail?: Partial<Pick<PipelineAnalytics, "selectedStage" | "selectedStageDetail">>,
): PipelineAnalytics {
  const counts = new Map(rows.map((row) => [row.status, toNumber(row.count)]));
  const total = PIPELINE_STATUSES.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);
  const importedTotal = counts.get("imported") ?? 0;

  const stages = PIPELINE_STATUSES.map((status) => {
    const count = counts.get(status) ?? 0;
    return {
      status,
      label: labelForStatus(status),
      count,
      totalRate: importedTotal === 0 ? 0 : (count / importedTotal) * 100,
    };
  });

  const conversions = ACTIVE_PIPELINE_STATUSES.slice(1).map((to, index) => {
    const from = ACTIVE_PIPELINE_STATUSES[index];
    const previous = counts.get(from) ?? 0;
    const current = counts.get(to) ?? 0;
    const rate = previous === 0 ? null : (current / previous) * 100;

    return {
      from,
      to,
      rate,
      label: formatRate(rate),
      count: current,
      droppedCount: Math.max(previous - current, 0),
    };
  });

  const selectedStage = detail?.selectedStage ?? "imported";
  const selectedStageDetail =
    detail?.selectedStageDetail ??
    buildPipelineStageDetail({
      selectedStage,
      stages,
      conversions,
      averageScore: null,
      weaknessRows: [],
      sampleLeads: [],
    });

  return { stages, conversions, total, selectedStage, selectedStageDetail };
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

  const page = Math.max(filters.page ?? 1, 1);
  const pageSize = Math.min(Math.max(filters.pageSize ?? 25, 1), 100);
  const where = [
    eq(leads.tenantId, filters.tenantId),
    eq(leads.isDeleted, false),
    filters.status ? eq(leads.status, filters.status) : undefined,
    filters.state ? eq(leads.state, filters.state) : undefined,
    filters.tradeType ? eq(leads.vertical, filters.tradeType) : undefined,
    filters.scoreMin === undefined ? undefined : gte(qualifications.score, filters.scoreMin),
    filters.scoreMax === undefined ? undefined : lte(qualifications.score, filters.scoreMax),
  ].filter(Boolean);

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
    .where(and(...where))
    .orderBy(desc(leads.updatedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
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

export function buildPipelineStageScoreSummaryQuery(
  db: DashboardDb,
  identity: { tenantId: string; selectedStage: PipelineStatus },
) {
  requireTenantId(identity.tenantId);

  return db
    .select({
      averageScore: sql<string>`avg(${qualifications.score})`,
    })
    .from(leads)
    .leftJoin(
      qualifications,
      and(eq(qualifications.leadId, leads.id), eq(qualifications.tenantId, identity.tenantId)),
    )
    .where(
      and(
        eq(leads.tenantId, identity.tenantId),
        eq(leads.isDeleted, false),
        eq(leads.status, identity.selectedStage),
      ),
    );
}

export function buildPipelineWeaknessRowsQuery(
  db: DashboardDb,
  identity: { tenantId: string; selectedStage: PipelineStatus },
) {
  requireTenantId(identity.tenantId);

  return db
    .select({
      weaknesses: enrichments.weaknesses,
    })
    .from(leads)
    .leftJoin(
      enrichments,
      and(eq(enrichments.leadId, leads.id), eq(enrichments.tenantId, identity.tenantId)),
    )
    .where(
      and(
        eq(leads.tenantId, identity.tenantId),
        eq(leads.isDeleted, false),
        eq(leads.status, identity.selectedStage),
      ),
    );
}

export function buildPipelineStageSampleLeadsQuery(
  db: DashboardDb,
  identity: { tenantId: string; selectedStage: PipelineStatus; limit?: number },
) {
  return buildLeadListQuery(db, {
    tenantId: identity.tenantId,
    status: identity.selectedStage,
    pageSize: identity.limit ?? 5,
  });
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

export async function getLeadList(filters: LeadListFilters) {
  const db = getDb();
  const rows = await buildLeadListQuery(db, filters);
  const leadIds = rows.map((row) => row.id);

  if (leadIds.length === 0) {
    return rows.map(normalizeLeadListRow);
  }

  const latestRows = await buildLatestConversationsForLeadsQuery(db, {
    tenantId: filters.tenantId,
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

export async function getPipelineAnalytics(identity: { tenantId: string; selectedStage?: string }) {
  requireTenantId(identity.tenantId);

  const db = getDb();
  const selectedStage = normalizePipelineStage(identity.selectedStage);
  const [statusRows, scoreRows, weaknessRows, sampleRows] = await Promise.all([
    buildPipelineStatusCountsQuery(db, identity),
    buildPipelineStageScoreSummaryQuery(db, { tenantId: identity.tenantId, selectedStage }),
    buildPipelineWeaknessRowsQuery(db, { tenantId: identity.tenantId, selectedStage }),
    buildPipelineStageSampleLeadsQuery(db, { tenantId: identity.tenantId, selectedStage, limit: 5 }),
  ]);

  const base = normalizePipelineAnalytics(statusRows, { selectedStage });
  const selectedStageDetail = buildPipelineStageDetail({
    selectedStage,
    stages: base.stages,
    conversions: base.conversions,
    averageScore: toNullableNumber(scoreRows[0]?.averageScore),
    weaknessRows,
    sampleLeads: sampleRows.map(normalizePipelineSampleLead),
  });

  return {
    ...base,
    selectedStageDetail,
  };
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

function buildPipelineStageDetail({
  selectedStage,
  stages,
  conversions,
  averageScore,
  weaknessRows,
  sampleLeads,
}: {
  selectedStage: PipelineStatus;
  stages: PipelineStage[];
  conversions: PipelineConversion[];
  averageScore: number | null;
  weaknessRows: Array<{ weaknesses: unknown }>;
  sampleLeads: PipelineSampleLead[];
}): PipelineStageDetail {
  const stage = stages.find((row) => row.status === selectedStage) ?? stages[0];
  const previousConversion = conversions.find((conversion) => conversion.to === selectedStage);

  return {
    status: selectedStage,
    label: labelForStatus(selectedStage),
    count: stage?.count ?? 0,
    shareOfImported: stage?.totalRate ?? 0,
    previousConversionLabel:
      selectedStage === "imported" ? "Starting stage" : (previousConversion?.label ?? "--"),
    droppedFromPrevious: previousConversion?.droppedCount ?? 0,
    averageScore,
    topWeaknesses: summarizeWeaknessRows(weaknessRows),
    sampleLeads,
  };
}

function normalizePipelineSampleLead(row: {
  id: string;
  firstName: string | null;
  lastName: string | null;
  businessName: string | null;
  city: string | null;
  state: string | null;
  status: string;
  score: number | null;
  updatedAt: Date | string | null;
}): PipelineSampleLead {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    businessName: row.businessName,
    city: row.city,
    state: row.state,
    status: row.status,
    score: row.score,
    updatedAt: row.updatedAt,
  };
}

function summarizeWeaknessRows(rows: Array<{ weaknesses: unknown }>) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const weakness of normalizeWeaknesses(row.weaknesses)) {
      counts.set(weakness, (counts.get(weakness) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, 5);
}

function normalizeWeaknesses(value: unknown) {
  return Array.isArray(value)
    ? value.filter((weakness): weakness is string => typeof weakness === "string" && weakness.trim().length > 0)
    : [];
}

function toNullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = toNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
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
  };
}

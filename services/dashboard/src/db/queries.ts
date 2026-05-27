import "server-only";

import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
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

function requireTenantId(tenantId: string) {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }
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

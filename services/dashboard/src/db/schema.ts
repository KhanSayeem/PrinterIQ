import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  tenantId: uuid("tenant_id").primaryKey().defaultRandom(),
  businessName: text("business_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const leads = pgTable("leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.tenantId),
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email").notNull(),
  emailStatus: text("email_status").default("unverified"),
  phone: text("phone"),
  businessName: text("business_name"),
  city: text("city"),
  state: text("state"),
  country: text("country").default("Australia"),
  websiteUrl: text("website_url"),
  industry: text("industry"),
  keywords: text("keywords"),
  linkedinUrl: text("linkedin_url"),
  technologies: text("technologies"),
  apolloContactId: text("apollo_contact_id").unique(),
  apolloAccountId: text("apollo_account_id"),
  sourceFile: text("source_file"),
  vertical: text("vertical").default("tradies"),
  status: text("status").notNull().default("imported"),
  isDeleted: boolean("is_deleted").notNull().default(false),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const enrichments = pgTable("enrichments", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .unique()
    .references(() => leads.id),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.tenantId),
  hasSite: boolean("has_site"),
  isReachable: boolean("is_reachable"),
  isMobileFriendly: boolean("is_mobile_friendly"),
  hasSsl: boolean("has_ssl"),
  hasMetaTitle: boolean("has_meta_title"),
  hasMetaDescription: boolean("has_meta_description"),
  hasH1: boolean("has_h1"),
  loadMs: integer("load_ms"),
  lighthouseMobileScore: integer("lighthouse_mobile_score"),
  cmsDetected: text("cms_detected"),
  techSource: text("tech_source").notNull(),
  weaknesses: jsonb("weaknesses").notNull().default([]),
  rawAudit: jsonb("raw_audit"),
  analysedAt: timestamp("analysed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const qualifications = pgTable("qualifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .unique()
    .references(() => leads.id),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.tenantId),
  score: integer("score").notNull(),
  rationale: text("rationale").notNull(),
  topWeakness: text("top_weakness").notNull(),
  subjectLine: text("subject_line"),
  personalisedOpener: text("personalised_opener"),
  followup1: text("followup_1"),
  followup2: text("followup_2"),
  modelHaiku: text("model_haiku").notNull(),
  modelSonnet: text("model_sonnet"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  promptVersion: text("prompt_version").notNull(),
  qualifiedAt: timestamp("qualified_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const outreachSends = pgTable("outreach_sends", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.tenantId),
  instantlyLeadId: text("instantly_lead_id"),
  instantlyCampaignId: text("instantly_campaign_id").notNull(),
  channel: text("channel").notNull().default("email"),
  step: integer("step").notNull().default(1),
  templateRef: text("template_ref"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  delivered: boolean("delivered").default(false),
  opened: boolean("opened").default(false),
  clicked: boolean("clicked").default(false),
  replied: boolean("replied").default(false),
  bounced: boolean("bounced").default(false),
  unsubscribed: boolean("unsubscribed").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.tenantId),
  direction: text("direction").notNull(),
  channel: text("channel").notNull(),
  body: text("body").notNull(),
  instantlyEmailId: text("instantly_email_id"),
  instantlyAccountId: text("instantly_account_id"),
  intent: text("intent"),
  intentConfidence: integer("intent_confidence"),
  agentAction: text("agent_action"),
  promptVersion: text("prompt_version"),
  modelUsed: text("model_used"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).default("0"),
  escalated: boolean("escalated").notNull().default(false),
  escalationReason: text("escalation_reason"),
  operatorOverride: boolean("operator_override").notNull().default(false),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .unique()
    .references(() => leads.id),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.tenantId),
  stripeSessionId: text("stripe_session_id").notNull().unique(),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  amountAud: numeric("amount_aud", { precision: 10, scale: 2 }).notNull(),
  status: text("status").notNull().default("pending"),
  onboardingTriggered: boolean("onboarding_triggered").notNull().default(false),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

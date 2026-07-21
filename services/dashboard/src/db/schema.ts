import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
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

export const websitePreviews = pgTable(
  "website_previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .unique()
      .references(() => leads.id),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    templateUsed: text("template_used").notNull(),
    previewSlug: text("preview_slug").notNull().unique(),
    previewUrl: text("preview_url").notNull(),
    personalisationData: jsonb("personalisation_data").notNull(),
    promptVersion: text("prompt_version").notNull(),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.leadId],
      foreignColumns: [leads.tenantId, leads.id],
      name: "fk_website_previews_lead_tenant",
    }),
  ],
);

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

export const discoveryRuns = pgTable(
  "discovery_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    source: text("source").notNull(),
    sourceRequestId: text("source_request_id"),
    querySpec: jsonb("query_spec").notNull(),
    status: text("status").notNull().default("created"),
    shadowMode: boolean("shadow_mode").notNull().default(true),
    discoveredCount: integer("discovered_count").notNull().default(0),
    usableCount: integer("usable_count").notNull().default(0),
    routeACount: integer("route_a_count").notNull().default(0),
    routeBCount: integer("route_b_count").notNull().default(0),
    verifiedContactCount: integer("verified_contact_count").notNull().default(0),
    providerUsage: jsonb("provider_usage").notNull().default({}),
    failureCode: text("failure_code"),
    failureDetail: text("failure_detail"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    resultsReceivedAt: timestamp("results_received_at", { withTimezone: true }),
    reviewReadyAt: timestamp("review_ready_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("discovery_runs_source_check", sql`${table.source} = 'outscraper'`),
    check(
      "discovery_runs_status_check",
      sql`${table.status} IN ('created','submitted','polling','persisted','processing','review_ready','completed','failed')`,
    ),
    check("discovery_runs_shadow_mode_check", sql`${table.shadowMode} = TRUE`),
    check("discovery_runs_discovered_count_check", sql`${table.discoveredCount} >= 0`),
    check("discovery_runs_usable_count_check", sql`${table.usableCount} >= 0`),
    check("discovery_runs_route_a_count_check", sql`${table.routeACount} >= 0`),
    check("discovery_runs_route_b_count_check", sql`${table.routeBCount} >= 0`),
    check(
      "discovery_runs_verified_contact_count_check",
      sql`${table.verifiedContactCount} >= 0`,
    ),
    unique("discovery_runs_tenant_id_id_key").on(table.tenantId, table.id),
    unique("discovery_runs_source_request_key").on(
      table.tenantId,
      table.source,
      table.sourceRequestId,
    ),
    uniqueIndex("discovery_runs_one_active_per_tenant_idx")
      .on(table.tenantId)
      .where(
        sql`${table.status} IN ('created','submitted','polling','persisted','processing')`,
      ),
  ],
);

export const businessProspects = pgTable(
  "business_prospects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    discoveryRunId: uuid("discovery_run_id").notNull(),
    source: text("source").notNull(),
    sourceBusinessId: text("source_business_id").notNull(),
    businessName: text("business_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    primaryCategory: text("primary_category"),
    additionalCategories: jsonb("additional_categories").notNull().default([]),
    phone: text("phone"),
    normalizedPhone: text("normalized_phone"),
    fullAddress: text("full_address"),
    locality: text("locality"),
    state: text("state"),
    postcode: text("postcode"),
    latitude: numeric("latitude", { precision: 10, scale: 7 }),
    longitude: numeric("longitude", { precision: 10, scale: 7 }),
    businessStatus: text("business_status"),
    rating: numeric("rating", { precision: 2, scale: 1 }),
    reviewCount: integer("review_count"),
    googleProfileUrl: text("google_profile_url"),
    sourceWebsiteUrl: text("source_website_url"),
    normalizedDomain: text("normalized_domain"),
    websiteOwnership: text("website_ownership"),
    duplicateEvidence: jsonb("duplicate_evidence").notNull().default({}),
    isFranchise: boolean("is_franchise").notNull().default(false),
    matchedLocationCount: integer("matched_location_count").notNull().default(1),
    route: text("route"),
    outcomeReason: text("outcome_reason"),
    status: text("status").notNull().default("discovered"),
    leadId: uuid("lead_id").references(() => leads.id),
    validationSample: boolean("validation_sample").notNull().default(false),
    validationCohort: text("validation_cohort"),
    sourcePayload: jsonb("source_payload"),
    sourcePayloadExpiresAt: timestamp("source_payload_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("business_prospects_source_check", sql`${table.source} = 'outscraper'`),
    check(
      "business_prospects_review_count_check",
      sql`${table.reviewCount} IS NULL OR ${table.reviewCount} >= 0`,
    ),
    check(
      "business_prospects_website_ownership_check",
      sql`${table.websiteOwnership} IN ('none','social','directory','marketplace','placeholder','inaccessible','owned')`,
    ),
    check(
      "business_prospects_matched_location_count_check",
      sql`${table.matchedLocationCount} >= 1`,
    ),
    check(
      "business_prospects_route_check",
      sql`${table.route} IN ('A','B','manual_review','healthy')`,
    ),
    check(
      "business_prospects_status_check",
      sql`${table.status} IN ('discovered','normalized','assessed','contact_enriched','review_ready','held','rejected','failed','approved','promoted')`,
    ),
    check(
      "business_prospects_validation_cohort_check",
      sql`${table.validationCohort} IN ('A','B','healthy_rejected')`,
    ),
    unique("business_prospects_tenant_id_id_key").on(table.tenantId, table.id),
    unique("business_prospects_tenant_run_id_key").on(
      table.tenantId,
      table.discoveryRunId,
      table.id,
    ),
    unique("business_prospects_source_identity_key").on(
      table.tenantId,
      table.discoveryRunId,
      table.source,
      table.sourceBusinessId,
    ),
    foreignKey({
      columns: [table.tenantId, table.discoveryRunId],
      foreignColumns: [discoveryRuns.tenantId, discoveryRuns.id],
      name: "fk_business_prospects_run_tenant",
    }),
    foreignKey({
      columns: [table.tenantId, table.leadId],
      foreignColumns: [leads.tenantId, leads.id],
      name: "fk_business_prospects_lead_tenant",
    }),
    index("idx_business_prospects_run_status").on(
      table.tenantId,
      table.discoveryRunId,
      table.status,
    ),
    index("idx_business_prospects_route_status").on(table.tenantId, table.route, table.status),
  ],
);

export const prospectAssessments = pgTable(
  "prospect_assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    discoveryRunId: uuid("discovery_run_id").notNull(),
    prospectId: uuid("prospect_id").notNull(),
    assessmentType: text("assessment_type").notNull(),
    assessmentVersion: text("assessment_version").notNull(),
    eligible: boolean("eligible"),
    computedRoute: text("computed_route"),
    totalScore: integer("total_score"),
    categoryScores: jsonb("category_scores").notNull().default({}),
    ruleEvidence: jsonb("rule_evidence").notNull().default({}),
    forcedRouteReason: text("forced_route_reason"),
    reviewerId: uuid("reviewer_id"),
    idempotencyKey: text("idempotency_key"),
    reviewDecision: text("review_decision"),
    correctedRoute: text("corrected_route"),
    reviewNote: text("review_note"),
    aiSummary: text("ai_summary"),
    promptVersion: text("prompt_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "prospect_assessments_assessment_type_check",
      sql`${table.assessmentType} IN ('automated','manual_review')`,
    ),
    check(
      "prospect_assessments_computed_route_check",
      sql`${table.computedRoute} IN ('A','B','manual_review','healthy')`,
    ),
    check(
      "prospect_assessments_total_score_check",
      sql`${table.totalScore} BETWEEN 0 AND 100`,
    ),
    check(
      "prospect_assessments_review_decision_check",
      sql`${table.reviewDecision} IN ('correct','wrong_route','ineligible','needs_investigation')`,
    ),
    check(
      "prospect_assessments_corrected_route_check",
      sql`${table.correctedRoute} IN ('A','B','manual_review','healthy')`,
    ),
    check(
      "prospect_assessment_shape_check",
      sql`(${table.assessmentType} = 'automated' AND ${table.reviewerId} IS NULL AND ${table.idempotencyKey} IS NULL) OR (${table.assessmentType} = 'manual_review' AND ${table.reviewerId} IS NOT NULL AND ${table.idempotencyKey} IS NOT NULL AND ${table.reviewDecision} IS NOT NULL)`,
    ),
    foreignKey({
      columns: [table.tenantId, table.discoveryRunId],
      foreignColumns: [discoveryRuns.tenantId, discoveryRuns.id],
      name: "fk_prospect_assessments_run_tenant",
    }),
    foreignKey({
      columns: [table.tenantId, table.discoveryRunId, table.prospectId],
      foreignColumns: [
        businessProspects.tenantId,
        businessProspects.discoveryRunId,
        businessProspects.id,
      ],
      name: "fk_prospect_assessments_prospect_run_tenant",
    }),
    uniqueIndex("prospect_automated_assessment_version_idx")
      .on(table.tenantId, table.prospectId, table.assessmentVersion)
      .where(sql`${table.assessmentType} = 'automated'`),
    uniqueIndex("prospect_manual_assessment_idempotency_idx")
      .on(table.tenantId, table.prospectId, table.idempotencyKey)
      .where(sql`${table.assessmentType} = 'manual_review'`),
    index("idx_prospect_assessments_lookup").on(
      table.tenantId,
      table.prospectId,
      table.createdAt,
    ),
  ],
);

export const prospectContacts = pgTable(
  "prospect_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    prospectId: uuid("prospect_id").notNull(),
    provider: text("provider").notNull(),
    inputFingerprint: text("input_fingerprint").notNull(),
    providerRequestId: text("provider_request_id"),
    providerOrganizationId: text("provider_organization_id"),
    providerPersonId: text("provider_person_id"),
    personName: text("person_name"),
    personTitle: text("person_title"),
    email: text("email"),
    providerEmailStatus: text("provider_email_status"),
    creditsConsumed: integer("credits_consumed"),
    status: text("status").notNull(),
    matchEvidence: jsonb("match_evidence").notNull().default({}),
    providerPayload: jsonb("provider_payload"),
    providerPayloadExpiresAt: timestamp("provider_payload_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("prospect_contacts_provider_check", sql`${table.provider} = 'apollo'`),
    check(
      "prospect_contacts_credits_consumed_check",
      sql`${table.creditsConsumed} IS NULL OR ${table.creditsConsumed} >= 0`,
    ),
    check(
      "prospect_contacts_status_check",
      sql`${table.status} IN ('verified','unverified','no_match','suppressed','failed')`,
    ),
    unique("prospect_contacts_input_key").on(
      table.tenantId,
      table.prospectId,
      table.provider,
      table.inputFingerprint,
    ),
    foreignKey({
      columns: [table.tenantId, table.prospectId],
      foreignColumns: [businessProspects.tenantId, businessProspects.id],
      name: "fk_prospect_contacts_prospect_tenant",
    }),
    index("idx_prospect_contacts_lookup").on(table.tenantId, table.prospectId, table.status),
  ],
);

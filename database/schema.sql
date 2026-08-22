-- PrinterIQ canonical schema — source of truth
-- Do not deviate without updating both this file and creating a new migration.
-- PRD Section 5.

CREATE TABLE tenants (
  tenant_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name         TEXT NOT NULL,
  instantly_api_key     TEXT,
  clicksend_api_key     TEXT,
  claude_voice_prompt   TEXT,
  escalation_phone      TEXT,
  stripe_product_id     TEXT,
  resend_from_email     TEXT,
  logo_url              TEXT,
  product_price_aud     NUMERIC(10,2) DEFAULT 1500.00,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE leads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id),
  -- Identity
  first_name          TEXT,
  last_name           TEXT,
  email               TEXT NOT NULL,
  email_status        TEXT DEFAULT 'unverified',
  phone               TEXT,
  business_name       TEXT,
  -- Location
  city                TEXT,
  state               TEXT,
  country             TEXT DEFAULT 'Australia',
  -- Web presence
  website_url         TEXT,
  -- Apollo metadata
  industry            TEXT,
  keywords            TEXT,
  linkedin_url        TEXT,
  technologies        TEXT,
  apollo_contact_id   TEXT UNIQUE,
  apollo_account_id   TEXT,
  -- System fields
  source_file         TEXT,
  vertical            TEXT DEFAULT 'tradies',
  status              TEXT NOT NULL DEFAULT 'imported',
  is_deleted          BOOLEAN NOT NULL DEFAULT FALSE,
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT leads_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE enrichments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                 UUID NOT NULL UNIQUE REFERENCES leads(id),
  tenant_id               UUID NOT NULL REFERENCES tenants(tenant_id),
  -- Site status
  has_site                BOOLEAN,
  is_reachable            BOOLEAN,
  -- Audit results
  is_mobile_friendly      BOOLEAN,
  has_ssl                 BOOLEAN,
  has_meta_title          BOOLEAN,
  has_meta_description    BOOLEAN,
  has_h1                  BOOLEAN,
  load_ms                 INTEGER,
  lighthouse_mobile_score INTEGER,
  cms_detected            TEXT,
  -- Source tracking
  tech_source             TEXT NOT NULL,
  -- Structured output
  weaknesses              JSONB NOT NULL DEFAULT '[]',
  raw_audit               JSONB,
  analysed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE qualifications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id               UUID NOT NULL UNIQUE REFERENCES leads(id),
  tenant_id             UUID NOT NULL REFERENCES tenants(tenant_id),
  -- Scores
  score                 INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  rationale             TEXT NOT NULL,
  top_weakness          TEXT NOT NULL,
  has_actionable_weakness BOOLEAN,
  -- Generated content
  subject_line          TEXT,
  personalised_opener   TEXT,
  followup_1            TEXT,
  followup_2            TEXT,
  weakness_sentence     TEXT,
  -- Audit
  model_haiku           TEXT NOT NULL,
  model_sonnet          TEXT,
  cost_usd              NUMERIC(10,6) NOT NULL DEFAULT 0,
  prompt_version        TEXT NOT NULL,
  qualified_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE website_previews (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(tenant_id),
  -- Phase 1: one preview per lead.
  -- If regeneration is added in a future phase, replace with
  -- soft-delete versioning before removing this constraint.
  lead_id              UUID NOT NULL UNIQUE,
  template_used        TEXT NOT NULL,
  preview_slug         TEXT NOT NULL UNIQUE,
  preview_url          TEXT NOT NULL,
  personalisation_data JSONB NOT NULL,
  prompt_version       TEXT NOT NULL,
  cost_usd             NUMERIC(10,6) NOT NULL,
  generated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_website_previews_lead_tenant
    FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id)
);

CREATE INDEX idx_website_previews_tenant_lead
ON website_previews (tenant_id, lead_id);

CREATE TABLE outreach_sends (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id               UUID NOT NULL REFERENCES leads(id),
  tenant_id             UUID NOT NULL REFERENCES tenants(tenant_id),
  -- Instantly references
  instantly_lead_id     TEXT,
  instantly_campaign_id TEXT NOT NULL,
  -- Send metadata
  channel               TEXT NOT NULL DEFAULT 'email',
  step                  INTEGER NOT NULL DEFAULT 1,
  template_ref          TEXT,
  -- Tracking
  sent_at               TIMESTAMPTZ,
  delivered             BOOLEAN DEFAULT FALSE,
  opened                BOOLEAN DEFAULT FALSE,
  clicked               BOOLEAN DEFAULT FALSE,
  replied               BOOLEAN DEFAULT FALSE,
  bounced               BOOLEAN DEFAULT FALSE,
  unsubscribed          BOOLEAN DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE conversations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             UUID NOT NULL REFERENCES leads(id),
  tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id),
  -- Message
  direction           TEXT NOT NULL,
  channel             TEXT NOT NULL,
  body                TEXT NOT NULL,
  -- Instantly reply metadata
  instantly_email_id  TEXT,
  instantly_account_id TEXT,
  -- Claude classification
  intent              TEXT,
  intent_confidence   INTEGER CHECK (intent_confidence BETWEEN 0 AND 100),
  agent_action        TEXT,
  -- Audit
  prompt_version      TEXT,
  model_used          TEXT,
  cost_usd            NUMERIC(10,6) DEFAULT 0,
  -- Escalation
  escalated           BOOLEAN NOT NULL DEFAULT FALSE,
  escalation_reason   TEXT,
  -- Override
  operator_override   BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at             TIMESTAMPTZ,
  -- Checkout idempotency: reuse the session already minted for this lead
  stripe_session_id   TEXT,
  stripe_session_url  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT conversations_stripe_session_complete
    CHECK ((stripe_session_id IS NULL) = (stripe_session_url IS NULL))
);

-- One live checkout session per lead, enforced by the database.
CREATE UNIQUE INDEX idx_conversations_checkout_session_per_lead
  ON conversations (tenant_id, lead_id)
  WHERE stripe_session_id IS NOT NULL;

CREATE TABLE payments (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                   UUID NOT NULL UNIQUE REFERENCES leads(id),
  tenant_id                 UUID NOT NULL REFERENCES tenants(tenant_id),
  stripe_session_id         TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id  TEXT,
  amount_aud                NUMERIC(10,2) NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'pending',
  onboarding_triggered      BOOLEAN NOT NULL DEFAULT FALSE,
  paid_at                   TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE queue_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id),
  lead_id         UUID REFERENCES leads(id),
  job_type        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  payload         JSONB NOT NULL,
  error_message   TEXT,
  scheduled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX queue_jobs_active_lead_job_idx
ON queue_jobs (tenant_id, lead_id, job_type)
WHERE lead_id IS NOT NULL
  AND status IN ('pending', 'active', 'failed');

CREATE UNIQUE INDEX queue_jobs_active_tenant_job_idx
ON queue_jobs (tenant_id, job_type)
WHERE lead_id IS NULL
  AND status IN ('pending', 'active', 'failed');

CREATE UNIQUE INDEX outreach_sends_tenant_lead_campaign_channel_idx
ON outreach_sends (tenant_id, lead_id, instantly_campaign_id, channel);

CREATE TABLE discovery_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
  source TEXT NOT NULL CHECK (source = 'outscraper'),
  source_request_id TEXT,
  query_spec JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created','submitted','polling','persisted','processing','review_ready','completed','failed'
  )),
  shadow_mode BOOLEAN NOT NULL DEFAULT TRUE CHECK (shadow_mode = TRUE),
  discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  usable_count INTEGER NOT NULL DEFAULT 0 CHECK (usable_count >= 0),
  route_a_count INTEGER NOT NULL DEFAULT 0 CHECK (route_a_count >= 0),
  route_b_count INTEGER NOT NULL DEFAULT 0 CHECK (route_b_count >= 0),
  verified_contact_count INTEGER NOT NULL DEFAULT 0 CHECK (verified_contact_count >= 0),
  provider_usage JSONB NOT NULL DEFAULT '{}',
  failure_code TEXT,
  failure_detail TEXT,
  submitted_at TIMESTAMPTZ,
  results_received_at TIMESTAMPTZ,
  review_ready_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_runs_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT discovery_runs_source_request_key UNIQUE (tenant_id, source, source_request_id)
);

CREATE UNIQUE INDEX discovery_runs_one_active_per_tenant_idx
ON discovery_runs (tenant_id)
WHERE status IN ('created','submitted','polling','persisted','processing','review_ready');

CREATE TABLE business_prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
  discovery_run_id UUID NOT NULL,
  source TEXT NOT NULL CHECK (source = 'outscraper'),
  source_business_id TEXT NOT NULL,
  business_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  primary_category TEXT,
  additional_categories JSONB NOT NULL DEFAULT '[]',
  phone TEXT,
  normalized_phone TEXT,
  full_address TEXT,
  locality TEXT,
  state TEXT,
  postcode TEXT,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  business_status TEXT,
  rating NUMERIC(2,1),
  review_count INTEGER CHECK (review_count IS NULL OR review_count >= 0),
  google_profile_url TEXT,
  source_website_url TEXT,
  normalized_domain TEXT,
  website_ownership TEXT CHECK (website_ownership IN (
    'none','social','directory','marketplace','placeholder','inaccessible','owned'
  )),
  duplicate_evidence JSONB NOT NULL DEFAULT '{}',
  is_franchise BOOLEAN NOT NULL DEFAULT FALSE,
  matched_location_count INTEGER NOT NULL DEFAULT 1 CHECK (matched_location_count >= 1),
  route TEXT CHECK (route IN ('A','B','manual_review','healthy')),
  outcome_reason TEXT,
  status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN (
    'discovered','normalized','assessed','contact_enriched','review_ready',
    'held','rejected','failed','approved','promoted'
  )),
  lead_id UUID REFERENCES leads(id),
  validation_sample BOOLEAN NOT NULL DEFAULT FALSE,
  validation_cohort TEXT CHECK (validation_cohort IN ('A','B','healthy_rejected')),
  source_payload JSONB,
  source_payload_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT business_prospects_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT business_prospects_tenant_run_id_key
    UNIQUE (tenant_id, discovery_run_id, id),
  CONSTRAINT business_prospects_source_identity_key
    UNIQUE (tenant_id, discovery_run_id, source, source_business_id),
  CONSTRAINT fk_business_prospects_run_tenant
    FOREIGN KEY (tenant_id, discovery_run_id)
    REFERENCES discovery_runs(tenant_id, id),
  CONSTRAINT fk_business_prospects_lead_tenant
    FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id)
);

CREATE INDEX idx_business_prospects_run_status
ON business_prospects (tenant_id, discovery_run_id, status);

CREATE INDEX idx_business_prospects_route_status
ON business_prospects (tenant_id, route, status);

CREATE TABLE prospect_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
  discovery_run_id UUID NOT NULL,
  prospect_id UUID NOT NULL,
  assessment_type TEXT NOT NULL CHECK (assessment_type IN ('automated','manual_review')),
  assessment_version TEXT NOT NULL,
  eligible BOOLEAN,
  computed_route TEXT CHECK (computed_route IN ('A','B','manual_review','healthy')),
  total_score INTEGER CHECK (total_score BETWEEN 0 AND 100),
  category_scores JSONB NOT NULL DEFAULT '{}',
  rule_evidence JSONB NOT NULL DEFAULT '{}',
  forced_route_reason TEXT,
  reviewer_id UUID,
  idempotency_key TEXT,
  review_decision TEXT CHECK (review_decision IN (
    'correct','wrong_route','ineligible','needs_investigation'
  )),
  corrected_route TEXT CHECK (corrected_route IN ('A','B','manual_review','healthy')),
  review_note TEXT,
  ai_summary TEXT,
  prompt_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_prospect_assessments_run_tenant
    FOREIGN KEY (tenant_id, discovery_run_id) REFERENCES discovery_runs(tenant_id, id),
  CONSTRAINT fk_prospect_assessments_prospect_run_tenant
    FOREIGN KEY (tenant_id, discovery_run_id, prospect_id)
    REFERENCES business_prospects(tenant_id, discovery_run_id, id),
  CONSTRAINT prospect_assessment_shape_check CHECK (
    (assessment_type = 'automated' AND reviewer_id IS NULL AND idempotency_key IS NULL)
    OR
    (assessment_type = 'manual_review' AND reviewer_id IS NOT NULL
      AND idempotency_key IS NOT NULL AND review_decision IS NOT NULL)
  )
);

CREATE UNIQUE INDEX prospect_automated_assessment_version_idx
ON prospect_assessments (tenant_id, discovery_run_id, prospect_id, assessment_version)
WHERE assessment_type = 'automated';

CREATE UNIQUE INDEX prospect_manual_assessment_idempotency_idx
ON prospect_assessments (tenant_id, prospect_id, idempotency_key)
WHERE assessment_type = 'manual_review';

CREATE INDEX idx_prospect_assessments_lookup
ON prospect_assessments (tenant_id, prospect_id, created_at);

CREATE TABLE prospect_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
  prospect_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'apollo'),
  input_fingerprint TEXT NOT NULL,
  provider_request_id TEXT,
  provider_organization_id TEXT,
  provider_person_id TEXT,
  person_name TEXT,
  person_title TEXT,
  email TEXT,
  provider_email_status TEXT,
  credits_consumed INTEGER CHECK (credits_consumed IS NULL OR credits_consumed >= 0),
  status TEXT NOT NULL CHECK (status IN ('verified','unverified','no_match','suppressed','failed')),
  match_evidence JSONB NOT NULL DEFAULT '{}',
  provider_payload JSONB,
  provider_payload_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prospect_contacts_input_key UNIQUE (tenant_id, prospect_id, provider, input_fingerprint),
  CONSTRAINT fk_prospect_contacts_prospect_tenant
    FOREIGN KEY (tenant_id, prospect_id) REFERENCES business_prospects(tenant_id, id)
);

CREATE INDEX idx_prospect_contacts_lookup
ON prospect_contacts (tenant_id, prospect_id, status);

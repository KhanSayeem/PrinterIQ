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
  -- Generated content
  subject_line          TEXT,
  personalised_opener   TEXT,
  followup_1            TEXT,
  followup_2            TEXT,
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
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

-- Migration 0001: initial schema
-- Applies the full PrinterIQ schema from database/schema.sql.
-- Run once against Supabase Postgres.

CREATE TABLE IF NOT EXISTS tenants (
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

-- Phase 1: single tenant row (deterministic UUID for seeding and test references)
INSERT INTO tenants (tenant_id, business_name, escalation_phone, product_price_aud)
VALUES ('10000000-0000-0000-0000-000000000001', 'PrinterIQ', '+61400457006', 1500.00)
ON CONFLICT (tenant_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS leads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id),
  first_name          TEXT,
  last_name           TEXT,
  email               TEXT NOT NULL,
  email_status        TEXT DEFAULT 'unverified',
  phone               TEXT,
  business_name       TEXT,
  city                TEXT,
  state               TEXT,
  country             TEXT DEFAULT 'Australia',
  website_url         TEXT,
  industry            TEXT,
  keywords            TEXT,
  linkedin_url        TEXT,
  technologies        TEXT,
  apollo_contact_id   TEXT UNIQUE,
  apollo_account_id   TEXT,
  source_file         TEXT,
  vertical            TEXT DEFAULT 'tradies',
  status              TEXT NOT NULL DEFAULT 'imported',
  is_deleted          BOOLEAN NOT NULL DEFAULT FALSE,
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS enrichments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                 UUID NOT NULL UNIQUE REFERENCES leads(id),
  tenant_id               UUID NOT NULL REFERENCES tenants(tenant_id),
  has_site                BOOLEAN,
  is_reachable            BOOLEAN,
  is_mobile_friendly      BOOLEAN,
  has_ssl                 BOOLEAN,
  has_meta_title          BOOLEAN,
  has_meta_description    BOOLEAN,
  has_h1                  BOOLEAN,
  load_ms                 INTEGER,
  lighthouse_mobile_score INTEGER,
  cms_detected            TEXT,
  tech_source             TEXT NOT NULL,
  weaknesses              JSONB NOT NULL DEFAULT '[]',
  raw_audit               JSONB,
  analysed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qualifications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id               UUID NOT NULL UNIQUE REFERENCES leads(id),
  tenant_id             UUID NOT NULL REFERENCES tenants(tenant_id),
  score                 INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  rationale             TEXT NOT NULL,
  top_weakness          TEXT NOT NULL,
  subject_line          TEXT,
  personalised_opener   TEXT,
  followup_1            TEXT,
  followup_2            TEXT,
  model_haiku           TEXT NOT NULL,
  model_sonnet          TEXT,
  cost_usd              NUMERIC(10,6) NOT NULL DEFAULT 0,
  prompt_version        TEXT NOT NULL,
  qualified_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outreach_sends (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id               UUID NOT NULL REFERENCES leads(id),
  tenant_id             UUID NOT NULL REFERENCES tenants(tenant_id),
  instantly_lead_id     TEXT,
  instantly_campaign_id TEXT,
  channel               TEXT NOT NULL DEFAULT 'email',
  step                  INTEGER NOT NULL DEFAULT 1,
  template_ref          TEXT,
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

CREATE TABLE IF NOT EXISTS conversations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             UUID NOT NULL REFERENCES leads(id),
  tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id),
  direction           TEXT NOT NULL,
  channel             TEXT NOT NULL,
  body                TEXT NOT NULL,
  intent              TEXT,
  intent_confidence   INTEGER CHECK (intent_confidence BETWEEN 0 AND 100),
  agent_action        TEXT,
  prompt_version      TEXT,
  model_used          TEXT,
  cost_usd            NUMERIC(10,6) DEFAULT 0,
  escalated           BOOLEAN NOT NULL DEFAULT FALSE,
  escalation_reason   TEXT,
  operator_override   BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
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

CREATE TABLE IF NOT EXISTS queue_jobs (
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

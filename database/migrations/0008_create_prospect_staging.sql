-- Migration 0008: add tenant-scoped staging for Outscraper shadow discovery.

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
WHERE status IN ('created','submitted','polling','processing');

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

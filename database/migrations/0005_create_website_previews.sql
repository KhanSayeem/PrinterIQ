-- Migration 0005: create website preview metadata table.
-- Stores preview template choice, hosted URL, Claude personalisation output, and cost.

CREATE TABLE IF NOT EXISTS website_previews (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  -- Phase 1: one preview per lead.
  -- If regeneration is added in a future phase, replace with
  -- soft-delete versioning before removing this constraint.
  lead_id              UUID NOT NULL UNIQUE,
  template_used        TEXT NOT NULL,
  preview_url          TEXT NOT NULL,
  personalisation_data JSONB NOT NULL,
  prompt_version       TEXT NOT NULL,
  cost_usd             NUMERIC(10,6) NOT NULL,
  generated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_website_previews_lead
    FOREIGN KEY (lead_id) REFERENCES leads(id),
  CONSTRAINT fk_website_previews_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_website_previews_tenant_lead
ON website_previews (tenant_id, lead_id);

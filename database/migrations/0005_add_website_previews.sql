-- Migration 0005: add website_previews table
-- Stores the generated preview metadata for each lead.
-- The rendered HTML lives on VPS disk at /var/www/previews/{lead_id}.html.

CREATE TABLE IF NOT EXISTS website_previews (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  -- Phase 1: one preview per lead.
  -- If regeneration is added in a future phase, replace with
  -- soft-delete versioning before removing this constraint.
  lead_id              uuid NOT NULL UNIQUE,
  template_used        text NOT NULL,
  preview_url          text NOT NULL,
  personalisation_data jsonb NOT NULL,
  prompt_version       text NOT NULL,
  cost_usd             numeric(10,6) NOT NULL,
  generated_at         timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_website_previews_lead
    FOREIGN KEY (lead_id) REFERENCES leads(id),
  CONSTRAINT fk_website_previews_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_website_previews_tenant_lead
  ON website_previews (tenant_id, lead_id);

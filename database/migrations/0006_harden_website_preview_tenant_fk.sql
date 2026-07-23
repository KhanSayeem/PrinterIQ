-- Migration 0006: enforce website_previews tenant/lead consistency at the DB layer.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leads_tenant_id_id_key'
      AND conrelid = 'leads'::regclass
  ) THEN
    ALTER TABLE leads
    ADD CONSTRAINT leads_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
END $$;

DO $$
DECLARE
  mismatched_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO mismatched_count
  FROM website_previews
  LEFT JOIN leads ON leads.id = website_previews.lead_id
  WHERE leads.id IS NULL
     OR leads.tenant_id <> website_previews.tenant_id;

  IF mismatched_count > 0 THEN
    RAISE EXCEPTION
      'website_previews tenant/lead mismatch blocks fk hardening: % rows',
      mismatched_count;
  END IF;
END $$;

ALTER TABLE website_previews
DROP CONSTRAINT IF EXISTS fk_website_previews_lead;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_website_previews_lead_tenant'
      AND conrelid = 'website_previews'::regclass
  ) THEN
    ALTER TABLE website_previews
    ADD CONSTRAINT fk_website_previews_lead_tenant
      FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id);
  END IF;
END $$;

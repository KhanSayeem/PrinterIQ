-- Migration 0002: indexes
-- PRD Section 5 — Indexes

CREATE INDEX IF NOT EXISTS idx_leads_tenant_status  ON leads(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_email           ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_apollo_id       ON leads(apollo_contact_id);

CREATE INDEX IF NOT EXISTS idx_conversations_lead    ON conversations(lead_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_outreach_tenant_sent  ON outreach_sends(tenant_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_queue_pending         ON queue_jobs(tenant_id, status, scheduled_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_payments_tenant_paid  ON payments(tenant_id, paid_at DESC)
  WHERE status = 'completed';

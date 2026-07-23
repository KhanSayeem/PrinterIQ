-- Migration 0003: enforce active queue job idempotency.
-- Prevents duplicate pending/active/failed jobs for the same tenant, lead, and job type.

CREATE UNIQUE INDEX IF NOT EXISTS queue_jobs_active_lead_job_idx
ON queue_jobs (tenant_id, lead_id, job_type)
WHERE lead_id IS NOT NULL
  AND status IN ('pending', 'active', 'failed');

CREATE UNIQUE INDEX IF NOT EXISTS queue_jobs_active_tenant_job_idx
ON queue_jobs (tenant_id, job_type)
WHERE lead_id IS NULL
  AND status IN ('pending', 'active', 'failed');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM outreach_sends
    WHERE instantly_campaign_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce outreach_sends campaign idempotency while rows have NULL instantly_campaign_id';
  END IF;
END $$;

ALTER TABLE outreach_sends
ALTER COLUMN instantly_campaign_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS outreach_sends_tenant_lead_campaign_channel_idx
ON outreach_sends (tenant_id, lead_id, instantly_campaign_id, channel);

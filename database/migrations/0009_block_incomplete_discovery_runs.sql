DROP INDEX IF EXISTS discovery_runs_one_active_per_tenant_idx;

CREATE UNIQUE INDEX discovery_runs_one_active_per_tenant_idx
ON discovery_runs (tenant_id)
WHERE status IN ('created','submitted','polling','persisted','processing','review_ready');

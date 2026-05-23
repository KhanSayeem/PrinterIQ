from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_canonical_schema_includes_outreach_and_queue_idempotency() -> None:
    schema = (REPO_ROOT / "database" / "schema.sql").read_text()

    assert "instantly_campaign_id TEXT NOT NULL" in schema
    assert "CREATE UNIQUE INDEX queue_jobs_active_lead_job_idx" in schema
    assert "CREATE UNIQUE INDEX queue_jobs_active_tenant_job_idx" in schema
    assert "CREATE UNIQUE INDEX outreach_sends_tenant_lead_campaign_channel_idx" in schema

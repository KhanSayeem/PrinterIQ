from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_canonical_schema_includes_outreach_and_queue_idempotency() -> None:
    schema = (REPO_ROOT / "database" / "schema.sql").read_text()

    assert "instantly_campaign_id TEXT NOT NULL" in schema
    assert "CREATE UNIQUE INDEX queue_jobs_active_lead_job_idx" in schema
    assert "CREATE UNIQUE INDEX queue_jobs_active_tenant_job_idx" in schema
    assert "CREATE UNIQUE INDEX outreach_sends_tenant_lead_campaign_channel_idx" in schema


def test_canonical_schema_includes_website_previews_contract() -> None:
    schema = (REPO_ROOT / "database" / "schema.sql").read_text()
    migration_path = REPO_ROOT / "database" / "migrations" / "0005_create_website_previews.sql"

    assert migration_path.exists()

    migration = migration_path.read_text()

    assert "CREATE TABLE website_previews" in schema
    assert "tenant_id            UUID NOT NULL REFERENCES tenants(tenant_id)" in schema
    assert "lead_id              UUID NOT NULL UNIQUE REFERENCES leads(id)" in schema
    assert "personalisation_data JSONB NOT NULL" in schema
    assert "generated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()" in schema
    assert "CREATE INDEX idx_website_previews_tenant_lead" in schema
    assert "ON website_previews (tenant_id, lead_id)" in schema

    assert "Phase 1: one preview per lead." in migration

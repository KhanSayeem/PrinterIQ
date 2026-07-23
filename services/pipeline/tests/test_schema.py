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
    hardening_migration_path = (
        REPO_ROOT / "database" / "migrations" / "0006_harden_website_preview_tenant_fk.sql"
    )
    slug_migration_path = (
        REPO_ROOT / "database" / "migrations" / "0007_add_website_preview_slug.sql"
    )

    assert migration_path.exists()
    assert hardening_migration_path.exists()
    assert slug_migration_path.exists()

    migration = migration_path.read_text()
    hardening_migration = hardening_migration_path.read_text()
    slug_migration = slug_migration_path.read_text()

    assert "CREATE TABLE website_previews" in schema
    assert "CONSTRAINT leads_tenant_id_id_key UNIQUE (tenant_id, id)" in schema
    assert "tenant_id            UUID NOT NULL REFERENCES tenants(tenant_id)" in schema
    assert "lead_id              UUID NOT NULL UNIQUE" in schema
    assert "preview_slug         TEXT NOT NULL UNIQUE" in schema
    assert "personalisation_data JSONB NOT NULL" in schema
    assert "generated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()" in schema
    assert "FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id)" in schema
    assert "CREATE INDEX idx_website_previews_tenant_lead" in schema
    assert "ON website_previews (tenant_id, lead_id)" in schema

    assert "Phase 1: one preview per lead." in migration
    assert "fk_website_previews_lead_tenant" in hardening_migration
    assert "pg_constraint" in hardening_migration
    assert "website_previews tenant/lead mismatch blocks fk hardening" in hardening_migration
    assert "preview_slug" in slug_migration
    assert "'https://preview.presciaiq.com/p/' || preview_slug || '/'" in slug_migration
    assert "website_previews_preview_slug_key" in slug_migration
    assert "conrelid = 'website_previews'::regclass" in slug_migration


def test_canonical_schema_includes_prospect_staging_contract() -> None:
    schema = (REPO_ROOT / "database" / "schema.sql").read_text()
    migration = REPO_ROOT / "database" / "migrations" / "0008_create_prospect_staging.sql"
    active_guard_migration = (
        REPO_ROOT / "database" / "migrations" / "0009_block_incomplete_discovery_runs.sql"
    )

    assert migration.exists()
    assert active_guard_migration.exists()
    for table in (
        "discovery_runs",
        "business_prospects",
        "prospect_assessments",
        "prospect_contacts",
    ):
        assert f"CREATE TABLE {table}" in schema
    assert "discovery_runs_one_active_per_tenant_idx" in schema
    active_index = schema.split(
        "CREATE UNIQUE INDEX discovery_runs_one_active_per_tenant_idx", maxsplit=1
    )[1].split(";", maxsplit=1)[0]
    assert "'created','submitted','polling','persisted','processing','review_ready'" in active_index
    assert "business_prospects_source_identity_key" in schema
    assert "business_prospects_tenant_run_id_key" in schema
    assert "FOREIGN KEY (tenant_id, discovery_run_id)" in schema
    assert "FOREIGN KEY (tenant_id, discovery_run_id, prospect_id)" in schema
    assert "prospect_manual_assessment_idempotency_idx" in schema


def test_prospect_active_run_guard_migration_matches_canonical_schema() -> None:
    schema = (REPO_ROOT / "database" / "schema.sql").read_text()
    migration = (
        REPO_ROOT / "database" / "migrations" / "0009_block_incomplete_discovery_runs.sql"
    ).read_text()
    active_index = schema.split(
        "CREATE UNIQUE INDEX discovery_runs_one_active_per_tenant_idx", maxsplit=1
    )[1].split(";", maxsplit=1)[0]

    assert "DROP INDEX IF EXISTS discovery_runs_one_active_per_tenant_idx" in migration
    assert (
        "WHERE status IN ('created','submitted','polling','persisted','processing','review_ready')"
        in migration
    )
    assert "persisted" in active_index
    assert "review_ready" in active_index

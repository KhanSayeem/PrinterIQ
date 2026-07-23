from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

import pytest

from db.queries import ProspectStore, SourceProspectStatus, SourceProspectUpsert
from prospects.sampling import ValidationSampleMember

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
RUN_ID = UUID("20000000-0000-0000-0000-000000000001")
PROSPECT_ID = UUID("30000000-0000-0000-0000-000000000001")


class RecordingConnection:
    def __init__(self, *, row: object = None) -> None:
        self.row = row
        self.queries: list[str] = []
        self.args: list[tuple[object, ...]] = []

    async def fetch(self, query: str, *args: object) -> list[object]:
        self.queries.append(query)
        self.args.append(args)
        return self.row if isinstance(self.row, list) else []

    async def fetchrow(self, query: str, *args: object) -> object:
        self.queries.append(query)
        self.args.append(args)
        return self.row

    async def fetchval(self, query: str, *args: object) -> object:
        self.queries.append(query)
        self.args.append(args)
        return self.row

    async def execute(self, query: str, *args: object) -> object:
        raise AssertionError("ProspectStore writes should return the affected row")


def _run_row(*, status: str = "submitted") -> dict[str, object]:
    return {
        "id": RUN_ID,
        "tenant_id": TENANT_ID,
        "source": "outscraper",
        "source_request_id": "request-123",
        "query_spec": {"preset": "greater-brisbane-plumbers-v1"},
        "status": status,
        "shadow_mode": True,
        "discovered_count": 0,
        "usable_count": 0,
        "route_a_count": 0,
        "route_b_count": 0,
        "verified_contact_count": 0,
        "provider_usage": {},
        "failure_code": None,
        "failure_detail": None,
    }


def _source_prospect(*, status: SourceProspectStatus = "discovered") -> SourceProspectUpsert:
    return SourceProspectUpsert(
        tenant_id=TENANT_ID,
        discovery_run_id=RUN_ID,
        source_business_id="ChIJ-test",
        business_name="Northside Plumbing",
        primary_category="Plumber",
        additional_categories=("Plumber", "Drainage service"),
        phone="+61 7 3000 0000",
        full_address="Brisbane QLD 4000",
        locality="Brisbane",
        state="Queensland",
        postcode="4000",
        latitude=Decimal("-27.4697700"),
        longitude=Decimal("153.0251300"),
        business_status="OPERATIONAL",
        rating=Decimal("4.6"),
        review_count=42,
        google_profile_url="https://google.example/place",
        source_website_url="https://northside.example",
        source_payload={"place_id": "ChIJ-test", "name": "Northside Plumbing"},
        status=status,
        outcome_reason=None,
    )


def test_get_discovery_run_is_tenant_scoped_and_returns_mapping() -> None:
    async def scenario() -> None:
        row = _run_row()
        connection = RecordingConnection(row=row)

        result = await ProspectStore(connection).get_discovery_run(TENANT_ID, RUN_ID)

        assert result == row
        assert result is not row
        assert "FROM discovery_runs" in connection.queries[0]
        assert "WHERE tenant_id = $1" in connection.queries[0]
        assert "AND id = $2" in connection.queries[0]
        assert connection.args[0] == (TENANT_ID, RUN_ID)

    asyncio.run(scenario())


def test_get_discovery_run_returns_none_when_tenant_run_pair_is_missing() -> None:
    async def scenario() -> None:
        result = await ProspectStore(RecordingConnection()).get_discovery_run(TENANT_ID, RUN_ID)

        assert result is None

    asyncio.run(scenario())


def test_list_discovered_prospects_is_tenant_and_run_scoped() -> None:
    async def scenario() -> None:
        connection = RecordingConnection(row=[])

        await ProspectStore(connection).list_discovered_prospects(
            tenant_id=TENANT_ID,
            discovery_run_id=RUN_ID,
        )

        query = connection.queries[0]
        assert "FROM business_prospects" in query
        assert "WHERE tenant_id = $1" in query
        assert "AND discovery_run_id = $2" in query
        assert "AND status IN ('discovered', 'normalized', 'assessed', 'held', 'rejected')" in query
        assert connection.args[0] == (TENANT_ID, RUN_ID)

    asyncio.run(scenario())


def test_list_discovered_prospects_includes_processed_siblings_for_replay_context() -> None:
    async def scenario() -> None:
        connection = RecordingConnection(row=[])

        await ProspectStore(connection).list_discovered_prospects(
            tenant_id=TENANT_ID,
            discovery_run_id=RUN_ID,
        )

        query = connection.queries[0]
        assert "FROM business_prospects" in query
        assert "WHERE tenant_id = $1" in query
        assert "AND discovery_run_id = $2" in query
        assert "status IN ('discovered', 'normalized', 'assessed', 'held', 'rejected')" in query

    asyncio.run(scenario())


def test_list_prospects_for_shadow_review_includes_terminal_review_states_without_leads() -> None:
    async def scenario() -> None:
        connection = RecordingConnection(row=[])

        await ProspectStore(connection).list_prospects_for_shadow_review(
            tenant_id=TENANT_ID,
            discovery_run_id=RUN_ID,
        )

        query = connection.queries[0]
        assert "FROM business_prospects" in query
        assert "WHERE tenant_id = $1" in query
        assert "AND discovery_run_id = $2" in query
        assert "AND lead_id IS NULL" in query
        assert "'contact_enriched'" in query
        assert "'review_ready'" in query
        assert "'rejected'" in query
        assert "'failed'" in query
        assert "validation_sample" in query
        assert "validation_cohort" in query
        assert connection.args[0] == (TENANT_ID, RUN_ID)

    asyncio.run(scenario())


def test_apply_validation_sample_resets_and_persists_tenant_run_sample_membership() -> None:
    async def scenario() -> None:
        connection = RecordingConnection(row={"selected_count": 2})

        result = await ProspectStore(connection).apply_validation_sample(
            tenant_id=TENANT_ID,
            discovery_run_id=RUN_ID,
            members=(
                ValidationSampleMember(PROSPECT_ID, "A", "key-a"),
                ValidationSampleMember(
                    UUID("30000000-0000-0000-0000-000000000002"),
                    "healthy_rejected",
                    "key-h",
                ),
            ),
        )

        query = connection.queries[0]
        assert result == {"selected_count": 2}
        assert "WITH selected(prospect_id, cohort)" in query
        assert "UPDATE business_prospects" in query
        assert "validation_sample = FALSE" in query
        assert "validation_sample = TRUE" in query
        assert "validation_cohort = selected.cohort" in query
        assert "business_prospects.tenant_id = $1" in query
        assert "business_prospects.discovery_run_id = $2" in query
        assert "business_prospects.lead_id IS NULL" in query
        assert connection.args[0] == (
            TENANT_ID,
            RUN_ID,
            [PROSPECT_ID, UUID("30000000-0000-0000-0000-000000000002")],
            ["A", "healthy_rejected"],
        )

    asyncio.run(scenario())


def test_apply_prospect_normalization_is_tenant_run_and_prospect_scoped() -> None:
    async def scenario() -> None:
        row = {"id": PROSPECT_ID, "tenant_id": TENANT_ID}
        connection = RecordingConnection(row=row)

        result = await ProspectStore(connection).apply_prospect_normalization(
            tenant_id=TENANT_ID,
            discovery_run_id=RUN_ID,
            prospect_id=PROSPECT_ID,
            normalized_name="northside plumbing",
            normalized_phone="61730000000",
            normalized_domain=None,
            website_ownership="social",
            duplicate_evidence={"phone": ["place-2"]},
            is_franchise=False,
            matched_location_count=1,
            route="A",
            status="assessed",
            outcome_reason="no_owned_website",
        )

        query = connection.queries[0]
        assert result == row
        assert "UPDATE business_prospects" in query
        assert "WHERE tenant_id = $1" in query
        assert "AND discovery_run_id = $2" in query
        assert "AND id = $3" in query
        assert "AND status = 'discovered'" in query
        assert "lead_id IS NULL" in query
        assert connection.args[0][:3] == (TENANT_ID, RUN_ID, PROSPECT_ID)
        assert json.loads(str(connection.args[0][7])) == {"phone": ["place-2"]}

    asyncio.run(scenario())


def test_upsert_prospect_assessment_is_tenant_scoped_and_idempotent() -> None:
    async def scenario() -> None:
        row = {"id": UUID("40000000-0000-0000-0000-000000000001")}
        connection = RecordingConnection(row=row)

        result = await ProspectStore(connection).upsert_prospect_assessment(
            tenant_id=TENANT_ID,
            discovery_run_id=RUN_ID,
            prospect_id=PROSPECT_ID,
            assessment_version="route-a-normalization-v1",
            eligible=True,
            computed_route="A",
            total_score=None,
            category_scores={},
            rule_evidence={"website": {"ownership": "social"}},
            forced_route_reason="no_owned_website",
        )

        query = connection.queries[0]
        assert result == row
        assert "INSERT INTO prospect_assessments" in query
        assert "tenant_id, discovery_run_id, prospect_id" in query
        assert "total_score" in query
        assert "category_scores" in query
        assert "ON CONFLICT (tenant_id, discovery_run_id, prospect_id, assessment_version)" in query
        assert "WHERE assessment_type = 'automated'" in query
        assert connection.args[0][:3] == (TENANT_ID, RUN_ID, PROSPECT_ID)
        assert json.loads(str(connection.args[0][7])) == {}
        assert json.loads(str(connection.args[0][8])) == {
            "website": {"ownership": "social"}
        }

    asyncio.run(scenario())


def test_apply_prospect_assessment_result_is_atomic_and_tenant_scoped() -> None:
    async def scenario() -> None:
        row = {
            "id": PROSPECT_ID,
            "tenant_id": TENANT_ID,
            "assessment_id": UUID("40000000-0000-0000-0000-000000000001"),
        }
        connection = RecordingConnection(row=row)

        result = await ProspectStore(connection).apply_prospect_assessment_result(
            tenant_id=TENANT_ID,
            discovery_run_id=RUN_ID,
            prospect_id=PROSPECT_ID,
            route="B",
            status="assessed",
            outcome_reason="website_health_low",
            website_ownership="owned",
            normalized_domain="northside.example",
            source_payload={"website_audit": {"final_url": "https://northside.example"}},
            assessment_version="website-health-v1",
            eligible=True,
            computed_route="B",
            total_score=59,
            category_scores={"technical_mobile": 25},
            rule_evidence={"scoring": {"total_score": 59}},
            forced_route_reason=None,
        )

        query = connection.queries[0]
        assert result == row
        assert "WITH assessed AS" in query
        assert "UPDATE business_prospects" in query
        assert "AND status = 'normalized'" in query
        assert "AND website_ownership = 'owned'" in query
        assert "AND route IS NULL" in query
        assert "AND lead_id IS NULL" in query
        assert "INSERT INTO prospect_assessments" in query
        assert "total_score" in query
        assert "category_scores" in query
        assert "ON CONFLICT (tenant_id, discovery_run_id, prospect_id, assessment_version)" in query
        assert "SELECT assessed.*, assessment.assessment_id" in query
        assert connection.args[0][:3] == (TENANT_ID, RUN_ID, PROSPECT_ID)
        assert json.loads(str(connection.args[0][8])) == {
            "website_audit": {"final_url": "https://northside.example"}
        }
        assert json.loads(str(connection.args[0][13])) == {"technical_mobile": 25}
        assert json.loads(str(connection.args[0][14])) == {"scoring": {"total_score": 59}}

    asyncio.run(scenario())


def test_apply_prospect_normalization_with_assessment_is_atomic_and_run_scoped() -> None:
    async def scenario() -> None:
        row = {
            "id": PROSPECT_ID,
            "tenant_id": TENANT_ID,
            "assessment_id": UUID("40000000-0000-0000-0000-000000000001"),
        }
        connection = RecordingConnection(row=row)

        result = await ProspectStore(connection).apply_prospect_normalization_with_assessment(
            tenant_id=TENANT_ID,
            discovery_run_id=RUN_ID,
            prospect_id=PROSPECT_ID,
            normalized_name="northside plumbing",
            normalized_phone="61730000000",
            normalized_domain=None,
            website_ownership="social",
            duplicate_evidence={"phone": ["place-2"]},
            is_franchise=False,
            matched_location_count=1,
            route="A",
            status="assessed",
            outcome_reason="no_owned_website",
            source_payload={
                "resolved_website_url": "https://facebook.com/northside",
                "website_text": "blocked\x00drain",
                "nested": {"title": "north\x00side", "items": ["a\x00b"]},
            },
            assessment_version="route-a-normalization-v1",
            eligible=True,
            computed_route="A",
            rule_evidence={"website": {"ownership": "social"}},
            forced_route_reason="no_owned_website",
        )

        query = connection.queries[0]
        assert result == row
        assert "WITH normalized AS" in query
        assert "UPDATE business_prospects" in query
        assert "AND status = 'discovered'" in query
        assert "AND lead_id IS NULL" in query
        assert "source_payload = $14::jsonb" in query
        assert "INSERT INTO prospect_assessments" in query
        assert "ON CONFLICT (tenant_id, discovery_run_id, prospect_id, assessment_version)" in query
        assert "SELECT normalized.*, assessment.assessment_id" in query
        assert connection.args[0][:3] == (TENANT_ID, RUN_ID, PROSPECT_ID)
        assert json.loads(str(connection.args[0][7])) == {"phone": ["place-2"]}
        assert json.loads(str(connection.args[0][13])) == {
            "resolved_website_url": "https://facebook.com/northside",
            "website_text": "blockeddrain",
            "nested": {"title": "northside", "items": ["ab"]},
        }
        assert json.loads(str(connection.args[0][17])) == {
            "website": {"ownership": "social"}
        }

    asyncio.run(scenario())


def test_transition_discovery_run_enforces_predecessor_and_updates_provider_fields() -> None:
    async def scenario() -> None:
        row = _run_row(status="submitted")
        connection = RecordingConnection(row=row)

        result = await ProspectStore(connection).transition_discovery_run(
            TENANT_ID,
            RUN_ID,
            "submitted",
            source_request_id="request-123",
            provider_usage={"requests": 1},
            discovered_count=12,
        )

        query = connection.queries[0]
        assert result == row
        assert "UPDATE discovery_runs" in query
        assert "WHERE tenant_id = $1" in query
        assert "AND id = $2" in query
        assert "status = ANY($4::text[])" in query
        assert "source_request_id" in query
        assert "provider_usage" in query
        assert connection.args[0][:4] == (TENANT_ID, RUN_ID, "submitted", ("created",))
        assert json.loads(str(connection.args[0][5])) == {"requests": 1}
        assert connection.args[0][8] == 12

    asyncio.run(scenario())


def test_transition_discovery_run_supports_polling_reentry_and_terminal_failure() -> None:
    async def scenario() -> None:
        polling_connection = RecordingConnection(row=_run_row(status="polling"))
        await ProspectStore(polling_connection).transition_discovery_run(
            TENANT_ID, RUN_ID, "polling"
        )
        assert polling_connection.args[0][3] == ("submitted", "polling")

        failed_connection = RecordingConnection(row=_run_row(status="failed"))
        await ProspectStore(failed_connection).transition_discovery_run(
            TENANT_ID,
            RUN_ID,
            "failed",
            failure_code="outscraper_timeout",
            failure_detail="Provider request did not finish within 30 polls",
        )
        assert failed_connection.args[0][3] == (
            "created",
            "submitted",
            "polling",
            "persisted",
            "processing",
        )
        assert failed_connection.args[0][6:8] == (
            "outscraper_timeout",
            "Provider request did not finish within 30 polls",
        )

    asyncio.run(scenario())


def test_transition_discovery_run_rejects_unknown_status_without_querying() -> None:
    async def scenario() -> None:
        connection = RecordingConnection()

        with pytest.raises(ValueError, match="Unsupported discovery run transition"):
            await ProspectStore(connection).transition_discovery_run(
                TENANT_ID, RUN_ID, "unknown"  # type: ignore[arg-type]
            )

        assert connection.queries == []

    asyncio.run(scenario())


def test_transition_discovery_run_returns_none_for_predecessor_or_scope_mismatch() -> None:
    async def scenario() -> None:
        result = await ProspectStore(RecordingConnection()).transition_discovery_run(
            TENANT_ID, RUN_ID, "persisted"
        )

        assert result is None

    asyncio.run(scenario())


def test_upsert_source_prospect_is_tenant_scoped_replay_safe_and_returns_mapping() -> None:
    async def scenario() -> None:
        row = {
            "id": PROSPECT_ID,
            "tenant_id": TENANT_ID,
            "discovery_run_id": RUN_ID,
            "source": "outscraper",
            "source_business_id": "ChIJ-test",
            "status": "assessed",
        }
        connection = RecordingConnection(row=row)

        result = await ProspectStore(connection).upsert_source_prospect(_source_prospect())

        query = connection.queries[0]
        assert result == row
        assert "INSERT INTO business_prospects" in query
        assert "tenant_id" in query
        assert "discovery_run_id" in query
        assert "ON CONFLICT (tenant_id, discovery_run_id, source, source_business_id)" in query
        update_clause = query.split("DO UPDATE SET", maxsplit=1)[1].split(
            "RETURNING", maxsplit=1
        )[0]
        updated_columns = {
            line.strip().split(" =", maxsplit=1)[0]
            for line in update_clause.splitlines()
            if " =" in line
        }
        assert updated_columns.isdisjoint(
            {
                "status",
                "outcome_reason",
                "route",
                "normalized_name",
                "normalized_domain",
                "source_payload_expires_at",
            }
        )
        assert connection.args[0][0:4] == (
            TENANT_ID,
            RUN_ID,
            "outscraper",
            "ChIJ-test",
        )
        assert json.loads(str(connection.args[0][19])) == {
            "place_id": "ChIJ-test",
            "name": "Northside Plumbing",
        }

    asyncio.run(scenario())


def test_upsert_source_prospect_supports_measurable_failed_provider_records() -> None:
    async def scenario() -> None:
        connection = RecordingConnection(
            row={
                "id": PROSPECT_ID,
                "tenant_id": TENANT_ID,
                "discovery_run_id": RUN_ID,
                "source": "outscraper",
                "source_business_id": "invalid:abc123",
                "status": "failed",
            }
        )
        failed = SourceProspectUpsert(
            tenant_id=TENANT_ID,
            discovery_run_id=RUN_ID,
            source_business_id="invalid:abc123",
            business_name="Unknown provider record",
            source_payload={"name": 42},
            status="failed",
            outcome_reason="missing_place_id",
        )

        await ProspectStore(connection).upsert_source_prospect(failed)

        assert connection.args[0][-3:] == ("failed", "missing_place_id", "Unknown provider record")

    asyncio.run(scenario())


def test_refresh_discovery_run_aggregates_is_tenant_scoped() -> None:
    async def scenario() -> None:
        row = _run_row(status="persisted") | {"discovered_count": 12, "usable_count": 10}
        connection = RecordingConnection(row=row)

        result = await ProspectStore(connection).refresh_discovery_run_aggregates(
            TENANT_ID, RUN_ID
        )

        query = connection.queries[0]
        assert result == row
        assert "UPDATE discovery_runs" in query
        assert "FROM business_prospects" in query
        assert "prospect_contacts" in query
        assert "verified_by_route" in query
        assert "apollo_contact_match" in query
        assert "route_a_verified_contact_count" in query
        assert "route_b_verified_contact_count" in query
        assert "cost_reconciliation_required" in query
        assert "tenant_id = $1" in query
        assert "discovery_run_id = $2" in query
        assert "status IN ('normalized', 'assessed', 'contact_enriched', 'review_ready')" in query
        assert connection.args[0] == (TENANT_ID, RUN_ID)

    asyncio.run(scenario())


def test_purge_expired_prospect_data_is_tenant_scoped_and_protects_live_leads() -> None:
    async def scenario() -> None:
        row = {
            "source_payloads_cleared": 2,
            "provider_payloads_cleared": 1,
            "contacts_deleted": 3,
            "assessments_deleted": 3,
            "prospects_deleted": 3,
            "runs_deleted": 1,
            "raw_payload_retention_days": 30,
            "snapshot_retention_days": 90,
        }
        connection = RecordingConnection(row=row)
        now = datetime(2026, 7, 23, 12, 0, tzinfo=UTC)

        result = await ProspectStore(connection).purge_expired_prospect_data(
            tenant_id=TENANT_ID,
            now=now,
            raw_payload_retention_days=30,
            snapshot_retention_days=90,
        )

        query = connection.queries[0]
        assert result == row
        assert "expired_source_payloads AS" in query
        assert "expired_provider_payloads AS" in query
        assert "source_payload = NULL" in query
        assert "provider_payload = NULL" in query
        assert "business_prospects.tenant_id = $1" in query
        assert "prospect_contacts.tenant_id = $1" in query
        assert "discovery_runs.status = 'completed'" in query
        assert "business_prospects.lead_id IS NULL" in query
        assert "'held'" in query
        assert "'rejected'" in query
        assert "'failed'" in query
        assert "review_ready" in query
        assert connection.args[0] == (TENANT_ID, now, 30, 90)

    asyncio.run(scenario())


def test_purge_expired_prospect_data_deletes_children_before_snapshots_and_runs() -> None:
    async def scenario() -> None:
        connection = RecordingConnection(
            row={
                "source_payloads_cleared": 0,
                "provider_payloads_cleared": 0,
                "contacts_deleted": 0,
                "assessments_deleted": 0,
                "prospects_deleted": 0,
                "runs_deleted": 0,
                "raw_payload_retention_days": 30,
                "snapshot_retention_days": 90,
            }
        )

        await ProspectStore(connection).purge_expired_prospect_data(
            tenant_id=TENANT_ID,
            now=datetime(2026, 7, 23, 12, 0, tzinfo=UTC),
            raw_payload_retention_days=30,
            snapshot_retention_days=90,
        )

        query = connection.queries[0]
        assert query.index("deleted_contacts AS") < query.index("deleted_assessments AS")
        assert query.index("deleted_assessments AS") < query.index("deleted_prospects AS")
        assert query.index("deleted_prospects AS") < query.index("deleted_runs AS")
        assert "NOT EXISTS" in query
        assert "FROM business_prospects" in query
        assert "website_previews" not in query
        assert "outreach_sends" not in query
        assert "DELETE FROM leads" not in query
        assert "CASCADE" not in query.upper()

    asyncio.run(scenario())


def test_get_existing_prospect_contact_is_tenant_scoped_by_fingerprint() -> None:
    async def scenario() -> None:
        row = {
            "id": UUID("40000000-0000-0000-0000-000000000001"),
            "tenant_id": TENANT_ID,
            "prospect_id": PROSPECT_ID,
            "provider": "apollo",
            "input_fingerprint": "abc123",
            "status": "verified",
        }
        connection = RecordingConnection(row=row)

        result = await ProspectStore(connection).get_existing_prospect_contact(
            tenant_id=TENANT_ID,
            prospect_id=PROSPECT_ID,
            provider="apollo",
            input_fingerprint="abc123",
        )

        query = connection.queries[0]
        assert result == row
        assert "FROM prospect_contacts" in query
        assert "WHERE tenant_id = $1" in query
        assert "AND prospect_id = $2" in query
        assert "AND provider = $3" in query
        assert "AND input_fingerprint = $4" in query
        assert connection.args[0] == (TENANT_ID, PROSPECT_ID, "apollo", "abc123")

    asyncio.run(scenario())


def test_is_email_suppressed_checks_existing_archived_bounced_and_unsubscribed_contacts() -> None:
    async def scenario() -> None:
        connection = RecordingConnection(row=True)

        result = await ProspectStore(connection).is_email_suppressed(
            tenant_id=TENANT_ID,
            email="alex@northside.example",
        )

        query = connection.queries[0]
        assert result is True
        assert "FROM leads" in query
        assert "FROM outreach_sends" in query
        assert "leads.tenant_id = $1" in query
        assert "outreach_sends.tenant_id = $1" in query
        assert "LOWER(leads.email) = LOWER($2)" in query
        assert "leads.status = 'archived'" in query
        assert "outreach_sends.bounced = TRUE" in query
        assert "outreach_sends.unsubscribed = TRUE" in query
        assert connection.args[0] == (TENANT_ID, "alex@northside.example")

    asyncio.run(scenario())


def test_apply_prospect_contact_result_is_tenant_run_scoped_and_updates_contact_status() -> None:
    async def scenario() -> None:
        row = {
            "id": UUID("40000000-0000-0000-0000-000000000001"),
            "tenant_id": TENANT_ID,
            "prospect_id": PROSPECT_ID,
            "provider": "apollo",
            "input_fingerprint": "abc123",
            "status": "verified",
        }
        connection = RecordingConnection(row=row)

        result = await ProspectStore(connection).apply_prospect_contact_result(
            tenant_id=TENANT_ID,
            discovery_run_id=RUN_ID,
            prospect_id=PROSPECT_ID,
            provider="apollo",
            input_fingerprint="abc123",
            provider_request_id=None,
            provider_organization_id="org-1",
            provider_person_id="person-1",
            person_name="Alex Owner",
            person_title="Owner",
            email="alex@northside.example",
            provider_email_status="verified",
            credits_consumed=None,
            status="verified",
            match_evidence={"strategy": "apollo-owner-verified-v1"},
            provider_payload=None,
        )

        query = connection.queries[0]
        assert result == row
        assert "FROM business_prospects" in query
        assert "WHERE tenant_id = $1" in query
        assert "AND discovery_run_id = $2" in query
        assert "AND id = $3" in query
        assert "route IN ('A', 'B')" in query
        assert "status = 'assessed'" in query
        assert "INSERT INTO prospect_contacts" in query
        assert "ON CONFLICT (tenant_id, prospect_id, provider, input_fingerprint)" in query
        assert "SET status = 'contact_enriched'" in query
        assert connection.args[0][:5] == (TENANT_ID, RUN_ID, PROSPECT_ID, "apollo", "abc123")

    asyncio.run(scenario())

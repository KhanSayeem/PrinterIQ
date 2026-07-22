from __future__ import annotations

import asyncio
import json
from decimal import Decimal
from uuid import UUID

import pytest

from db.queries import ProspectStore, SourceProspectStatus, SourceProspectUpsert

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
RUN_ID = UUID("20000000-0000-0000-0000-000000000001")
PROSPECT_ID = UUID("30000000-0000-0000-0000-000000000001")


class RecordingConnection:
    def __init__(self, *, row: object = None) -> None:
        self.row = row
        self.queries: list[str] = []
        self.args: list[tuple[object, ...]] = []

    async def fetchrow(self, query: str, *args: object) -> object:
        self.queries.append(query)
        self.args.append(args)
        return self.row

    async def fetchval(self, query: str, *args: object) -> object:
        raise AssertionError("ProspectStore should return rows, not scalar values")

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
        assert "tenant_id = $1" in query
        assert "discovery_run_id = $2" in query
        assert connection.args[0] == (TENANT_ID, RUN_ID)

    asyncio.run(scenario())

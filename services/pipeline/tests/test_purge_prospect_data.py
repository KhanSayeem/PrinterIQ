from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID

import pytest

from workers.purge_prospect_data import (
    PurgeProspectDataError,
    cleanup_payload_from_env,
    enqueue_cleanup_from_env,
    purge_prospect_data,
    retention_days_from_env,
)

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")


@dataclass
class Store:
    calls: list[dict[str, object]] = field(default_factory=list)

    async def purge_expired_prospect_data(self, **values: object) -> dict[str, object]:
        self.calls.append(values)
        return {
            "source_payloads_cleared": 2,
            "provider_payloads_cleared": 1,
            "contacts_deleted": 3,
            "assessments_deleted": 3,
            "prospects_deleted": 3,
            "runs_deleted": 1,
            "raw_payload_retention_days": values["raw_payload_retention_days"],
            "snapshot_retention_days": values["snapshot_retention_days"],
        }


def test_purge_worker_runs_tenant_scoped_cleanup_without_activation_dependencies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        store = Store()
        now = datetime(2026, 7, 23, 12, 0, tzinfo=UTC)
        monkeypatch.setenv("PROSPECT_RAW_PAYLOAD_RETENTION_DAYS", "30")
        monkeypatch.setenv("PROSPECT_SNAPSHOT_RETENTION_DAYS", "90")

        result = await purge_prospect_data(
            {"job_type": "purge_prospect_data", "tenant_id": str(TENANT_ID)},
            store=store,
            now=now,
            lead_repository=object(),
            preview_queue=object(),
            outreach_queue=object(),
            instantly_client=object(),
            claude_client=object(),
        )

        assert store.calls == [
            {
                "tenant_id": TENANT_ID,
                "now": now,
                "raw_payload_retention_days": 30,
                "snapshot_retention_days": 90,
            }
        ]
        assert result.source_payloads_cleared == 2
        assert result.provider_payloads_cleared == 1
        assert result.contacts_deleted == 3
        assert result.assessments_deleted == 3
        assert result.prospects_deleted == 3
        assert result.runs_deleted == 1

    asyncio.run(scenario())


def test_retention_days_are_bounded_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PROSPECT_RAW_PAYLOAD_RETENTION_DAYS", raising=False)
    assert (
        retention_days_from_env(
            "PROSPECT_RAW_PAYLOAD_RETENTION_DAYS",
            default=30,
            minimum=1,
            maximum=365,
        )
        == 30
    )

    monkeypatch.setenv("PROSPECT_RAW_PAYLOAD_RETENTION_DAYS", "366")
    with pytest.raises(PurgeProspectDataError, match="between 1 and 365"):
        retention_days_from_env(
            "PROSPECT_RAW_PAYLOAD_RETENTION_DAYS",
            default=30,
            minimum=1,
            maximum=365,
        )

    monkeypatch.setenv("PROSPECT_RAW_PAYLOAD_RETENTION_DAYS", "not-a-number")
    with pytest.raises(PurgeProspectDataError, match="must be an integer"):
        retention_days_from_env(
            "PROSPECT_RAW_PAYLOAD_RETENTION_DAYS",
            default=30,
            minimum=1,
            maximum=365,
        )


def test_cleanup_payload_uses_configured_tenant_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TENANT_ID", str(TENANT_ID))

    assert cleanup_payload_from_env() == {
        "job_type": "purge_prospect_data",
        "tenant_id": str(TENANT_ID),
    }


def test_cleanup_payload_rejects_missing_tenant(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TENANT_ID", raising=False)

    with pytest.raises(PurgeProspectDataError, match="Missing env var: TENANT_ID"):
        cleanup_payload_from_env()


def test_enqueue_cleanup_from_env_pushes_one_purge_job(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        class Redis:
            def __init__(self) -> None:
                self.enqueued: list[str] = []
                self.closed = False

            async def rpush(self, _: str, payload: str) -> None:
                self.enqueued.append(payload)

            async def aclose(self) -> None:
                self.closed = True

        redis = Redis()
        monkeypatch.setattr("workers.purge_prospect_data.load_pipeline_env", lambda: None)
        monkeypatch.setattr("workers.purge_prospect_data.get_redis_client", lambda: redis)
        monkeypatch.setenv("TENANT_ID", str(TENANT_ID))

        payload = await enqueue_cleanup_from_env()

        assert payload == {
            "job_type": "purge_prospect_data",
            "tenant_id": str(TENANT_ID),
        }
        assert redis.enqueued == [
            '{"job_type": "purge_prospect_data", "tenant_id": "'
            + str(TENANT_ID)
            + '"}'
        ]
        assert redis.closed is True

    asyncio.run(scenario())

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol
from uuid import UUID

if __package__ == "src.workers":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from clients.redis_client import get_redis_client
from env import load_pipeline_env

DEFAULT_RAW_PAYLOAD_RETENTION_DAYS = 30
DEFAULT_SNAPSHOT_RETENTION_DAYS = 90
MIN_RAW_PAYLOAD_RETENTION_DAYS = 1
MAX_RAW_PAYLOAD_RETENTION_DAYS = 365
MIN_SNAPSHOT_RETENTION_DAYS = 30
MAX_SNAPSHOT_RETENTION_DAYS = 3650


class PurgeProspectDataError(RuntimeError):
    """Raised when prospect retention cleanup cannot run safely."""


class ProspectRetentionStore(Protocol):
    async def purge_expired_prospect_data(
        self,
        *,
        tenant_id: UUID,
        now: datetime,
        raw_payload_retention_days: int,
        snapshot_retention_days: int,
    ) -> Mapping[str, object]: ...


class ProspectQueue(Protocol):
    async def enqueue(
        self,
        payload: dict[str, object],
        *,
        delay_until: object = None,
    ) -> None: ...


@dataclass(frozen=True)
class PurgeProspectDataResult:
    source_payloads_cleared: int
    provider_payloads_cleared: int
    contacts_deleted: int
    assessments_deleted: int
    prospects_deleted: int
    runs_deleted: int
    raw_payload_retention_days: int
    snapshot_retention_days: int


async def purge_prospect_data(
    payload: dict[str, object],
    *,
    store: ProspectRetentionStore,
    now: datetime | None = None,
    lead_repository: object | None = None,
    preview_queue: object | None = None,
    outreach_queue: object | None = None,
    instantly_client: object | None = None,
    claude_client: object | None = None,
) -> PurgeProspectDataResult:
    del lead_repository, preview_queue, outreach_queue, instantly_client, claude_client
    tenant_id = _tenant_id(payload)
    raw_days = retention_days_from_env(
        "PROSPECT_RAW_PAYLOAD_RETENTION_DAYS",
        default=DEFAULT_RAW_PAYLOAD_RETENTION_DAYS,
        minimum=MIN_RAW_PAYLOAD_RETENTION_DAYS,
        maximum=MAX_RAW_PAYLOAD_RETENTION_DAYS,
    )
    snapshot_days = retention_days_from_env(
        "PROSPECT_SNAPSHOT_RETENTION_DAYS",
        default=DEFAULT_SNAPSHOT_RETENTION_DAYS,
        minimum=MIN_SNAPSHOT_RETENTION_DAYS,
        maximum=MAX_SNAPSHOT_RETENTION_DAYS,
    )
    row = await store.purge_expired_prospect_data(
        tenant_id=tenant_id,
        now=now or datetime.now(UTC),
        raw_payload_retention_days=raw_days,
        snapshot_retention_days=snapshot_days,
    )
    return PurgeProspectDataResult(
        source_payloads_cleared=_count(row, "source_payloads_cleared"),
        provider_payloads_cleared=_count(row, "provider_payloads_cleared"),
        contacts_deleted=_count(row, "contacts_deleted"),
        assessments_deleted=_count(row, "assessments_deleted"),
        prospects_deleted=_count(row, "prospects_deleted"),
        runs_deleted=_count(row, "runs_deleted"),
        raw_payload_retention_days=_count(row, "raw_payload_retention_days"),
        snapshot_retention_days=_count(row, "snapshot_retention_days"),
    )


def retention_days_from_env(
    name: str,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    raw_value = os.getenv(name)
    if raw_value is None or not raw_value.strip():
        return default
    try:
        value = int(raw_value)
    except ValueError as error:
        raise PurgeProspectDataError(f"{name} must be an integer") from error
    if not minimum <= value <= maximum:
        raise PurgeProspectDataError(f"{name} must be between {minimum} and {maximum}")
    return value


def cleanup_payload_from_env() -> dict[str, object]:
    raw_tenant_id = os.getenv("TENANT_ID")
    if raw_tenant_id is None or not raw_tenant_id.strip():
        raise PurgeProspectDataError("Missing env var: TENANT_ID")
    tenant_id = UUID(raw_tenant_id)
    return {"job_type": "purge_prospect_data", "tenant_id": str(tenant_id)}


async def enqueue_cleanup_from_env() -> dict[str, object]:
    load_pipeline_env()
    payload = cleanup_payload_from_env()
    redis = get_redis_client()
    try:
        from workers.orchestrator import RedisPipelineQueue

        await RedisPipelineQueue(redis).enqueue(payload)
    finally:
        await redis.aclose()
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Enqueue tenant-scoped prospect cleanup")
    parser.add_argument(
        "--enqueue",
        action="store_true",
        help="enqueue one purge_prospect_data job for TENANT_ID",
    )
    args = parser.parse_args()
    if not args.enqueue:
        parser.error("--enqueue is required; direct hosted cleanup is intentionally disabled")
    payload = asyncio.run(enqueue_cleanup_from_env())
    print(json.dumps(payload, sort_keys=True))


def _tenant_id(payload: Mapping[str, object]) -> UUID:
    try:
        return UUID(str(payload["tenant_id"]))
    except (KeyError, ValueError) as error:
        raise PurgeProspectDataError("Invalid purge_prospect_data tenant_id") from error


def _count(row: Mapping[str, object], key: str) -> int:
    value = row.get(key, 0)
    return int(str(value))


if __name__ == "__main__":
    main()

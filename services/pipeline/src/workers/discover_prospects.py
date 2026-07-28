from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Protocol
from uuid import UUID

from clients.outscraper_client import (
    OutscraperAPIError,
    OutscraperClient,
    OutscraperRequest,
    OutscraperRetryableError,
)
from db.queries import SourceProspectUpsert

APPROVED_CATEGORIES = ("Plumber", "Drainage service", "Gas fitter")
APPROVED_LOCALITIES = ("Brisbane", "Logan", "Ipswich", "Moreton Bay", "Redlands")
APPROVED_DISCOVERY_QUERIES = tuple(
    f"{category} {locality} QLD"
    for category in APPROVED_CATEGORIES
    for locality in APPROVED_LOCALITIES
)
DISCOVERY_TOTAL_LIMIT = 500
MAX_PROVIDER_POLLS = 30
MAX_POLL_TRANSPORT_ATTEMPTS = 5


class DiscoveryRunError(RuntimeError):
    """Raised when a discovery job cannot safely advance its run."""


class ProspectRepository(Protocol):
    async def get_discovery_run(
        self, *, tenant_id: UUID, discovery_run_id: UUID
    ) -> Mapping[str, object] | None: ...

    async def transition_discovery_run(
        self, **values: object
    ) -> Mapping[str, object] | None: ...

    async def upsert_source_prospect(
        self, snapshot: SourceProspectUpsert
    ) -> Mapping[str, object]: ...


class ProspectQueue(Protocol):
    async def enqueue(
        self,
        payload: dict[str, object],
        *,
        delay_until: datetime | None = None,
    ) -> None: ...


class OutscraperProvider(Protocol):
    async def submit_google_maps_search(
        self, queries: list[str], total_limit: int
    ) -> OutscraperRequest: ...

    async def get_request(self, request_id: str) -> OutscraperRequest: ...


async def start_discovery(
    payload: dict[str, object],
    *,
    store: ProspectRepository,
    queue: ProspectQueue,
    outscraper_client: OutscraperProvider,
    now: Callable[[], datetime] | None = None,
    poll_seconds: int = 30,
    raw_retention_days: int = 30,
) -> None:
    tenant_id, run_id = _run_identity(payload)
    run = await store.get_discovery_run(tenant_id=tenant_id, discovery_run_id=run_id)
    if run is None:
        raise DiscoveryRunError("Discovery run not found for tenant")

    request_id = run.get("source_request_id")
    if isinstance(request_id, str) and request_id:
        await _schedule_poll(
            store=store,
            queue=queue,
            tenant_id=tenant_id,
            run_id=run_id,
            poll_count=1,
            now=(now or _utc_now)(),
            poll_seconds=poll_seconds,
        )
        return
    if run.get("status") == "submitted":
        await _fail_run(
            store,
            tenant_id=tenant_id,
            run_id=run_id,
            failure_code="outscraper_submission_uncertain",
            failure_detail="Outscraper submission outcome requires provider reconciliation.",
        )
        return
    if run.get("status") != "created":
        raise DiscoveryRunError("Discovery run is not eligible for provider submission")

    await _transition_or_raise(
        store,
        tenant_id=tenant_id,
        discovery_run_id=run_id,
        to_status="submitted",
    )
    try:
        response = await outscraper_client.submit_google_maps_search(
            list(APPROVED_DISCOVERY_QUERIES), DISCOVERY_TOTAL_LIMIT
        )
    except Exception:
        await _fail_run(
            store,
            tenant_id=tenant_id,
            run_id=run_id,
            failure_code="outscraper_submission_uncertain",
            failure_detail="Outscraper submission outcome requires provider reconciliation.",
        )
        return
    await _handle_provider_response(
        response,
        tenant_id=tenant_id,
        run_id=run_id,
        store=store,
        queue=queue,
        now=(now or _utc_now)(),
        poll_count=0,
        poll_seconds=poll_seconds,
        raw_retention_days=raw_retention_days,
        record_request_id=True,
    )


async def poll_outscraper(
    payload: dict[str, object],
    *,
    store: ProspectRepository,
    queue: ProspectQueue,
    outscraper_client: OutscraperProvider,
    now: Callable[[], datetime] | None = None,
    poll_seconds: int = 30,
    raw_retention_days: int = 30,
) -> None:
    tenant_id, run_id = _run_identity(payload)
    poll_count = _poll_count(payload)
    run = await store.get_discovery_run(tenant_id=tenant_id, discovery_run_id=run_id)
    if run is None:
        raise DiscoveryRunError("Discovery run not found for tenant")
    request_id = run.get("source_request_id")
    if not isinstance(request_id, str) or not request_id:
        raise DiscoveryRunError("Discovery run has no provider request id")

    status = run.get("status")
    if status == "persisted":
        await _enqueue_normalization(queue, tenant_id=tenant_id, run_id=run_id)
        return
    if status in {"processing", "review_ready", "completed", "failed"}:
        return
    if status != "polling":
        raise DiscoveryRunError("Discovery run is not eligible for provider polling")

    if poll_count >= MAX_PROVIDER_POLLS:
        await _fail_run(
            store,
            tenant_id=tenant_id,
            run_id=run_id,
            failure_code="outscraper_timeout",
            failure_detail="Outscraper did not complete within the polling limit.",
        )
        return

    try:
        response = await outscraper_client.get_request(request_id)
    except OutscraperRetryableError:
        if _attempt_count(payload) < MAX_POLL_TRANSPORT_ATTEMPTS:
            raise
        await _fail_run(
            store,
            tenant_id=tenant_id,
            run_id=run_id,
            failure_code="outscraper_transport_exhausted",
            failure_detail="Outscraper polling failed after bounded transport retries.",
        )
        return
    except OutscraperAPIError:
        await _fail_run(
            store,
            tenant_id=tenant_id,
            run_id=run_id,
            failure_code="outscraper_request_rejected",
            failure_detail="Outscraper rejected the poll request or returned an invalid response.",
        )
        return
    if response.request_id != request_id:
        await _fail_run(
            store,
            tenant_id=tenant_id,
            run_id=run_id,
            failure_code="outscraper_request_mismatch",
            failure_detail="Outscraper returned a response for a different provider request.",
        )
        return
    await _handle_provider_response(
        response,
        tenant_id=tenant_id,
        run_id=run_id,
        store=store,
        queue=queue,
        now=(now or _utc_now)(),
        poll_count=poll_count,
        poll_seconds=poll_seconds,
        raw_retention_days=raw_retention_days,
        record_request_id=False,
    )


async def _handle_provider_response(
    response: OutscraperRequest,
    *,
    tenant_id: UUID,
    run_id: UUID,
    store: ProspectRepository,
    queue: ProspectQueue,
    now: datetime,
    poll_count: int,
    poll_seconds: int,
    raw_retention_days: int,
    record_request_id: bool,
) -> None:
    if response.status == "Pending":
        if not response.request_id:
            await _fail_run(
                store,
                tenant_id=tenant_id,
                run_id=run_id,
                failure_code="outscraper_missing_request_id",
                failure_detail="Outscraper did not return a usable provider request id.",
            )
            return
        await _schedule_poll(
            store=store,
            queue=queue,
            tenant_id=tenant_id,
            run_id=run_id,
            poll_count=poll_count + 1,
            now=now,
            poll_seconds=poll_seconds,
            source_request_id=response.request_id if record_request_id else None,
        )
        return
    if response.status == "Failure":
        await _fail_run(
            store,
            tenant_id=tenant_id,
            run_id=run_id,
            failure_code="outscraper_provider_failure",
            failure_detail="Outscraper reported a terminal failure.",
        )
        return
    if record_request_id:
        await _transition_or_raise(
            store,
            tenant_id=tenant_id,
            discovery_run_id=run_id,
            to_status="polling",
            source_request_id=response.request_id,
        )

    persisted_identities: set[str] = set()
    for record in response.data:
        snapshot = _source_snapshot(
            record,
            tenant_id=tenant_id,
            run_id=run_id,
            now=now,
            raw_retention_days=raw_retention_days,
        )
        if snapshot.source_business_id in persisted_identities:
            continue
        await store.upsert_source_prospect(
            snapshot
        )
        persisted_identities.add(snapshot.source_business_id)
        if len(persisted_identities) == DISCOVERY_TOTAL_LIMIT:
            break
    await _transition_or_raise(
        store,
        tenant_id=tenant_id,
        discovery_run_id=run_id,
        to_status="persisted",
        discovered_count=len(persisted_identities),
    )
    await _enqueue_normalization(queue, tenant_id=tenant_id, run_id=run_id)


async def _enqueue_normalization(
    queue: ProspectQueue, *, tenant_id: UUID, run_id: UUID
) -> None:
    await queue.enqueue(
        {
            "job_type": "normalize_prospects",
            "tenant_id": str(tenant_id),
            "discovery_run_id": str(run_id),
        }
    )


async def _schedule_poll(
    *,
    store: ProspectRepository,
    queue: ProspectQueue,
    tenant_id: UUID,
    run_id: UUID,
    poll_count: int,
    now: datetime,
    poll_seconds: int,
    source_request_id: str | None = None,
) -> None:
    await _transition_or_raise(
        store,
        tenant_id=tenant_id,
        discovery_run_id=run_id,
        to_status="polling",
        source_request_id=source_request_id,
    )
    await queue.enqueue(
        {
            "job_type": "poll_outscraper",
            "tenant_id": str(tenant_id),
            "discovery_run_id": str(run_id),
            "poll_count": poll_count,
        },
        delay_until=now + timedelta(seconds=poll_seconds),
    )


async def _fail_run(
    store: ProspectRepository,
    *,
    tenant_id: UUID,
    run_id: UUID,
    failure_code: str,
    failure_detail: str,
) -> None:
    await _transition_or_raise(
        store,
        tenant_id=tenant_id,
        discovery_run_id=run_id,
        to_status="failed",
        failure_code=failure_code,
        failure_detail=failure_detail,
    )


async def _transition_or_raise(store: ProspectRepository, **values: object) -> None:
    if not await store.transition_discovery_run(**values):
        raise DiscoveryRunError("Discovery run transition was rejected")


def _source_snapshot(
    record: dict[str, object],
    *,
    tenant_id: UUID,
    run_id: UUID,
    now: datetime,
    raw_retention_days: int,
) -> SourceProspectUpsert:
    place_id = record.get("place_id")
    if isinstance(place_id, str) and place_id.strip():
        valid_place_id = True
        source_business_id = place_id.strip()
    else:
        valid_place_id = False
        source_business_id = _invalid_identity(record)
    raw_name = record.get("name")
    business_name = (
        raw_name.strip()
        if isinstance(raw_name, str) and raw_name.strip()
        else "(invalid provider record)"
    )
    return SourceProspectUpsert(
        tenant_id=tenant_id,
        discovery_run_id=run_id,
        source_business_id=source_business_id,
        business_name=business_name,
        normalized_name=" ".join(business_name.lower().split()),
        primary_category=_string_field(record, "category"),
        additional_categories=_string_list_field(record.get("subtypes")),
        phone=_string_field(record, "phone"),
        full_address=_string_field(record, "full_address"),
        locality=_string_field(record, "city"),
        state=_string_field(record, "state"),
        postcode=_string_field(record, "postal_code") or _string_field(record, "postcode"),
        latitude=_decimal_field(record, "latitude"),
        longitude=_decimal_field(record, "longitude"),
        business_status=_string_field(record, "business_status"),
        rating=_decimal_field(record, "rating"),
        review_count=_int_field(record, "reviews") or _int_field(record, "review_count"),
        google_profile_url=_string_field(record, "location_link"),
        source_website_url=_string_field(record, "site") or _string_field(record, "website"),
        source_payload=record,
        source_payload_expires_at=now + timedelta(days=raw_retention_days),
        status="discovered" if valid_place_id else "failed",
        outcome_reason=None if valid_place_id else "missing_place_id",
    )


def _string_field(record: Mapping[str, object], key: str) -> str | None:
    value = record.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _string_list_field(value: object) -> tuple[str, ...]:
    if isinstance(value, str):
        return tuple(part.strip() for part in value.split(",") if part.strip())
    if isinstance(value, (list, tuple)):
        return tuple(str(part).strip() for part in value if str(part).strip())
    return ()


def _decimal_field(record: Mapping[str, object], key: str) -> Decimal | None:
    value = record.get(key)
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _int_field(record: Mapping[str, object], key: str) -> int | None:
    value = record.get(key)
    if value is None:
        return None
    try:
        return int(str(value))
    except ValueError:
        return None


def _invalid_identity(record: dict[str, object]) -> str:
    canonical = json.dumps(record, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"invalid:{digest}"


def _run_identity(payload: Mapping[str, object]) -> tuple[UUID, UUID]:
    try:
        return UUID(str(payload["tenant_id"])), UUID(str(payload["discovery_run_id"]))
    except (KeyError, ValueError) as error:
        raise DiscoveryRunError("Invalid discovery job identity") from error


def _poll_count(payload: Mapping[str, object]) -> int:
    try:
        value = int(str(payload["poll_count"]))
    except (KeyError, ValueError) as error:
        raise DiscoveryRunError("Invalid discovery poll count") from error
    if value < 1:
        raise DiscoveryRunError("Invalid discovery poll count")
    return value


def _attempt_count(payload: Mapping[str, object]) -> int:
    try:
        return int(str(payload.get("attempt_count", 1)))
    except ValueError as error:
        raise DiscoveryRunError("Invalid discovery attempt count") from error


def _utc_now() -> datetime:
    return datetime.now(UTC)


def production_outscraper_client() -> OutscraperClient:
    return OutscraperClient.from_env()

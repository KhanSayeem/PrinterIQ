from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Protocol
from uuid import UUID

from db.queries import QueueJobInsert, QueueJobLease, QueueJobUpdate
from pipeline_queue.dead_letter import should_dead_letter
from pipeline_queue.definitions import JobType

Payload = Mapping[str, object]
type JobHandler[ResultT] = Callable[[dict[str, object]], Awaitable[ResultT]]


class QueueJobRepository(Protocol):
    async def create_queue_job(self, insert: QueueJobInsert) -> QueueJobLease:
        """Persist the running queue job and return its database id."""

    async def update_queue_job(self, update: QueueJobUpdate) -> None:
        """Persist the terminal queue job state."""


class MissingTenantIdError(ValueError):
    """Raised when a queue payload lacks tenant_id."""


class InvalidQueuePayloadError(ValueError):
    """Raised when a queue payload contains malformed identifiers."""


class QueueLeaseUnavailableError(RuntimeError):
    """Raised when a recovery-sensitive job must be retried after its active lease ages."""


async def run_tracked_job[ResultT](
    store: QueueJobRepository,
    *,
    job_type: JobType,
    payload: Payload,
    handler: JobHandler[ResultT],
    attempt_count: int = 1,
    max_attempts: int = 5,
    retry_if_unavailable: bool = False,
    recover_stale_active: bool = False,
) -> ResultT | None:
    normalised_payload = dict(payload)
    tenant_id = _required_uuid(normalised_payload, "tenant_id")
    lead_id = _optional_uuid(normalised_payload, "lead_id")

    lease = await store.create_queue_job(
        QueueJobInsert(
            job_type=job_type.value,
            tenant_id=tenant_id,
            lead_id=lead_id,
            payload=normalised_payload,
            max_attempts=max_attempts,
            attempt_count=attempt_count,
            recover_stale_active=recover_stale_active,
        )
    )
    if not lease.acquired:
        if retry_if_unavailable:
            raise QueueLeaseUnavailableError("Queue job lease is still active")
        return None

    try:
        result = await handler(normalised_payload)
    except Exception as exc:
        await store.update_queue_job(
            QueueJobUpdate(
                job_id=lease.job_id,
                tenant_id=tenant_id,
                status="dead" if should_dead_letter(attempt_count, max_attempts) else "failed",
                attempt_count=attempt_count,
                error_message=str(exc),
                lease_started_at=lease.lease_started_at,
            )
        )
        raise

    await store.update_queue_job(
        QueueJobUpdate(
            job_id=lease.job_id,
            tenant_id=tenant_id,
            status="completed",
            attempt_count=attempt_count,
            error_message=None,
            lease_started_at=lease.lease_started_at,
        )
    )
    return result


def _required_uuid(payload: dict[str, object], field_name: str) -> UUID:
    value = payload.get(field_name)
    if value is None:
        if field_name == "tenant_id":
            raise MissingTenantIdError("Queue payload must include tenant_id")
        raise InvalidQueuePayloadError(f"Queue payload must include {field_name}")
    return _coerce_uuid(value, field_name)


def _optional_uuid(payload: dict[str, object], field_name: str) -> UUID | None:
    value = payload.get(field_name)
    if value is None:
        return None
    return _coerce_uuid(value, field_name)


def _coerce_uuid(value: object, field_name: str) -> UUID:
    if isinstance(value, UUID):
        return value
    if isinstance(value, str):
        try:
            return UUID(value)
        except ValueError as exc:
            message = f"Queue payload {field_name} is not a valid UUID"
            raise InvalidQueuePayloadError(message) from exc
    raise InvalidQueuePayloadError(f"Queue payload {field_name} must be a UUID string")

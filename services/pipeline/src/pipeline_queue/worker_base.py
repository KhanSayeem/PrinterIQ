from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Protocol
from uuid import UUID

from db.queries import QueueJobInsert, QueueJobLease, QueueJobUpdate
from pipeline_queue.dead_letter import should_dead_letter
from pipeline_queue.definitions import JobType

Payload = Mapping[str, object]
type JobHandler[ResultT] = Callable[[dict[str, object]], Awaitable[ResultT]]

logger = logging.getLogger(__name__)

# How long a cancelled handler gets to unwind before the slot is taken back
# anyway. `asyncio.wait_for` waits indefinitely for cancellation to be
# honoured, so a coroutine that swallows CancelledError would hang the
# watchdog itself and the slot would stay lost. Five seconds is generous for
# closing a Playwright browser or an httpx connection.
CANCELLATION_GRACE_SECONDS = 5.0


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


class JobWatchdogTimeoutError(TimeoutError):
    """Raised when a handler outran its watchdog budget and was cancelled.

    A distinct type so a watchdog kill is never confused with a handler that
    raised its own TimeoutError from an inner `httpx` or `asyncio.wait_for`
    call. The two need different responses and identical error text would
    make the incident unreadable in `queue_jobs.error_message`.
    """


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
    timeout_seconds: float | None = None,
) -> ResultT | None:
    """Run one job under its lease, and under a watchdog when given a budget.

    `timeout_seconds` is what stops a single hung job owning a concurrency
    slot forever. On 2026-08-25 five jobs took all five slots and never
    returned; because a slot is only released when its handler returns, job
    number six was never picked up and the queue sat at 3,321 for two weeks
    while PM2 reported the process healthy.
    """
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
        result = await _run_under_watchdog(
            handler,
            normalised_payload,
            job_type=job_type,
            timeout_seconds=timeout_seconds,
        )
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


async def _run_under_watchdog[ResultT](
    handler: JobHandler[ResultT],
    payload: dict[str, object],
    *,
    job_type: JobType,
    timeout_seconds: float | None,
) -> ResultT:
    """Await the handler, cancelling it if it outruns its budget.

    Deliberately not `asyncio.wait_for`. Two reasons, both learned from the
    incident this exists to prevent:

    1. `wait_for` raises the same builtin TimeoutError a handler can raise from
       its own inner timeout, so the two would be indistinguishable in
       `queue_jobs.error_message`. Here only our own expiry produces
       `JobWatchdogTimeoutError`.
    2. `wait_for` waits forever for the cancellation to be honoured. A
       coroutine that swallows CancelledError would wedge the watchdog exactly
       the way the original jobs wedged the worker. Here the task is given
       CANCELLATION_GRACE_SECONDS and then abandoned so the slot is returned
       regardless.

    An abandoned task keeps whatever it is holding. That is a leak, and it is
    still strictly better than a permanently lost concurrency slot: the worker
    keeps draining the queue, and the stall monitor is the backstop for the
    case where the event loop itself is blocked and no cancellation can be
    delivered at all.
    """
    if timeout_seconds is None:
        return await handler(payload)

    task = asyncio.ensure_future(handler(payload))
    done, _ = await asyncio.wait({task}, timeout=timeout_seconds)
    if task in done:
        return task.result()

    task.cancel()
    await asyncio.wait({task}, timeout=CANCELLATION_GRACE_SECONDS)
    if not task.done():
        logger.error(
            "Watchdog cancellation was not honoured; abandoning task to free the slot",
            extra={"job_type": job_type.value},
        )
        task.add_done_callback(_discard_task_result)
    raise JobWatchdogTimeoutError(
        f"{job_type.value} exceeded its {timeout_seconds:g}s watchdog timeout and was cancelled"
    )


def _discard_task_result(task: asyncio.Task[Any]) -> None:
    """Retrieve the result of an abandoned task so asyncio does not warn."""
    if task.cancelled():
        return
    task.exception()


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

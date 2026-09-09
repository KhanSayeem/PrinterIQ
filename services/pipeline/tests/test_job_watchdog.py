from __future__ import annotations

import asyncio
import contextlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID

import pytest

from db.queries import QueueJobInsert, QueueJobLease, QueueJobUpdate
from pipeline_queue.definitions import PIPELINE_JOB_TYPES, JobType
from pipeline_queue.worker_base import JobWatchdogTimeoutError, run_tracked_job
from workers.orchestrator import (
    BATCH_WATCHDOG_TIMEOUT_SECONDS,
    STALE_ACTIVE_MIN_AGE_SECONDS,
    WATCHDOG_TIMEOUT_SECONDS,
    PipelineQueueManager,
    QueueMessage,
    RedisPipelineQueue,
    watchdog_timeouts_by_job_type,
)

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
LEAD_ID = UUID("20000000-0000-0000-0000-000000000002")
LEASE_STARTED_AT = datetime(2026, 9, 8, 9, 0, tzinfo=UTC)

# Slowest job ever recorded on the live database, over 16,000 completed rows:
# ingest_csv at 100 seconds, enrich_lead at 61 and qualify_lead at 34. The
# watchdog has to sit far above this and far below two weeks.
SLOWEST_OBSERVED_JOB_SECONDS = 100


@dataclass
class FakeQueueStore:
    inserts: list[QueueJobInsert] = field(default_factory=list)
    updates: list[QueueJobUpdate] = field(default_factory=list)
    next_job_id: UUID = UUID("30000000-0000-0000-0000-000000000003")
    acquired: bool = True

    async def create_queue_job(self, insert: QueueJobInsert) -> QueueJobLease:
        self.inserts.append(insert)
        return QueueJobLease(
            job_id=self.next_job_id,
            acquired=self.acquired,
            lease_started_at=LEASE_STARTED_AT,
        )

    async def update_queue_job(self, update: QueueJobUpdate) -> None:
        self.updates.append(update)


@dataclass
class FakeQueueTransport:
    payloads: list[dict[str, object]] = field(default_factory=list)
    enqueued: list[tuple[dict[str, object], datetime | None]] = field(default_factory=list)
    acked: list[QueueMessage] = field(default_factory=list)
    recovery_calls: int = 0
    reclaim_calls: list[float] = field(default_factory=list)

    async def recover_active(self) -> int:
        self.recovery_calls += 1
        return 0

    async def reclaim_stale_active(self, *, min_age_seconds: float) -> int:
        self.reclaim_calls.append(min_age_seconds)
        return 0

    async def pop(self) -> QueueMessage | None:
        if not self.payloads:
            return None
        payload = self.payloads.pop(0)
        return QueueMessage(payload=payload, ack_token=str(len(self.acked)))

    async def enqueue(
        self,
        payload: dict[str, object],
        *,
        delay_until: datetime | None = None,
    ) -> None:
        self.enqueued.append((payload, delay_until))

    async def ack(self, message: QueueMessage) -> None:
        self.acked.append(message)


class FakeRedis:
    def __init__(self) -> None:
        self.wait_key = "bull:pipeline:wait"
        self.active_key = "bull:pipeline:active"
        self.lists: dict[str, list[str]] = {self.wait_key: [], self.active_key: []}

    async def rpoplpush(self, source: str, destination: str) -> str | None:
        if not self.lists.get(source):
            return None
        item = self.lists[source].pop()
        self.lists.setdefault(destination, []).insert(0, item)
        return item

    async def rpush(self, key: str, item: str) -> None:
        self.lists.setdefault(key, []).append(item)

    async def lrem(self, key: str, count: int, item: str) -> None:
        assert count == 1
        self.lists[key].remove(item)

    async def lrange(self, key: str, start: int, end: int) -> list[str]:
        values = self.lists.get(key, [])
        if end == -1:
            return values[start:]
        return values[start : end + 1]

    async def zrangebyscore(self, key: str, minimum: int, maximum: int) -> list[str]:
        del key, minimum, maximum
        return []

    async def delete(self, key: str) -> None:
        del key


def _lead_payload(job_type: JobType, marker: str) -> dict[str, object]:
    return {
        "job_type": job_type.value,
        "tenant_id": str(TENANT_ID),
        "lead_id": str(LEAD_ID),
        "marker": marker,
    }


def test_hung_job_releases_its_concurrency_slot_for_the_next_job() -> None:
    """The mechanism behind the August deadlock, reproduced and then broken.

    `PIPELINE_CONCURRENCY` is 5, so five hung handlers occupy every slot. In
    August all five awaited something that never returned, and because a slot
    is only released when its handler returns, job number six was never picked
    up. Two weeks and 3,321 queued jobs later the process was still `online`.

    Five hung jobs are started here and a sixth is left waiting behind them.
    Without the watchdog the sixth is unreachable, which is exactly what the
    incident looked like from the outside.
    """

    async def scenario() -> None:
        processed: list[str] = []
        hung_started = 0

        async def hang(payload: dict[str, object]) -> None:
            nonlocal hung_started
            if payload["marker"] == "healthy":
                processed.append("healthy")
                return
            hung_started += 1
            await asyncio.Event().wait()

        transport = FakeQueueTransport(
            payloads=[
                *(_lead_payload(JobType.ENRICH_LEAD, f"hung-{index}") for index in range(5)),
                _lead_payload(JobType.ENRICH_LEAD, "healthy"),
            ]
        )
        store = FakeQueueStore()
        manager = PipelineQueueManager(
            queue=transport,
            store=store,
            handlers={JobType.ENRICH_LEAD: hang},
            concurrency=5,
            watchdog_timeouts={JobType.ENRICH_LEAD: 0.05},
        )

        wedged = await asyncio.gather(*(manager.run_once() for _ in range(5)))

        assert hung_started == 5
        assert all(wedged)
        assert processed == []

        assert await manager.run_once() is True
        assert processed == ["healthy"]

        watchdog_failures = [
            update
            for update in store.updates
            if update.error_message is not None and "watchdog" in update.error_message
        ]
        assert len(watchdog_failures) == 5
        assert {update.status for update in watchdog_failures} == {"failed"}

    asyncio.run(scenario())


def test_hung_job_is_requeued_for_another_attempt() -> None:
    """A cancelled job is a retryable job, not a lost lead.

    The lead behind a hung enrich has done nothing wrong. The queue already
    knows how to retry, so the watchdog failure travels the ordinary retry
    path and the lead comes back with `attempt_count` incremented rather than
    being dropped on the floor.
    """

    async def scenario() -> None:
        async def hang(_: dict[str, object]) -> None:
            await asyncio.Event().wait()

        transport = FakeQueueTransport(payloads=[_lead_payload(JobType.ENRICH_LEAD, "hung")])
        manager = PipelineQueueManager(
            queue=transport,
            store=FakeQueueStore(),
            handlers={JobType.ENRICH_LEAD: hang},
            watchdog_timeouts={JobType.ENRICH_LEAD: 0.05},
        )

        assert await manager.run_once() is True

        assert len(transport.enqueued) == 1
        retried_payload, delay_until = transport.enqueued[0]
        assert retried_payload["attempt_count"] == 2
        assert delay_until is None
        assert len(transport.acked) == 1

    asyncio.run(scenario())


def test_slow_but_finishing_job_is_left_alone() -> None:
    """Legitimately slow work must survive.

    A Playwright load against a dead domain takes up to 30 seconds per attempt
    and enrich_lead makes two attempts, which is why the real budget is
    minutes rather than seconds. A watchdog that killed slow work would turn
    every dead domain into a dead-lettered lead.
    """

    async def scenario() -> None:
        completed: list[str] = []

        async def slow(_: dict[str, object]) -> None:
            await asyncio.sleep(0.05)
            completed.append("done")

        transport = FakeQueueTransport(payloads=[_lead_payload(JobType.ENRICH_LEAD, "slow")])
        store = FakeQueueStore()
        manager = PipelineQueueManager(
            queue=transport,
            store=store,
            handlers={JobType.ENRICH_LEAD: slow},
            watchdog_timeouts={JobType.ENRICH_LEAD: 5.0},
        )

        assert await manager.run_once() is True
        assert completed == ["done"]
        assert [update.status for update in store.updates] == ["completed"]
        assert transport.enqueued == []

    asyncio.run(scenario())


def test_run_tracked_job_records_the_watchdog_failure_against_the_lease() -> None:
    """The database lease has to be released too, not just the slot.

    `queue_jobs` still holds rows stuck in `active` since 2026-08-25 20:14
    because the process died holding them. A job that ends on the watchdog
    must close its own row, or the same unique index that guards duplicate
    work would refuse the retry for the next ten minutes.
    """

    async def scenario() -> None:
        store = FakeQueueStore()

        async def hang(_: dict[str, object]) -> None:
            await asyncio.Event().wait()

        with pytest.raises(JobWatchdogTimeoutError, match="watchdog"):
            await run_tracked_job(
                store,
                job_type=JobType.QUALIFY_LEAD,
                payload={"tenant_id": str(TENANT_ID), "lead_id": str(LEAD_ID)},
                handler=hang,
                attempt_count=1,
                max_attempts=3,
                timeout_seconds=0.05,
            )

        assert len(store.updates) == 1
        assert store.updates[0].status == "failed"
        assert store.updates[0].job_id == store.next_job_id
        assert store.updates[0].tenant_id == TENANT_ID

    asyncio.run(scenario())


def test_final_watchdog_attempt_dead_letters_rather_than_looping() -> None:
    """A permanently hung job type must not retry forever."""

    async def scenario() -> None:
        store = FakeQueueStore()

        async def hang(_: dict[str, object]) -> None:
            await asyncio.Event().wait()

        with pytest.raises(JobWatchdogTimeoutError):
            await run_tracked_job(
                store,
                job_type=JobType.QUALIFY_LEAD,
                payload={"tenant_id": str(TENANT_ID), "lead_id": str(LEAD_ID)},
                handler=hang,
                attempt_count=3,
                max_attempts=3,
                timeout_seconds=0.05,
            )

        assert store.updates[0].status == "dead"

    asyncio.run(scenario())


def test_every_pipeline_job_type_has_a_watchdog_budget() -> None:
    """A job type with no budget is a job type that can wedge the worker.

    Parity with `max_attempts_by_job_type` is deliberate: adding a job type
    without a timeout would silently reintroduce the incident for that type
    only, and nothing else in the system would notice.
    """
    timeouts = watchdog_timeouts_by_job_type()

    assert set(timeouts) == set(PIPELINE_JOB_TYPES)
    assert all(seconds > 0 for seconds in timeouts.values())


def test_watchdog_budgets_clear_the_slowest_work_production_has_produced() -> None:
    """The numbers, justified against measured production durations.

    Lead-scoped jobs get 15 minutes. The slowest single job ever recorded on
    this database is 100 seconds (ingest_csv), enrich_lead peaks at 61 and
    qualify_lead at 34, so 15 minutes is nine times the worst case ever seen
    and it clears one full Anthropic SDK read timeout (600 seconds) as well.

    Batch prospect jobs get 4 hours. `assess_prospects` walks every prospect
    in a discovery run, up to PROSPECT_DISCOVERY_TOTAL_LIMIT of 500, and each
    one can spend two Playwright attempts of 30 seconds on a dead domain. Four
    hours covers 240 consecutive worst-case audits, and the job resumes where
    it left off when it is retried because assessed rows are skipped.
    """
    timeouts = watchdog_timeouts_by_job_type()

    assert timeouts[JobType.ENRICH_LEAD] == WATCHDOG_TIMEOUT_SECONDS
    assert timeouts[JobType.QUALIFY_LEAD] == WATCHDOG_TIMEOUT_SECONDS
    assert timeouts[JobType.ASSESS_PROSPECTS] == BATCH_WATCHDOG_TIMEOUT_SECONDS
    assert WATCHDOG_TIMEOUT_SECONDS >= 9 * SLOWEST_OBSERVED_JOB_SECONDS
    assert WATCHDOG_TIMEOUT_SECONDS > 600
    assert BATCH_WATCHDOG_TIMEOUT_SECONDS >= 240 * 60


def test_stale_active_items_are_reclaimed_while_the_worker_runs() -> None:
    """`recover_active` only ran at startup, which is why a restart fixed it.

    An item left in `bull:pipeline:active` by a process that died holding it
    is invisible to the running worker: nothing pops it, nothing acks it and
    nothing retries it. Sweeping while the worker runs is what removes the
    "restart it and see" step from the runbook.
    """

    async def scenario() -> None:
        redis = FakeRedis()
        orphan = json.dumps({"job_type": "enrich_lead", "tenant_id": str(TENANT_ID)})
        redis.lists[redis.active_key] = [orphan]
        clock_value = 0.0
        queue = RedisPipelineQueue(redis, clock=lambda: clock_value)

        assert await queue.reclaim_stale_active(min_age_seconds=600) == 0
        assert redis.lists[redis.active_key] == [orphan]

        clock_value = 601.0
        assert await queue.reclaim_stale_active(min_age_seconds=600) == 1
        assert redis.lists[redis.active_key] == []
        assert redis.lists[redis.wait_key] == [orphan]

    asyncio.run(scenario())


def test_in_flight_job_is_never_reclaimed_from_under_the_worker() -> None:
    """Requeueing our own running job would duplicate live work.

    `recover_active` is safe at startup precisely because nothing is running
    yet. Running the same sweep on a live worker would hand the job it is
    currently processing to a second slot, so the sweep skips anything this
    process popped and has not yet acked.
    """

    async def scenario() -> None:
        redis = FakeRedis()
        payload = json.dumps({"job_type": "enrich_lead", "tenant_id": str(TENANT_ID)})
        redis.lists[redis.wait_key] = [payload]
        clock_value = 0.0
        queue = RedisPipelineQueue(redis, clock=lambda: clock_value)

        message = await queue.pop()
        assert message is not None
        assert redis.lists[redis.active_key] == [payload]

        clock_value = 100_000.0
        assert await queue.reclaim_stale_active(min_age_seconds=600) == 0
        assert redis.lists[redis.active_key] == [payload]

        await queue.ack(message)
        assert redis.lists[redis.active_key] == []

    asyncio.run(scenario())


def test_run_forever_sweeps_for_orphaned_active_items() -> None:
    """The sweep is wired in, not merely available.

    A reclaim method nobody calls is the same silent nothing as no reclaim at
    all, so this asserts the manager actually runs it alongside the worker
    loops with the documented ten minute age.
    """

    async def scenario() -> None:
        transport = FakeQueueTransport()
        manager = PipelineQueueManager(
            queue=transport,
            store=FakeQueueStore(),
            handlers={},
            concurrency=1,
            poll_interval_seconds=0.01,
            reclaim_interval_seconds=0.01,
        )

        task = asyncio.create_task(manager.run_forever())
        try:
            for _ in range(100):
                await asyncio.sleep(0.01)
                if transport.reclaim_calls:
                    break
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

        assert transport.recovery_calls == 1
        assert transport.reclaim_calls[0] == STALE_ACTIVE_MIN_AGE_SECONDS

    asyncio.run(scenario())

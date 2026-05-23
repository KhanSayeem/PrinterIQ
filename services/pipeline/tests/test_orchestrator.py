from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest

from db.queries import QueueJobInsert, QueueJobLease, QueueJobUpdate
from pipeline_queue.definitions import JobType
from workers.orchestrator import (
    CLAUDE_RATE_LIMIT_PER_MINUTE,
    INSTANTLY_RATE_LIMIT_PER_MINUTE,
    PIPELINE_CONCURRENCY,
    MinuteRateLimiter,
    PipelineQueueManager,
    QueueMessage,
    RateLimitedClaudeClient,
    RedisPipelineQueue,
    build_limited_handler,
    build_pipeline_handlers,
    build_pooled_production_pipeline_handlers,
    build_production_pipeline_handlers,
    build_schedule_outreach_handler,
    pipeline_rate_limiters,
    smoke_check,
)
from workers.schedule_outreach import OutreachSendLockedError

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
LEAD_ID = UUID("20000000-0000-0000-0000-000000000002")


@dataclass
class FakeQueueStore:
    inserts: list[QueueJobInsert] = field(default_factory=list)
    updates: list[QueueJobUpdate] = field(default_factory=list)
    next_job_id: UUID = UUID("30000000-0000-0000-0000-000000000003")

    async def create_queue_job(self, insert: QueueJobInsert) -> QueueJobLease:
        self.inserts.append(insert)
        return QueueJobLease(job_id=self.next_job_id, acquired=True)

    async def update_queue_job(self, update: QueueJobUpdate) -> None:
        self.updates.append(update)


@dataclass
class FakeQueueTransport:
    payloads: list[dict[str, object]] = field(default_factory=list)
    enqueued: list[tuple[dict[str, object], datetime | None]] = field(default_factory=list)
    acked: list[QueueMessage] = field(default_factory=list)

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
        self.delayed_key = "bull:pipeline:delayed"
        self.dead_key = "bull:pipeline:dead"
        self.lists: dict[str, list[str]] = {
            self.wait_key: [],
            self.active_key: [],
            self.dead_key: [],
        }
        self.sorted_sets: dict[str, dict[str, int]] = {self.delayed_key: {}}

    async def rpoplpush(self, source: str, destination: str) -> str | None:
        if not self.lists[source]:
            return None
        item = self.lists[source].pop()
        self.lists[destination].insert(0, item)
        return item

    async def rpush(self, key: str, item: str) -> None:
        self.lists.setdefault(key, []).append(item)

    async def lrem(self, key: str, count: int, item: str) -> None:
        assert count == 1
        self.lists[key].remove(item)

    async def zrangebyscore(self, key: str, minimum: int, maximum: int) -> list[str]:
        return [
            item
            for item, score in self.sorted_sets.get(key, {}).items()
            if minimum <= score <= maximum
        ]

    async def zrem(self, key: str, item: str) -> None:
        self.sorted_sets[key].pop(item, None)

    async def zadd(self, key: str, mapping: dict[str, int]) -> None:
        self.sorted_sets.setdefault(key, {}).update(mapping)

    async def hgetall(self, key: str) -> dict[str, str]:
        return {}


def test_pipeline_handlers_register_all_pipeline_job_types() -> None:
    handlers = build_pipeline_handlers()

    assert set(handlers) == {
        JobType.INGEST_CSV,
        JobType.ENRICH_LEAD,
        JobType.QUALIFY_LEAD,
        JobType.SCHEDULE_OUTREACH,
    }


def test_default_schedule_outreach_handler_fails_with_configuration_error() -> None:
    async def scenario() -> None:
        handlers = build_pipeline_handlers()

        with pytest.raises(RuntimeError, match="schedule_outreach handler is not configured"):
            await handlers[JobType.SCHEDULE_OUTREACH](
                {"job_type": JobType.SCHEDULE_OUTREACH.value}
            )

    asyncio.run(scenario())


def test_production_pipeline_handlers_inject_worker_dependencies() -> None:
    async def scenario() -> None:
        calls: list[tuple[str, object]] = []

        async def ingest_handler(file_path: Path, **deps: object) -> None:
            calls.append(("ingest", (file_path, deps)))

        async def enrich_handler(payload: dict[str, object], **deps: object) -> None:
            calls.append(("enrich", (payload, deps)))

        async def qualify_handler(payload: dict[str, object], **deps: object) -> None:
            calls.append(("qualify", (payload, deps)))

        async def schedule_handler(payload: dict[str, object], **deps: object) -> None:
            calls.append(("schedule", (payload, deps)))

        lead_repository = object()
        pipeline_store = object()
        queue = object()
        auditor = object()
        claude_client = object()
        instantly_client = object()

        handlers = build_production_pipeline_handlers(
            lead_repository=lead_repository,
            pipeline_store=pipeline_store,
            queue=queue,
            auditor=auditor,
            claude_client=claude_client,
            instantly_client=instantly_client,
            ingest_worker=ingest_handler,
            enrich_worker=enrich_handler,
            qualify_worker=qualify_handler,
            schedule_worker=schedule_handler,
            rate_limits={},
        )

        ingest_payload = {
            "job_type": JobType.INGEST_CSV.value,
            "tenant_id": str(TENANT_ID),
            "file_path": "uploads/leads.csv",
            "source_file": "leads.csv",
        }
        enrich_payload = {
            "job_type": JobType.ENRICH_LEAD.value,
            "tenant_id": str(TENANT_ID),
            "lead_id": str(LEAD_ID),
        }
        qualify_payload = {
            "job_type": JobType.QUALIFY_LEAD.value,
            "tenant_id": str(TENANT_ID),
            "lead_id": str(LEAD_ID),
        }
        schedule_payload = {
            "job_type": JobType.SCHEDULE_OUTREACH.value,
            "tenant_id": str(TENANT_ID),
            "lead_id": str(LEAD_ID),
        }

        await handlers[JobType.INGEST_CSV](ingest_payload)
        await handlers[JobType.ENRICH_LEAD](enrich_payload)
        await handlers[JobType.QUALIFY_LEAD](qualify_payload)
        await handlers[JobType.SCHEDULE_OUTREACH](
            schedule_payload
        )

        assert calls[0][0] == "ingest"
        ingest_path, ingest_deps = calls[0][1]
        assert ingest_path == Path("uploads/leads.csv")
        assert ingest_deps["tenant_id"] == TENANT_ID
        assert ingest_deps["source_file"] == "leads.csv"
        assert ingest_deps["lead_repository"] is lead_repository
        assert ingest_deps["queue"] is queue

        assert calls[1] == (
            "enrich",
            (
                enrich_payload,
                {
                    "lead_fetcher": pipeline_store,
                    "enrichment_repo": pipeline_store,
                    "qualify_queue": queue,
                    "auditor": auditor,
                },
            ),
        )
        assert calls[2] == (
            "qualify",
            (
                qualify_payload,
                {
                    "lead_fetcher": pipeline_store,
                    "enrichment_fetcher": pipeline_store,
                    "qualification_repo": pipeline_store,
                    "outreach_queue": queue,
                    "claude_client": claude_client,
                },
            ),
        )
        assert calls[3] == (
            "schedule",
            (
                schedule_payload,
                {
                    "lead_fetcher": pipeline_store,
                    "qualification_fetcher": pipeline_store,
                    "outreach_repo": pipeline_store,
                    "instantly_client": instantly_client,
                },
            ),
        )

    asyncio.run(scenario())


def test_production_pipeline_handlers_limit_each_claude_call_not_each_qualify_job() -> None:
    async def scenario() -> None:
        events: list[str] = []

        class _Limiter:
            async def acquire(self) -> None:
                events.append("limited")

        class _ClaudeClient:
            async def call(self, prompt_name: str, variables: dict[str, str]) -> str:
                events.append(f"called:{prompt_name}")
                return variables["value"]

        async def qualify_handler(payload: dict[str, object], **deps: object) -> None:
            claude_client = deps["claude_client"]
            await claude_client.call("qualify-v1", {"value": "first"})
            await claude_client.call("opener-v1", {"value": "second"})

        handlers = build_production_pipeline_handlers(
            lead_repository=object(),
            pipeline_store=object(),
            queue=object(),
            auditor=object(),
            claude_client=_ClaudeClient(),
            instantly_client=object(),
            qualify_worker=qualify_handler,
            rate_limits={JobType.QUALIFY_LEAD: _Limiter()},
        )

        await handlers[JobType.QUALIFY_LEAD](
            {
                "job_type": JobType.QUALIFY_LEAD.value,
                "tenant_id": str(TENANT_ID),
                "lead_id": str(LEAD_ID),
            }
        )

        assert events == [
            "limited",
            "called:qualify-v1",
            "limited",
            "called:opener-v1",
        ]

    asyncio.run(scenario())


def test_pooled_production_handlers_use_independent_connection_per_concurrent_job() -> None:
    async def scenario() -> None:
        class FakePool:
            def __init__(self) -> None:
                self.next_id = 0
                self.active_connections: set[int] = set()
                self.max_active_connections = 0

            def acquire(self) -> object:
                pool = self

                class _AcquireContext:
                    connection_id: int

                    async def __aenter__(self) -> object:
                        pool.next_id += 1
                        self.connection_id = pool.next_id
                        pool.active_connections.add(self.connection_id)
                        pool.max_active_connections = max(
                            pool.max_active_connections,
                            len(pool.active_connections),
                        )
                        return {"connection_id": self.connection_id}

                    async def __aexit__(
                        self,
                        exc_type: object,
                        exc: object,
                        traceback: object,
                    ) -> None:
                        pool.active_connections.remove(self.connection_id)

                return _AcquireContext()

        pool = FakePool()
        started = asyncio.Event()
        unblock = asyncio.Event()
        seen_connections: list[object] = []

        async def schedule_handler(payload: dict[str, object], **deps: object) -> None:
            seen_connections.append(deps["lead_fetcher"])
            if len(seen_connections) == 2:
                started.set()
            await unblock.wait()

        handlers = build_pooled_production_pipeline_handlers(
            pool=pool,
            queue=object(),
            auditor=object(),
            claude_client=object(),
            instantly_client=object(),
            schedule_worker=schedule_handler,
            rate_limits={},
        )

        tasks = [
            asyncio.create_task(
                handlers[JobType.SCHEDULE_OUTREACH](
                    {
                        "job_type": JobType.SCHEDULE_OUTREACH.value,
                        "tenant_id": str(TENANT_ID),
                        "lead_id": str(LEAD_ID),
                    }
                )
            )
            for _ in range(2)
        ]
        await asyncio.wait_for(started.wait(), timeout=0.5)
        unblock.set()
        await asyncio.gather(*tasks)

        assert pool.max_active_connections == 2
        assert seen_connections[0] is not seen_connections[1]

    asyncio.run(scenario())


def test_pipeline_queue_manager_processes_one_payload_through_tracking() -> None:
    async def scenario() -> None:
        handled: list[dict[str, object]] = []
        transport = FakeQueueTransport(
            payloads=[
                {
                    "job_type": JobType.SCHEDULE_OUTREACH.value,
                    "tenant_id": str(TENANT_ID),
                    "lead_id": str(LEAD_ID),
                }
            ]
        )
        store = FakeQueueStore()

        async def handler(payload: dict[str, object]) -> None:
            handled.append(payload)

        manager = PipelineQueueManager(
            queue=transport,
            store=store,
            handlers={JobType.SCHEDULE_OUTREACH: handler},
        )

        processed = await manager.run_once()

        assert processed is True
        assert handled == [
            {
                "job_type": JobType.SCHEDULE_OUTREACH.value,
                "tenant_id": str(TENANT_ID),
                "lead_id": str(LEAD_ID),
            }
        ]
        assert store.inserts[0].tenant_id == TENANT_ID
        assert store.inserts[0].lead_id == LEAD_ID
        assert store.updates[0].status == "completed"
        assert store.updates[0].tenant_id == TENANT_ID

    asyncio.run(scenario())


def test_pipeline_queue_manager_requeues_future_send_after_without_handling() -> None:
    async def scenario() -> None:
        future = datetime.now(UTC) + timedelta(hours=1)
        payload = {
            "job_type": JobType.SCHEDULE_OUTREACH.value,
            "tenant_id": str(TENANT_ID),
            "lead_id": str(LEAD_ID),
            "send_after": future.isoformat(),
        }
        transport = FakeQueueTransport(payloads=[payload])
        store = FakeQueueStore()

        async def handler(_: dict[str, object]) -> None:
            raise AssertionError("handler should not run before send_after")

        manager = PipelineQueueManager(
            queue=transport,
            store=store,
            handlers={JobType.SCHEDULE_OUTREACH: handler},
        )

        processed = await manager.run_once()

        assert processed is False
        assert store.inserts == []
        assert store.updates == []
        assert transport.enqueued == [(payload, future)]

    asyncio.run(scenario())


def test_pipeline_queue_manager_retries_locked_outreach_with_incremented_attempt() -> None:
    async def scenario() -> None:
        payload = {
            "job_type": JobType.SCHEDULE_OUTREACH.value,
            "tenant_id": str(TENANT_ID),
            "lead_id": str(LEAD_ID),
            "attempt_count": 1,
        }
        transport = FakeQueueTransport(payloads=[payload])
        store = FakeQueueStore()

        async def handler(_: dict[str, object]) -> None:
            raise OutreachSendLockedError("outreach send is already locked")

        manager = PipelineQueueManager(
            queue=transport,
            store=store,
            handlers={JobType.SCHEDULE_OUTREACH: handler},
        )

        processed = await manager.run_once()

        assert processed is True
        assert store.updates[0].status == "failed"
        assert transport.enqueued == [
            (
                {
                    "job_type": JobType.SCHEDULE_OUTREACH.value,
                    "tenant_id": str(TENANT_ID),
                    "lead_id": str(LEAD_ID),
                    "attempt_count": 2,
                },
                None,
            )
        ]

    asyncio.run(scenario())


def test_pipeline_queue_manager_tracks_malformed_send_after_as_failed_job() -> None:
    async def scenario() -> None:
        payload = {
            "job_type": JobType.SCHEDULE_OUTREACH.value,
            "tenant_id": str(TENANT_ID),
            "lead_id": str(LEAD_ID),
            "send_after": "not-a-date",
        }
        transport = FakeQueueTransport(payloads=[payload])
        store = FakeQueueStore()

        async def handler(_: dict[str, object]) -> None:
            raise ValueError("send_after must be an ISO datetime")

        manager = PipelineQueueManager(
            queue=transport,
            store=store,
            handlers={JobType.SCHEDULE_OUTREACH: handler},
        )

        processed = await manager.run_once()

        assert processed is True
        assert store.inserts[0].payload == payload
        assert store.updates[0].status == "failed"
        assert store.updates[0].error_message == "send_after must be an ISO datetime"

    asyncio.run(scenario())


def test_pipeline_queue_manager_tracks_timezone_less_send_after_as_failed_job() -> None:
    async def scenario() -> None:
        payload = {
            "job_type": JobType.SCHEDULE_OUTREACH.value,
            "tenant_id": str(TENANT_ID),
            "lead_id": str(LEAD_ID),
            "send_after": "2026-05-20T09:00:00",
        }
        transport = FakeQueueTransport(payloads=[payload])
        store = FakeQueueStore()

        async def handler(_: dict[str, object]) -> None:
            raise ValueError("send_after must include timezone")

        manager = PipelineQueueManager(
            queue=transport,
            store=store,
            handlers={JobType.SCHEDULE_OUTREACH: handler},
        )

        processed = await manager.run_once()

        assert processed is True
        assert store.inserts[0].payload == payload
        assert store.updates[0].status == "failed"
        assert store.updates[0].error_message == "send_after must include timezone"

    asyncio.run(scenario())


def test_pipeline_queue_manager_tracks_malformed_attempt_count_as_failed_job() -> None:
    async def scenario() -> None:
        payload = {
            "job_type": JobType.SCHEDULE_OUTREACH.value,
            "tenant_id": str(TENANT_ID),
            "lead_id": str(LEAD_ID),
            "attempt_count": "not-an-int",
        }
        transport = FakeQueueTransport(payloads=[payload])
        store = FakeQueueStore()

        async def handler(_: dict[str, object]) -> None:
            raise AssertionError("handler should not run with malformed attempt_count")

        manager = PipelineQueueManager(
            queue=transport,
            store=store,
            handlers={JobType.SCHEDULE_OUTREACH: handler},
        )

        processed = await manager.run_once()

        assert processed is True
        assert store.inserts[0].payload == payload
        assert store.updates[0].status == "dead"
        assert store.updates[0].error_message == "attempt_count must be an integer"
        assert transport.enqueued == []
        assert transport.acked

    asyncio.run(scenario())


def test_pipeline_queue_manager_acks_invalid_job_type_without_handler() -> None:
    async def scenario() -> None:
        payload = {
            "job_type": "not_a_real_job",
            "tenant_id": str(TENANT_ID),
            "lead_id": str(LEAD_ID),
        }
        transport = FakeQueueTransport(payloads=[payload])
        store = FakeQueueStore()

        manager = PipelineQueueManager(
            queue=transport,
            store=store,
            handlers={JobType.SCHEDULE_OUTREACH: _unexpected_handler},
        )

        processed = await manager.run_once()

        assert processed is True
        assert store.inserts == []
        assert store.updates == []
        assert transport.enqueued == []
        assert transport.acked

    asyncio.run(scenario())


def test_pipeline_queue_manager_acks_unsupported_pipeline_job_type_without_handler() -> None:
    async def scenario() -> None:
        payload = {
            "job_type": JobType.PROCESS_REPLY.value,
            "tenant_id": str(TENANT_ID),
            "lead_id": str(LEAD_ID),
        }
        transport = FakeQueueTransport(payloads=[payload])
        store = FakeQueueStore()

        manager = PipelineQueueManager(
            queue=transport,
            store=store,
            handlers={JobType.SCHEDULE_OUTREACH: _unexpected_handler},
        )

        processed = await manager.run_once()

        assert processed is True
        assert store.inserts == []
        assert store.updates == []
        assert transport.enqueued == []
        assert transport.acked

    asyncio.run(scenario())


async def _unexpected_handler(_: dict[str, object]) -> None:
    raise AssertionError("handler should not run")


def test_pipeline_queue_manager_run_forever_processes_jobs_concurrently() -> None:
    async def scenario() -> None:
        payloads = [
            {
                "job_type": JobType.SCHEDULE_OUTREACH.value,
                "tenant_id": str(TENANT_ID),
                "lead_id": str(LEAD_ID),
            }
            for _ in range(3)
        ]
        transport = FakeQueueTransport(payloads=payloads)
        store = FakeQueueStore()
        all_started = asyncio.Event()
        unblock = asyncio.Event()
        active_count = 0
        max_active_count = 0

        async def handler(_: dict[str, object]) -> None:
            nonlocal active_count, max_active_count
            active_count += 1
            max_active_count = max(max_active_count, active_count)
            if max_active_count == 3:
                all_started.set()
            await unblock.wait()
            active_count -= 1

        manager = PipelineQueueManager(
            queue=transport,
            store=store,
            handlers={JobType.SCHEDULE_OUTREACH: handler},
            concurrency=3,
            poll_interval_seconds=0.01,
        )

        task = asyncio.create_task(manager.run_forever())
        try:
            await asyncio.wait_for(all_started.wait(), timeout=0.5)
            assert max_active_count == 3
        finally:
            unblock.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    asyncio.run(scenario())


def test_smoke_check_reports_pipeline_concurrency_only(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        class _Redis:
            async def ping(self) -> None:
                return None

            async def llen(self, _: str) -> int:
                return 0

            async def aclose(self) -> None:
                return None

        monkeypatch.setattr("workers.orchestrator.load_pipeline_env", lambda: None)
        monkeypatch.setattr("workers.orchestrator.get_redis_client", lambda: _Redis())

        output = await smoke_check()

        assert f"pipeline concurrency: {PIPELINE_CONCURRENCY}" in output
        assert "reply concurrency" not in output

    asyncio.run(scenario())


def test_redis_pipeline_queue_moves_popped_item_to_active_until_ack() -> None:
    async def scenario() -> None:
        redis = FakeRedis()
        raw_payload = (
            '{"job_type":"schedule_outreach","tenant_id":"'
            + str(TENANT_ID)
            + '","lead_id":"'
            + str(LEAD_ID)
            + '"}'
        )
        redis.lists[redis.wait_key].append(raw_payload)
        queue = RedisPipelineQueue(redis)

        message = await queue.pop()

        assert message is not None
        assert message.payload["job_type"] == JobType.SCHEDULE_OUTREACH.value
        assert redis.lists[redis.wait_key] == []
        assert redis.lists[redis.active_key] == [raw_payload]

        await queue.ack(message)

        assert redis.lists[redis.active_key] == []

    asyncio.run(scenario())


def test_redis_pipeline_queue_moves_undecodable_item_to_dead_list() -> None:
    async def scenario() -> None:
        redis = FakeRedis()
        redis.lists[redis.wait_key].append("missing-bullmq-job-id")
        queue = RedisPipelineQueue(redis)

        message = await queue.pop()

        assert message is None
        assert redis.lists[redis.wait_key] == []
        assert redis.lists[redis.active_key] == []
        assert redis.lists[redis.dead_key] == ["missing-bullmq-job-id"]

    asyncio.run(scenario())


def test_pipeline_handlers_use_configured_schedule_outreach_handler() -> None:
    async def scenario() -> None:
        events: list[str] = []

        class _Limiter:
            async def acquire(self) -> None:
                events.append("limited")

        async def schedule_handler(payload: dict[str, object]) -> None:
            events.append(f"scheduled:{payload['job_type']}")

        handlers = build_pipeline_handlers(
            schedule_outreach_handler=schedule_handler,
            rate_limits={JobType.SCHEDULE_OUTREACH: _Limiter()},
        )

        await handlers[JobType.SCHEDULE_OUTREACH](
            {"job_type": JobType.SCHEDULE_OUTREACH.value}
        )

        assert events == ["limited", "scheduled:schedule_outreach"]

    asyncio.run(scenario())


def test_orchestrator_config_matches_pipeline_limits() -> None:
    assert PIPELINE_CONCURRENCY == 5
    assert INSTANTLY_RATE_LIMIT_PER_MINUTE == 50
    assert CLAUDE_RATE_LIMIT_PER_MINUTE == 50


def test_pipeline_rate_limiters_builds_production_limiters() -> None:
    rate_limiters = pipeline_rate_limiters()

    assert set(rate_limiters) == {JobType.QUALIFY_LEAD, JobType.SCHEDULE_OUTREACH}


def test_minute_rate_limiter_waits_between_calls() -> None:
    async def scenario() -> None:
        now = 10.0
        sleeps: list[float] = []

        def clock() -> float:
            return now

        async def sleep(seconds: float) -> None:
            nonlocal now
            sleeps.append(seconds)
            now += seconds

        limiter = MinuteRateLimiter(calls_per_minute=60, clock=clock, sleep=sleep)

        await limiter.acquire()
        await limiter.acquire()

        assert sleeps == [1.0]

    asyncio.run(scenario())


def test_limited_handler_acquires_rate_limit_before_calling_worker() -> None:
    async def scenario() -> None:
        events: list[str] = []

        class _Limiter:
            async def acquire(self) -> None:
                events.append("limited")

        async def handler(payload: dict[str, object]) -> str:
            events.append(f"handled:{payload['job_type']}")
            return "ok"

        limited = build_limited_handler(handler, _Limiter())

        result = await limited({"job_type": JobType.SCHEDULE_OUTREACH.value})

        assert result == "ok"
        assert events == ["limited", "handled:schedule_outreach"]

    asyncio.run(scenario())


def test_rate_limited_claude_client_limits_each_call() -> None:
    async def scenario() -> None:
        events: list[str] = []

        class _Limiter:
            async def acquire(self) -> None:
                events.append("limited")

        class _ClaudeClient:
            async def call(self, prompt_name: str, variables: dict[str, str]) -> str:
                events.append(f"called:{prompt_name}")
                return variables["value"]

        limited = RateLimitedClaudeClient(_ClaudeClient(), _Limiter())

        first = await limited.call("qualify-v1", {"value": "first"})
        second = await limited.call("opener-v1", {"value": "second"})

        assert first == "first"
        assert second == "second"
        assert events == [
            "limited",
            "called:qualify-v1",
            "limited",
            "called:opener-v1",
        ]

    asyncio.run(scenario())


def test_schedule_outreach_handler_supplies_worker_dependencies() -> None:
    async def scenario() -> None:
        calls: list[object] = []

        class _LeadFetcher:
            pass

        class _QualificationFetcher:
            pass

        class _OutreachRepo:
            pass

        class _InstantlyClient:
            pass

        lead_fetcher = _LeadFetcher()
        qualification_fetcher = _QualificationFetcher()
        outreach_repo = _OutreachRepo()
        instantly_client = _InstantlyClient()

        async def worker(
            payload: dict[str, object],
            *,
            lead_fetcher: object,
            qualification_fetcher: object,
            outreach_repo: object,
            instantly_client: object,
        ) -> None:
            calls.extend(
                [
                    payload,
                    lead_fetcher,
                    qualification_fetcher,
                    outreach_repo,
                    instantly_client,
                ]
            )

        handler = build_schedule_outreach_handler(
            lead_fetcher=lead_fetcher,
            qualification_fetcher=qualification_fetcher,
            outreach_repo=outreach_repo,
            instantly_client=instantly_client,
            worker=worker,
        )

        payload = {"job_type": JobType.SCHEDULE_OUTREACH.value}
        await handler(payload)

        assert calls == [
            payload,
            lead_fetcher,
            qualification_fetcher,
            outreach_repo,
            instantly_client,
        ]

    asyncio.run(scenario())

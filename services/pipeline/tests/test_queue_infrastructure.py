from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest

from db.queries import (
    QueueJobInsert,
    QueueJobLease,
    QueueJobUpdate,
    create_queue_job,
    update_queue_job,
)
from pipeline_queue.definitions import JobType, QueueName, queue_for_job_type
from pipeline_queue.worker_base import MissingTenantIdError, run_tracked_job

TENANT_ID = "10000000-0000-0000-0000-000000000001"
LEAD_ID = "00000000-0000-0000-0001-000000000001"
LEASE_STARTED_AT = datetime(2026, 7, 22, 12, 0, tzinfo=UTC)


@dataclass
class RecordedInsert:
    job_type: str
    tenant_id: UUID
    lead_id: UUID | None
    payload: dict[str, Any]
    max_attempts: int


class FakeQueueJobStore:
    def __init__(self) -> None:
        self.inserts: list[RecordedInsert] = []
        self.updates: list[QueueJobUpdate] = []
        self.next_job_id = UUID("20000000-0000-0000-0000-000000000001")
        self.acquired = True

    async def create_queue_job(self, insert: QueueJobInsert) -> QueueJobLease:
        self.inserts.append(
            RecordedInsert(
                job_type=insert.job_type,
                tenant_id=insert.tenant_id,
                lead_id=insert.lead_id,
                payload=dict(insert.payload),
                max_attempts=insert.max_attempts,
            )
        )
        return QueueJobLease(
            job_id=self.next_job_id,
            acquired=self.acquired,
            lease_started_at=LEASE_STARTED_AT,
        )

    async def update_queue_job(self, update: QueueJobUpdate) -> None:
        self.updates.append(update)


class RecordingConnection:
    def __init__(self, *, fetchrow_result: object = None) -> None:
        self.queries: list[str] = []
        self.args: list[tuple[object, ...]] = []
        self.next_job_id = UUID("30000000-0000-0000-0000-000000000001")
        self.fetchrow_result = fetchrow_result

    async def fetchrow(self, query: str, *args: object) -> object:
        self.queries.append(query)
        self.args.append(args)
        if self.fetchrow_result is None:
            return {
                "id": self.next_job_id,
                "acquired": True,
                "started_at": LEASE_STARTED_AT,
            }
        return self.fetchrow_result

    async def fetchval(self, query: str, *args: object) -> object:
        self.queries.append(query)
        self.args.append(args)
        return self.next_job_id

    async def execute(self, query: str, *args: object) -> object:
        self.queries.append(query)
        self.args.append(args)
        return "UPDATE 1"


def test_create_queue_job_marks_started_jobs_active() -> None:
    async def scenario() -> None:
        connection = RecordingConnection()

        await create_queue_job(
            connection,
            QueueJobInsert(
                job_type="ingest_csv",
                tenant_id=UUID(TENANT_ID),
                lead_id=None,
                payload={
                    "job_type": "ingest_csv",
                    "tenant_id": TENANT_ID,
                    "file_path": "/uploads/apollo.csv",
                    "source_file": "apollo.csv",
                    "vertical": "tradies",
                    "dry_run": False,
                },
                max_attempts=3,
                attempt_count=1,
            ),
        )

        insert_query = connection.queries[0]
        assert "ON CONFLICT (tenant_id, job_type)" in insert_query
        assert "WHERE lead_id IS NULL" in insert_query
        assert "'active'" in insert_query
        assert "'running'" not in insert_query

    asyncio.run(scenario())


def test_create_queue_job_reuses_existing_active_job_for_same_tenant_lead_and_type() -> None:
    async def scenario() -> None:
        existing_job_id = UUID("40000000-0000-0000-0000-000000000001")
        connection = RecordingConnection()
        connection.next_job_id = existing_job_id

        result = await create_queue_job(
            connection,
            QueueJobInsert(
                job_type="enrich_lead",
                tenant_id=UUID(TENANT_ID),
                lead_id=UUID(LEAD_ID),
                payload={
                    "job_type": "enrich_lead",
                    "tenant_id": TENANT_ID,
                    "lead_id": LEAD_ID,
                },
                max_attempts=5,
                attempt_count=1,
            ),
        )

        assert result == QueueJobLease(
            job_id=existing_job_id,
            acquired=True,
            lease_started_at=LEASE_STARTED_AT,
        )
        query = connection.queries[0]
        assert "ON CONFLICT (tenant_id, lead_id, job_type)" in query
        assert "SELECT $1, $2, $3" in query
        assert "FROM leads" in query
        assert "leads.id = $2" in query
        assert "leads.tenant_id = $1" in query
        assert "WHERE lead_id IS NOT NULL" in query
        assert "DO UPDATE" in query
        assert "WHERE queue_jobs.status = 'failed'" in query
        assert "acquired" in query

    asyncio.run(scenario())


def test_create_queue_job_reacquires_failed_job_for_retry() -> None:
    async def scenario() -> None:
        existing_job_id = UUID("40000000-0000-0000-0000-000000000001")
        connection = RecordingConnection(
            fetchrow_result={
                "id": existing_job_id,
                "acquired": True,
                "started_at": LEASE_STARTED_AT,
            }
        )

        result = await create_queue_job(
            connection,
            QueueJobInsert(
                job_type="schedule_outreach",
                tenant_id=UUID(TENANT_ID),
                lead_id=UUID(LEAD_ID),
                payload={
                    "job_type": "schedule_outreach",
                    "tenant_id": TENANT_ID,
                    "lead_id": LEAD_ID,
                    "attempt_count": 2,
                },
                max_attempts=5,
                attempt_count=2,
            ),
        )

        assert result == QueueJobLease(
            job_id=existing_job_id,
            acquired=True,
            lease_started_at=LEASE_STARTED_AT,
        )
        query = connection.queries[0]
        assert "SET status = EXCLUDED.status" in query
        assert "attempt_count = EXCLUDED.attempt_count" in query
        assert "WHERE queue_jobs.status = 'failed'" in query

    asyncio.run(scenario())


def test_lead_queue_job_can_take_over_a_stale_active_lease_after_redis_recovery() -> None:
    async def scenario() -> None:
        connection = RecordingConnection()

        await create_queue_job(
            connection,
            QueueJobInsert(
                job_type="enrich_lead",
                tenant_id=UUID(TENANT_ID),
                lead_id=UUID(LEAD_ID),
                payload={
                    "job_type": "enrich_lead",
                    "tenant_id": TENANT_ID,
                    "lead_id": LEAD_ID,
                },
                max_attempts=5,
                attempt_count=2,
            ),
        )

        query = connection.queries[0]
        assert "queue_jobs.status = 'failed'" in query
        assert "queue_jobs.status = 'active'" in query
        assert "queue_jobs.started_at < NOW() - INTERVAL '10 minutes'" in query

    asyncio.run(scenario())


def test_leadless_queue_jobs_can_take_over_stale_active_leases() -> None:
    async def scenario() -> None:
        for job_type in ("start_discovery", "poll_outscraper"):
            connection = RecordingConnection()

            await create_queue_job(
                connection,
                QueueJobInsert(
                    job_type=job_type,
                    tenant_id=UUID(TENANT_ID),
                    lead_id=None,
                    payload={"job_type": job_type, "tenant_id": TENANT_ID},
                    max_attempts=3,
                    attempt_count=2,
                ),
            )

            query = connection.queries[0]
            assert "queue_jobs.status = 'failed'" in query
            assert "queue_jobs.status = 'active'" in query
            assert "queue_jobs.started_at < NOW() - INTERVAL '10 minutes'" in query

    asyncio.run(scenario())


def test_create_queue_job_reports_existing_active_job_without_acquiring_it() -> None:
    async def scenario() -> None:
        existing_job_id = UUID("40000000-0000-0000-0000-000000000001")
        connection = RecordingConnection(
            fetchrow_result={
                "id": existing_job_id,
                "acquired": False,
                "started_at": LEASE_STARTED_AT,
            }
        )

        result = await create_queue_job(
            connection,
            QueueJobInsert(
                job_type="enrich_lead",
                tenant_id=UUID(TENANT_ID),
                lead_id=UUID(LEAD_ID),
                payload={
                    "job_type": "enrich_lead",
                    "tenant_id": TENANT_ID,
                    "lead_id": LEAD_ID,
                },
                max_attempts=5,
                attempt_count=1,
            ),
        )

        assert result == QueueJobLease(
            job_id=existing_job_id,
            acquired=False,
            lease_started_at=LEASE_STARTED_AT,
        )

    asyncio.run(scenario())


def test_acquired_queue_lease_without_started_at_is_rejected() -> None:
    async def scenario() -> None:
        connection = RecordingConnection(
            fetchrow_result={"id": UUID(LEAD_ID), "acquired": True}
        )

        with pytest.raises(TypeError, match="started_at datetime"):
            await create_queue_job(
                connection,
                QueueJobInsert(
                    job_type="start_discovery",
                    tenant_id=UUID(TENANT_ID),
                    lead_id=None,
                    payload={"job_type": "start_discovery", "tenant_id": TENANT_ID},
                    max_attempts=3,
                ),
            )

    asyncio.run(scenario())


def test_update_queue_job_is_tenant_scoped() -> None:
    async def scenario() -> None:
        connection = RecordingConnection()
        job_id = UUID("30000000-0000-0000-0000-000000000001")
        lease_started_at = LEASE_STARTED_AT

        await update_queue_job(
            connection,
            QueueJobUpdate(
                job_id=job_id,
                tenant_id=UUID(TENANT_ID),
                status="completed",
                attempt_count=1,
                lease_started_at=lease_started_at,
            ),
        )

        query = connection.queries[0]
        assert "UPDATE queue_jobs" in query
        assert "WHERE id = $1" in query
        assert "tenant_id = $2" in query
        assert "status = 'active'" in query
        assert "started_at = $6" in query
        assert connection.args[0][:2] == (job_id, UUID(TENANT_ID))
        assert connection.args[0][5] == lease_started_at

    asyncio.run(scenario())


def test_queue_definitions_route_job_types_to_expected_queues() -> None:
    assert queue_for_job_type(JobType.INGEST_CSV) == QueueName.PIPELINE
    assert queue_for_job_type(JobType.ENRICH_LEAD) == QueueName.PIPELINE
    assert queue_for_job_type(JobType.QUALIFY_LEAD) == QueueName.PIPELINE
    assert queue_for_job_type(JobType.SCHEDULE_OUTREACH) == QueueName.PIPELINE
    assert queue_for_job_type(JobType.PROCESS_REPLY) == QueueName.REPLIES
    assert queue_for_job_type(JobType.SEND_REPLY) == QueueName.REPLIES
    assert queue_for_job_type(JobType.RETRY_CHECKOUT) == QueueName.REPLIES


def test_run_tracked_job_writes_active_and_completed_states() -> None:
    async def scenario() -> None:
        store = FakeQueueJobStore()
        handled_payloads: list[dict[str, Any]] = []

        async def handler(payload: dict[str, Any]) -> str:
            handled_payloads.append(payload)
            return "ok"

        payload = {
            "job_type": "enrich_lead",
            "tenant_id": TENANT_ID,
            "lead_id": LEAD_ID,
        }

        result = await run_tracked_job(
            store,
            job_type=JobType.ENRICH_LEAD,
            payload=payload,
            handler=handler,
            max_attempts=5,
        )

        assert result == "ok"
        assert handled_payloads == [payload]
        assert store.inserts == [
            RecordedInsert(
                job_type="enrich_lead",
                tenant_id=UUID(TENANT_ID),
                lead_id=UUID(LEAD_ID),
                payload=payload,
                max_attempts=5,
            )
        ]
        assert len(store.updates) == 1
        assert store.updates[0].job_id == store.next_job_id
        assert store.updates[0].tenant_id == UUID(TENANT_ID)
        assert store.updates[0].status == "completed"
        assert store.updates[0].error_message is None

    asyncio.run(scenario())


def test_run_tracked_job_skips_handler_for_existing_active_job() -> None:
    async def scenario() -> None:
        store = FakeQueueJobStore()
        store.acquired = False
        handled_payloads: list[dict[str, Any]] = []

        async def handler(payload: dict[str, Any]) -> str:
            handled_payloads.append(payload)
            return "ok"

        result = await run_tracked_job(
            store,
            job_type=JobType.ENRICH_LEAD,
            payload={
                "job_type": "enrich_lead",
                "tenant_id": TENANT_ID,
                "lead_id": LEAD_ID,
            },
            handler=handler,
            max_attempts=5,
        )

        assert result is None
        assert handled_payloads == []
        assert store.updates == []

    asyncio.run(scenario())


def test_run_tracked_job_records_failed_attempt_before_max_attempts() -> None:
    async def scenario() -> None:
        store = FakeQueueJobStore()

        async def handler(_: dict[str, Any]) -> None:
            raise RuntimeError("upstream timeout")

        with pytest.raises(RuntimeError, match="upstream timeout"):
            await run_tracked_job(
                store,
                job_type=JobType.QUALIFY_LEAD,
                payload={
                    "job_type": "qualify_lead",
                    "tenant_id": TENANT_ID,
                    "lead_id": LEAD_ID,
                    "score_threshold": 40,
                },
                handler=handler,
                attempt_count=2,
                max_attempts=3,
            )

        assert len(store.updates) == 1
        assert store.updates[0].status == "failed"
        assert store.updates[0].attempt_count == 2
        assert store.updates[0].error_message == "upstream timeout"

    asyncio.run(scenario())


def test_run_tracked_job_records_dead_status_after_exhausted_attempts() -> None:
    async def scenario() -> None:
        store = FakeQueueJobStore()

        async def handler(_: dict[str, Any]) -> None:
            raise ValueError("bad csv")

        with pytest.raises(ValueError, match="bad csv"):
            await run_tracked_job(
                store,
                job_type=JobType.INGEST_CSV,
                payload={
                    "job_type": "ingest_csv",
                    "tenant_id": TENANT_ID,
                    "file_path": "/uploads/apollo.csv",
                    "source_file": "apollo.csv",
                    "vertical": "tradies",
                    "dry_run": False,
                },
                handler=handler,
                attempt_count=3,
                max_attempts=3,
            )

        assert len(store.updates) == 1
        assert store.updates[0].status == "dead"
        assert store.updates[0].attempt_count == 3
        assert store.updates[0].error_message == "bad csv"

    asyncio.run(scenario())


def test_run_tracked_job_rejects_payload_without_tenant_id_before_db_write() -> None:
    async def scenario() -> None:
        store = FakeQueueJobStore()

        async def handler(_: dict[str, Any]) -> None:
            raise AssertionError("handler should not run")

        with pytest.raises(MissingTenantIdError):
            await run_tracked_job(
                store,
                job_type=JobType.ENRICH_LEAD,
                payload={
                    "job_type": "enrich_lead",
                    "lead_id": LEAD_ID,
                },
                handler=handler,
            )

        assert store.inserts == []
        assert store.updates == []

    asyncio.run(scenario())

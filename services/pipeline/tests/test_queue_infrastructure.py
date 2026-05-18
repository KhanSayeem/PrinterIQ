from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pytest

from db.queries import QueueJobInsert, QueueJobUpdate, create_queue_job
from pipeline_queue.definitions import JobType, QueueName, queue_for_job_type
from pipeline_queue.worker_base import MissingTenantIdError, run_tracked_job

TENANT_ID = "10000000-0000-0000-0000-000000000001"
LEAD_ID = "00000000-0000-0000-0001-000000000001"


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

    async def create_queue_job(self, insert: QueueJobInsert) -> UUID:
        self.inserts.append(
            RecordedInsert(
                job_type=insert.job_type,
                tenant_id=insert.tenant_id,
                lead_id=insert.lead_id,
                payload=dict(insert.payload),
                max_attempts=insert.max_attempts,
            )
        )
        return self.next_job_id

    async def update_queue_job(self, update: QueueJobUpdate) -> None:
        self.updates.append(update)


class RecordingConnection:
    def __init__(self) -> None:
        self.queries: list[str] = []
        self.args: list[tuple[object, ...]] = []
        self.next_job_id = UUID("30000000-0000-0000-0000-000000000001")

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
        assert "'active'" in insert_query
        assert "'running'" not in insert_query

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
        assert store.updates[0].status == "completed"
        assert store.updates[0].error_message is None

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

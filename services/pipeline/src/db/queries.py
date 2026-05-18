from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, Protocol
from uuid import UUID

QueueJobStatus = Literal["active", "completed", "failed", "dead"]


class DatabaseConnection(Protocol):
    async def fetchval(self, query: str, *args: object) -> object:
        """Run a query and return the first scalar value."""

    async def execute(self, query: str, *args: object) -> object:
        """Run a query that does not return rows."""


@dataclass(frozen=True)
class QueueJobInsert:
    job_type: str
    tenant_id: UUID
    lead_id: UUID | None
    payload: Mapping[str, object]
    max_attempts: int
    attempt_count: int = 0


@dataclass(frozen=True)
class QueueJobUpdate:
    job_id: UUID
    status: QueueJobStatus
    attempt_count: int
    error_message: str | None = None


class QueueJobStore:
    def __init__(self, connection: DatabaseConnection) -> None:
        self._connection = connection

    async def create_queue_job(self, insert: QueueJobInsert) -> UUID:
        return await create_queue_job(self._connection, insert)

    async def update_queue_job(self, update: QueueJobUpdate) -> None:
        await update_queue_job(self._connection, update)


async def create_queue_job(connection: DatabaseConnection, insert: QueueJobInsert) -> UUID:
    raw_job_id = await connection.fetchval(
        """
        INSERT INTO queue_jobs (
          tenant_id,
          lead_id,
          job_type,
          status,
          attempt_count,
          max_attempts,
          payload,
          started_at
        )
        VALUES ($1, $2, $3, 'active', $4, $5, $6::jsonb, NOW())
        RETURNING id
        """,
        insert.tenant_id,
        insert.lead_id,
        insert.job_type,
        insert.attempt_count,
        insert.max_attempts,
        dict(insert.payload),
    )
    if isinstance(raw_job_id, UUID):
        return raw_job_id
    if isinstance(raw_job_id, str):
        return UUID(raw_job_id)
    raise TypeError(f"Expected queue job UUID, got {type(raw_job_id).__name__}")


async def update_queue_job(connection: DatabaseConnection, update: QueueJobUpdate) -> None:
    completed_fragment = ", completed_at = NOW()" if update.status in {"completed", "dead"} else ""
    await connection.execute(
        f"""
        UPDATE queue_jobs
        SET status = $2,
            attempt_count = $3,
            error_message = $4
            {completed_fragment}
        WHERE id = $1
        """,
        update.job_id,
        update.status,
        update.attempt_count,
        update.error_message,
    )

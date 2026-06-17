from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
import sys
import time
from argparse import ArgumentParser
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol, cast
from uuid import UUID

if __package__ == "src.workers":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from clients.claude_client import RealClaudeClient
from clients.instantly_client import InstantlyClient
from clients.playwright_audit import PlaywrightAuditor
from clients.redis_client import get_redis_client
from db.queries import (
    LeadStore,
    PipelineStore,
    QueueJobInsert,
    QueueJobLease,
    QueueJobStore,
    QueueJobUpdate,
)
from env import load_pipeline_env
from pipeline_queue.definitions import JobType
from pipeline_queue.worker_base import QueueJobRepository, run_tracked_job
from workers.enrich import enrich_lead
from workers.generate_preview import generate_preview
from workers.ingest import ingest_csv_file
from workers.qualify import qualify_lead
from workers.schedule_outreach import SendWindowNotReachedError, schedule_outreach

PIPELINE_CONCURRENCY = 5
INSTANTLY_RATE_LIMIT_PER_MINUTE = 50
CLAUDE_RATE_LIMIT_PER_MINUTE = 50
logger = logging.getLogger(__name__)

PipelineHandler = Callable[[dict[str, object]], Awaitable[object]]
Clock = Callable[[], float]
Sleeper = Callable[[float], Awaitable[None]]
ScheduleOutreachWorker = Callable[..., Awaitable[object]]
FlexibleWorker = Callable[..., Awaitable[object]]


@dataclass(frozen=True)
class QueueMessage:
    payload: dict[str, object]
    ack_token: str


class QueueTransport(Protocol):
    async def pop(self) -> QueueMessage | None:
        """Return one queued payload, or None if no job is ready."""

    async def enqueue(
        self,
        payload: dict[str, object],
        *,
        delay_until: datetime | None = None,
    ) -> None:
        """Enqueue one payload, optionally delaying it until a timestamp."""

    async def ack(self, message: QueueMessage) -> None:
        """Acknowledge that the popped queue item has been handled."""


class RateLimiter(Protocol):
    async def acquire(self) -> None:
        """Wait until the next rate-limited call is allowed."""


class RateLimitedClaudeClient:
    def __init__(self, claude_client: object, rate_limiter: RateLimiter) -> None:
        self._claude_client = cast(Any, claude_client)
        self._rate_limiter = rate_limiter

    async def call(self, prompt_name: str, variables: dict[str, str]) -> object:
        await self._rate_limiter.acquire()
        return await self._claude_client.call(prompt_name, variables)


@dataclass(frozen=True)
class RateLimit:
    calls_per_minute: int


class MinuteRateLimiter:
    def __init__(
        self,
        *,
        calls_per_minute: int,
        clock: Clock | None = None,
        sleep: Sleeper | None = None,
    ) -> None:
        if calls_per_minute < 1:
            raise ValueError("calls_per_minute must be at least 1")
        self._minimum_interval_seconds = 60.0 / calls_per_minute
        self._clock = clock or time.monotonic
        self._sleep = sleep or asyncio.sleep
        self._lock = asyncio.Lock()
        self._last_call_at: float | None = None

    async def acquire(self) -> None:
        async with self._lock:
            now = self._clock()
            if self._last_call_at is not None:
                elapsed = now - self._last_call_at
                remaining = self._minimum_interval_seconds - elapsed
                if remaining > 0:
                    await self._sleep(remaining)
                    now = self._clock()
            self._last_call_at = now


def build_pipeline_handlers(
    *,
    generate_preview_handler: PipelineHandler | None = None,
    schedule_outreach_handler: PipelineHandler | None = None,
    rate_limits: dict[JobType, RateLimiter] | None = None,
) -> dict[JobType, PipelineHandler]:
    handlers: dict[JobType, PipelineHandler] = {
        JobType.INGEST_CSV: cast(PipelineHandler, ingest_csv_file),
        JobType.ENRICH_LEAD: cast(PipelineHandler, enrich_lead),
        JobType.QUALIFY_LEAD: cast(PipelineHandler, qualify_lead),
        JobType.GENERATE_PREVIEW: generate_preview_handler
        or _unconfigured_generate_preview_handler,
        JobType.SCHEDULE_OUTREACH: schedule_outreach_handler
        or _unconfigured_schedule_outreach_handler,
    }
    if rate_limits is None:
        return handlers
    return {
        job_type: build_limited_handler(handler, rate_limits[job_type])
        if job_type in rate_limits
        else handler
        for job_type, handler in handlers.items()
    }


def build_production_pipeline_handlers(
    *,
    lead_repository: object,
    pipeline_store: object,
    queue: object,
    auditor: object,
    claude_client: object,
    instantly_client: object,
    ingest_worker: FlexibleWorker | None = None,
    enrich_worker: FlexibleWorker | None = None,
    qualify_worker: FlexibleWorker | None = None,
    generate_preview_worker: FlexibleWorker | None = None,
    schedule_worker: FlexibleWorker | None = None,
    rate_limits: dict[JobType, RateLimiter] | None = None,
) -> dict[JobType, PipelineHandler]:
    ingest: FlexibleWorker = ingest_worker or cast(FlexibleWorker, ingest_csv_file)
    enrich: FlexibleWorker = enrich_worker or cast(FlexibleWorker, enrich_lead)
    qualify: FlexibleWorker = qualify_worker or cast(FlexibleWorker, qualify_lead)
    preview: FlexibleWorker = generate_preview_worker or cast(FlexibleWorker, generate_preview)
    schedule: FlexibleWorker = schedule_worker or cast(FlexibleWorker, schedule_outreach)
    limiters = rate_limits if rate_limits is not None else pipeline_rate_limiters()
    qualify_claude_client = (
        RateLimitedClaudeClient(claude_client, limiters[JobType.QUALIFY_LEAD])
        if JobType.QUALIFY_LEAD in limiters
        else claude_client
    )
    preview_claude_client = (
        RateLimitedClaudeClient(claude_client, limiters[JobType.GENERATE_PREVIEW])
        if JobType.GENERATE_PREVIEW in limiters
        else claude_client
    )

    async def handle_ingest(payload: dict[str, object]) -> object:
        file_path = Path(str(payload["file_path"]))
        result = await ingest(
            file_path,
            tenant_id=UUID(str(payload["tenant_id"])),
            source_file=str(payload["source_file"]),
            vertical=str(payload.get("vertical", "tradies")),
            lead_repository=lead_repository,
            queue=queue,
            dry_run=bool(payload.get("dry_run", False)),
        )
        _delete_uploaded_csv(file_path)
        return result

    async def handle_enrich(payload: dict[str, object]) -> object:
        return await enrich(
            payload,
            lead_fetcher=pipeline_store,
            enrichment_repo=pipeline_store,
            qualify_queue=queue,
            auditor=auditor,
        )

    async def handle_qualify(payload: dict[str, object]) -> object:
        return await qualify(
            payload,
            lead_fetcher=pipeline_store,
            enrichment_fetcher=pipeline_store,
            qualification_repo=pipeline_store,
            outreach_queue=queue,
            claude_client=qualify_claude_client,
        )

    async def handle_generate_preview(payload: dict[str, object]) -> object:
        return await preview(
            payload,
            lead_fetcher=pipeline_store,
            preview_repo=pipeline_store,
            schedule_queue=queue,
            claude_client=preview_claude_client,
        )

    schedule_handler = build_schedule_outreach_handler(
        lead_fetcher=pipeline_store,
        qualification_fetcher=pipeline_store,
        outreach_repo=pipeline_store,
        instantly_client=instantly_client,
        worker=schedule,
    )

    handlers: dict[JobType, PipelineHandler] = {
        JobType.INGEST_CSV: handle_ingest,
        JobType.ENRICH_LEAD: handle_enrich,
        JobType.QUALIFY_LEAD: handle_qualify,
        JobType.GENERATE_PREVIEW: handle_generate_preview,
        JobType.SCHEDULE_OUTREACH: schedule_handler,
    }
    schedule_limiter = (
        {JobType.SCHEDULE_OUTREACH: limiters[JobType.SCHEDULE_OUTREACH]}
        if JobType.SCHEDULE_OUTREACH in limiters
        else {}
    )
    return {
        job_type: build_limited_handler(handler, schedule_limiter[job_type])
        if job_type in schedule_limiter
        else handler
        for job_type, handler in handlers.items()
    }


def build_pooled_production_pipeline_handlers(
    *,
    pool: object,
    queue: object,
    auditor: object,
    claude_client: object,
    instantly_client: object,
    ingest_worker: FlexibleWorker | None = None,
    enrich_worker: FlexibleWorker | None = None,
    qualify_worker: FlexibleWorker | None = None,
    generate_preview_worker: FlexibleWorker | None = None,
    schedule_worker: FlexibleWorker | None = None,
    rate_limits: dict[JobType, RateLimiter] | None = None,
) -> dict[JobType, PipelineHandler]:
    ingest: FlexibleWorker = ingest_worker or cast(FlexibleWorker, ingest_csv_file)
    enrich: FlexibleWorker = enrich_worker or cast(FlexibleWorker, enrich_lead)
    qualify: FlexibleWorker = qualify_worker or cast(FlexibleWorker, qualify_lead)
    preview: FlexibleWorker = generate_preview_worker or cast(FlexibleWorker, generate_preview)
    schedule: FlexibleWorker = schedule_worker or cast(FlexibleWorker, schedule_outreach)
    connection_pool = cast(Any, pool)
    limiters = rate_limits if rate_limits is not None else pipeline_rate_limiters()
    qualify_claude_client = (
        RateLimitedClaudeClient(claude_client, limiters[JobType.QUALIFY_LEAD])
        if JobType.QUALIFY_LEAD in limiters
        else claude_client
    )
    preview_claude_client = (
        RateLimitedClaudeClient(claude_client, limiters[JobType.GENERATE_PREVIEW])
        if JobType.GENERATE_PREVIEW in limiters
        else claude_client
    )

    async def handle_ingest(payload: dict[str, object]) -> object:
        file_path = Path(str(payload["file_path"]))
        async with connection_pool.acquire() as connection:
            result = await ingest(
                file_path,
                tenant_id=UUID(str(payload["tenant_id"])),
                source_file=str(payload["source_file"]),
                vertical=str(payload.get("vertical", "tradies")),
                lead_repository=LeadStore(connection),
                queue=queue,
                dry_run=bool(payload.get("dry_run", False)),
            )
        _delete_uploaded_csv(file_path)
        return result

    async def handle_enrich(payload: dict[str, object]) -> object:
        async with connection_pool.acquire() as connection:
            pipeline_store = PipelineStore(connection)
            return await enrich(
                payload,
                lead_fetcher=pipeline_store,
                enrichment_repo=pipeline_store,
                qualify_queue=queue,
                auditor=auditor,
            )

    async def handle_qualify(payload: dict[str, object]) -> object:
        async with connection_pool.acquire() as connection:
            pipeline_store = PipelineStore(connection)
            return await qualify(
                payload,
                lead_fetcher=pipeline_store,
                enrichment_fetcher=pipeline_store,
                qualification_repo=pipeline_store,
                outreach_queue=queue,
                claude_client=qualify_claude_client,
            )

    async def handle_generate_preview(payload: dict[str, object]) -> object:
        async with connection_pool.acquire() as connection:
            pipeline_store = PipelineStore(connection)
            return await preview(
                payload,
                lead_fetcher=pipeline_store,
                preview_repo=pipeline_store,
                schedule_queue=queue,
                claude_client=preview_claude_client,
            )

    async def handle_schedule(payload: dict[str, object]) -> object:
        async with connection_pool.acquire() as connection:
            pipeline_store = PipelineStore(connection)
            return await schedule(
                payload,
                lead_fetcher=pipeline_store,
                qualification_fetcher=pipeline_store,
                outreach_repo=pipeline_store,
                instantly_client=instantly_client,
            )

    handlers: dict[JobType, PipelineHandler] = {
        JobType.INGEST_CSV: handle_ingest,
        JobType.ENRICH_LEAD: handle_enrich,
        JobType.QUALIFY_LEAD: handle_qualify,
        JobType.GENERATE_PREVIEW: handle_generate_preview,
        JobType.SCHEDULE_OUTREACH: handle_schedule,
    }
    schedule_limiter = (
        {JobType.SCHEDULE_OUTREACH: limiters[JobType.SCHEDULE_OUTREACH]}
        if JobType.SCHEDULE_OUTREACH in limiters
        else {}
    )
    return {
        job_type: build_limited_handler(handler, schedule_limiter[job_type])
        if job_type in schedule_limiter
        else handler
        for job_type, handler in handlers.items()
    }


def build_limited_handler(
    handler: PipelineHandler,
    rate_limiter: RateLimiter,
) -> PipelineHandler:
    async def limited(payload: dict[str, object]) -> object:
        await rate_limiter.acquire()
        return await handler(payload)

    return limited


def _delete_uploaded_csv(file_path: Path) -> None:
    try:
        file_path.unlink(missing_ok=True)
    except OSError as error:
        logger.warning(
            "Failed to delete uploaded CSV after ingest",
            extra={"error_name": error.__class__.__name__},
        )
        raise


async def _unconfigured_schedule_outreach_handler(_: dict[str, object]) -> object:
    raise RuntimeError("schedule_outreach handler is not configured with production dependencies")


async def _unconfigured_generate_preview_handler(_: dict[str, object]) -> object:
    raise RuntimeError("generate_preview handler is not configured with production dependencies")


def build_schedule_outreach_handler(
    *,
    lead_fetcher: object,
    qualification_fetcher: object,
    outreach_repo: object,
    instantly_client: object,
    worker: ScheduleOutreachWorker = schedule_outreach,
) -> PipelineHandler:
    async def handler(payload: dict[str, object]) -> object:
        return await worker(
            payload,
            lead_fetcher=lead_fetcher,
            qualification_fetcher=qualification_fetcher,
            outreach_repo=outreach_repo,
            instantly_client=instantly_client,
        )

    return handler


def pipeline_rate_limits() -> dict[JobType, RateLimit]:
    return {
        JobType.QUALIFY_LEAD: RateLimit(CLAUDE_RATE_LIMIT_PER_MINUTE),
        JobType.GENERATE_PREVIEW: RateLimit(CLAUDE_RATE_LIMIT_PER_MINUTE),
        JobType.SCHEDULE_OUTREACH: RateLimit(INSTANTLY_RATE_LIMIT_PER_MINUTE),
    }


def pipeline_rate_limiters() -> dict[JobType, MinuteRateLimiter]:
    return {
        job_type: MinuteRateLimiter(calls_per_minute=rate_limit.calls_per_minute)
        for job_type, rate_limit in pipeline_rate_limits().items()
    }


def max_attempts_by_job_type() -> dict[JobType, int]:
    return {
        JobType.INGEST_CSV: 3,
        JobType.ENRICH_LEAD: 5,
        JobType.QUALIFY_LEAD: 3,
        JobType.GENERATE_PREVIEW: 5,
        JobType.SCHEDULE_OUTREACH: 5,
    }


class PipelineQueueManager:
    def __init__(
        self,
        *,
        queue: QueueTransport,
        store: QueueJobRepository,
        handlers: dict[JobType, PipelineHandler],
        sleep: Sleeper | None = None,
        poll_interval_seconds: float = 1.0,
        concurrency: int = PIPELINE_CONCURRENCY,
    ) -> None:
        if concurrency < 1:
            raise ValueError("concurrency must be at least 1")
        self._queue = queue
        self._store = store
        self._handlers = handlers
        self._sleep = sleep or asyncio.sleep
        self._poll_interval_seconds = poll_interval_seconds
        self._concurrency = concurrency
        self._max_attempts = max_attempts_by_job_type()

    async def run_forever(self) -> None:
        await asyncio.gather(*(self._run_loop() for _ in range(self._concurrency)))

    async def _run_loop(self) -> None:
        while True:
            processed = await self.run_once()
            if not processed:
                await self._sleep(self._poll_interval_seconds)

    async def run_once(self) -> bool:
        message = await self._queue.pop()
        if message is None:
            return False
        payload = message.payload

        try:
            job_type = JobType(str(payload["job_type"]))
        except (KeyError, ValueError):
            await self._queue.ack(message)
            return True
        if job_type not in self._handlers or job_type not in self._max_attempts:
            await self._queue.ack(message)
            return True
        if job_type == JobType.SCHEDULE_OUTREACH:
            try:
                delay_until = _future_send_after(payload)
            except ValueError:
                delay_until = None
            if delay_until is not None:
                await self._queue.enqueue(payload, delay_until=delay_until)
                await self._queue.ack(message)
                return False
        max_attempts = self._max_attempts[job_type]
        handler = self._handlers[job_type]
        try:
            attempt_count = int(str(payload.get("attempt_count", 1)))
        except ValueError:
            attempt_count = max_attempts

            async def handler(_: dict[str, object]) -> object:
                raise ValueError("attempt_count must be an integer")

        try:
            await run_tracked_job(
                self._store,
                job_type=job_type,
                payload=payload,
                handler=handler,
                attempt_count=attempt_count,
                max_attempts=max_attempts,
            )
        except SendWindowNotReachedError:
            retry_at = _future_send_after(payload)
            await self._queue.enqueue(payload, delay_until=retry_at)
            await self._queue.ack(message)
            return False
        except Exception:
            if attempt_count < max_attempts:
                retry_payload = dict(payload)
                retry_payload["attempt_count"] = attempt_count + 1
                await self._queue.enqueue(retry_payload)
            await self._queue.ack(message)
            return True
        await self._queue.ack(message)
        return True


class RedisPipelineQueue:
    def __init__(self, redis: object, *, queue_name: str = "pipeline") -> None:
        self._redis = cast(Any, redis)
        self._wait_key = f"bull:{queue_name}:wait"
        self._active_key = f"bull:{queue_name}:active"
        self._delayed_key = f"bull:{queue_name}:delayed"
        self._dead_key = f"bull:{queue_name}:dead"
        self._job_key_prefix = f"bull:{queue_name}:"

    async def pop(self) -> QueueMessage | None:
        await self._promote_due_jobs()
        raw_item = await self._redis.rpoplpush(self._wait_key, self._active_key)
        if raw_item is None:
            return await self._pop_bullmq_hash_job()
        item = _decode_redis_value(raw_item)
        try:
            payload = await self._payload_from_item(item)
        except ValueError:
            await self._redis.rpush(self._dead_key, item)
            await self._redis.lrem(self._active_key, 1, item)
            return None
        return QueueMessage(payload=payload, ack_token=item)

    async def enqueue(
        self,
        payload: dict[str, object],
        *,
        delay_until: datetime | None = None,
    ) -> None:
        encoded = json.dumps(payload, default=str)
        if delay_until is not None and delay_until > datetime.now(UTC):
            score = int(delay_until.timestamp() * 1000)
            await self._redis.zadd(self._delayed_key, {encoded: score})
            return
        await self._redis.rpush(self._wait_key, encoded)

    async def ack(self, message: QueueMessage) -> None:
        if message.ack_token.startswith("hash:"):
            await self._redis.delete(message.ack_token.removeprefix("hash:"))
            return
        await self._redis.lrem(self._active_key, 1, message.ack_token)

    async def _pop_bullmq_hash_job(self) -> QueueMessage | None:
        async for raw_key in self._redis.scan_iter(match=f"{self._job_key_prefix}*"):
            key = _decode_redis_value(raw_key)
            if key in {
                self._wait_key,
                self._active_key,
                self._delayed_key,
                self._dead_key,
                f"{self._job_key_prefix}events",
                f"{self._job_key_prefix}id",
                f"{self._job_key_prefix}marker",
                f"{self._job_key_prefix}meta",
            }:
                continue
            job_hash = await self._redis.hgetall(key)
            raw_data = job_hash.get("data") if isinstance(job_hash, dict) else None
            if raw_data is None:
                continue
            return QueueMessage(
                payload=_json_payload(_decode_redis_value(raw_data)),
                ack_token=f"hash:{key}",
            )
        return None

    async def _promote_due_jobs(self) -> None:
        now_ms = int(datetime.now(UTC).timestamp() * 1000)
        raw_items = await self._redis.zrangebyscore(self._delayed_key, 0, now_ms)
        for raw_item in raw_items:
            item = _decode_redis_value(raw_item)
            await self._redis.rpush(self._wait_key, item)
            await self._redis.zrem(self._delayed_key, item)

    async def _payload_from_item(self, item: str) -> dict[str, object]:
        if item.startswith("{"):
            return _json_payload(item)

        job_hash = await self._redis.hgetall(f"{self._job_key_prefix}{item}")
        raw_data = job_hash.get("data") if isinstance(job_hash, dict) else None
        if raw_data is None:
            raise ValueError(f"Queued job {item} has no BullMQ data payload")
        return _json_payload(_decode_redis_value(raw_data))


class PooledQueueJobStore:
    def __init__(self, pool: object) -> None:
        self._pool = cast(Any, pool)

    async def create_queue_job(self, insert: QueueJobInsert) -> QueueJobLease:
        async with self._pool.acquire() as connection:
            return await QueueJobStore(connection).create_queue_job(insert)

    async def update_queue_job(self, update: QueueJobUpdate) -> None:
        async with self._pool.acquire() as connection:
            await QueueJobStore(connection).update_queue_job(update)


def _decode_redis_value(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


def _json_payload(raw_json: str) -> dict[str, object]:
    payload = json.loads(raw_json)
    if not isinstance(payload, dict):
        raise ValueError("Queue payload must be a JSON object")
    return cast(dict[str, object], payload)


def _future_send_after(payload: dict[str, object]) -> datetime | None:
    raw_send_after = payload.get("send_after")
    if raw_send_after is None:
        return None
    value = datetime.fromisoformat(str(raw_send_after))
    if value.tzinfo is None:
        raise ValueError("send_after must include timezone")
    send_after = value.astimezone(UTC)
    if send_after > datetime.now(UTC):
        return send_after
    return None


async def smoke_check() -> str:
    load_pipeline_env()
    redis = get_redis_client()
    try:
        await cast(Awaitable[object], redis.ping())
        pending_count = await redis.llen("bull:pipeline:wait")
    finally:
        await redis.aclose()

    handlers = build_pipeline_handlers()
    registered = ", ".join(job_type.value for job_type in handlers)
    return (
        f"Registered pipeline workers: {registered}; "
        f"pipeline concurrency: {PIPELINE_CONCURRENCY}; "
        f"pending jobs: {pending_count}"
    )


async def build_production_manager() -> PipelineQueueManager:
    load_pipeline_env()
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("Missing env var: DATABASE_URL")
    anthropic_key = os.getenv("ANTHROPIC_API_KEY")
    if not anthropic_key:
        raise RuntimeError("Missing env var: ANTHROPIC_API_KEY")

    asyncpg = importlib.import_module("asyncpg")
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=PIPELINE_CONCURRENCY + 1)
    redis = get_redis_client()
    queue = RedisPipelineQueue(redis)
    prompts_dir = Path(__file__).resolve().parents[4] / "prompts"
    handlers = build_pooled_production_pipeline_handlers(
        pool=pool,
        queue=queue,
        auditor=PlaywrightAuditor(),
        claude_client=RealClaudeClient(api_key=anthropic_key, prompts_dir=prompts_dir),
        instantly_client=InstantlyClient.from_env(),
    )
    return PipelineQueueManager(
        queue=queue,
        store=cast(QueueJobRepository, PooledQueueJobStore(pool)),
        handlers=handlers,
    )


def main() -> None:
    parser = ArgumentParser(description="PrinterIQ pipeline orchestrator")
    parser.add_argument("--smoke", action="store_true", help="Check Redis and print queue status")
    args = parser.parse_args()
    if args.smoke:
        print(asyncio.run(smoke_check()))
        return
    asyncio.run(_run_production_manager())


async def _run_production_manager() -> None:
    manager = await build_production_manager()
    await manager.run_forever()


if __name__ == "__main__":
    main()

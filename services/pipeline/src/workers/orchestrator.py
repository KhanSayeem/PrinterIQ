from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
import random
import sys
import time
from argparse import ArgumentParser
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol, cast
from uuid import UUID

if __package__ == "src.workers":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from clients.apollo_client import ApolloClient, MissingApolloAPIKeyError
from clients.claude_client import RealClaudeClient
from clients.instantly_client import InstantlyClient
from clients.outscraper_client import OutscraperClient, OutscraperRetryableError
from clients.playwright_audit import PlaywrightAuditor
from clients.prospect_website_audit import ProspectWebsiteAuditor
from clients.prospect_website_resolver import ProspectWebsiteResolver
from clients.redis_client import get_redis_client
from db.queries import (
    LeadStore,
    PipelineStore,
    ProspectStore,
    QueueJobInsert,
    QueueJobLease,
    QueueJobStore,
    QueueJobUpdate,
)
from env import load_pipeline_env
from pipeline_queue.definitions import JobType
from pipeline_queue.worker_base import (
    QueueJobRepository,
    QueueLeaseUnavailableError,
    run_tracked_job,
)
from workers.assess_prospects import assess_prospects
from workers.discover_prospects import poll_outscraper, start_discovery
from workers.enrich import enrich_lead
from workers.enrich_prospect_contacts import enrich_prospect_contacts
from workers.generate_preview import generate_preview
from workers.ingest import ingest_csv_file
from workers.normalize_prospects import normalize_prospects
from workers.prepare_shadow_review import prepare_shadow_review
from workers.purge_prospect_data import purge_prospect_data
from workers.qualify import qualify_lead
from workers.schedule_outreach import SendWindowNotReachedError, schedule_outreach

PIPELINE_CONCURRENCY = 5
INSTANTLY_RATE_LIMIT_PER_MINUTE = 50
CLAUDE_RATE_LIMIT_PER_MINUTE = 50
logger = logging.getLogger(__name__)
_RECOVERED_ACTIVE_RETRY_MARKER = "_printeriq_recovered_active_retry"

PipelineHandler = Callable[[dict[str, object]], Awaitable[object]]
Clock = Callable[[], float]
Sleeper = Callable[[float], Awaitable[None]]
ScheduleOutreachWorker = Callable[..., Awaitable[object]]
FlexibleWorker = Callable[..., Awaitable[object]]


@dataclass(frozen=True)
class QueueMessage:
    payload: dict[str, object]
    ack_token: str
    recovered_active: bool = False


class QueueTransport(Protocol):
    async def recover_active(self) -> int:
        """Return active items to the waiting queue after a process restart."""

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
        JobType.START_DISCOVERY: _unconfigured_prospect_handler,
        JobType.POLL_OUTSCRAPER: _unconfigured_prospect_handler,
        JobType.NORMALIZE_PROSPECTS: _unconfigured_prospect_handler,
        JobType.ASSESS_PROSPECTS: _unconfigured_prospect_handler,
        JobType.ENRICH_PROSPECT_CONTACTS: _unconfigured_prospect_handler,
        JobType.PREPARE_SHADOW_REVIEW: _unconfigured_prospect_handler,
        JobType.PURGE_PROSPECT_DATA: _unconfigured_prospect_handler,
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
    prospect_store: object | None = None,
    queue: object,
    auditor: object,
    claude_client: object,
    instantly_client: object,
    outscraper_client: object | None = None,
    apollo_client: object | None = None,
    prospect_website_resolver: object | None = None,
    prospect_website_auditor: object | None = None,
    ingest_worker: FlexibleWorker | None = None,
    enrich_worker: FlexibleWorker | None = None,
    qualify_worker: FlexibleWorker | None = None,
    generate_preview_worker: FlexibleWorker | None = None,
    schedule_worker: FlexibleWorker | None = None,
    start_discovery_worker: FlexibleWorker | None = None,
    poll_outscraper_worker: FlexibleWorker | None = None,
    normalize_prospects_worker: FlexibleWorker | None = None,
    assess_prospects_worker: FlexibleWorker | None = None,
    enrich_prospect_contacts_worker: FlexibleWorker | None = None,
    prepare_shadow_review_worker: FlexibleWorker | None = None,
    purge_prospect_data_worker: FlexibleWorker | None = None,
    rate_limits: dict[JobType, RateLimiter] | None = None,
) -> dict[JobType, PipelineHandler]:
    ingest: FlexibleWorker = ingest_worker or cast(FlexibleWorker, ingest_csv_file)
    enrich: FlexibleWorker = enrich_worker or cast(FlexibleWorker, enrich_lead)
    qualify: FlexibleWorker = qualify_worker or cast(FlexibleWorker, qualify_lead)
    preview: FlexibleWorker = generate_preview_worker or cast(FlexibleWorker, generate_preview)
    schedule: FlexibleWorker = schedule_worker or cast(FlexibleWorker, schedule_outreach)
    start_prospects: FlexibleWorker = start_discovery_worker or cast(
        FlexibleWorker, start_discovery
    )
    poll_prospects: FlexibleWorker = poll_outscraper_worker or cast(
        FlexibleWorker, poll_outscraper
    )
    normalize_prospect_batch: FlexibleWorker = normalize_prospects_worker or cast(
        FlexibleWorker, normalize_prospects
    )
    assess_prospect_batch: FlexibleWorker = assess_prospects_worker or cast(
        FlexibleWorker, assess_prospects
    )
    enrich_prospect_contact_batch: FlexibleWorker = enrich_prospect_contacts_worker or cast(
        FlexibleWorker, enrich_prospect_contacts
    )
    prepare_review: FlexibleWorker = prepare_shadow_review_worker or cast(
        FlexibleWorker, prepare_shadow_review
    )
    purge_prospect_snapshots: FlexibleWorker = purge_prospect_data_worker or cast(
        FlexibleWorker, purge_prospect_data
    )
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
            score_threshold=int(str(payload["score_threshold"])),
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

    async def handle_start_discovery(payload: dict[str, object]) -> object:
        if prospect_store is None or outscraper_client is None:
            return await _unconfigured_prospect_handler(payload)
        return await start_prospects(
            payload,
            store=prospect_store,
            queue=queue,
            outscraper_client=outscraper_client,
        )

    async def handle_poll_outscraper(payload: dict[str, object]) -> object:
        if prospect_store is None or outscraper_client is None:
            return await _unconfigured_prospect_handler(payload)
        return await poll_prospects(
            payload,
            store=prospect_store,
            queue=queue,
            outscraper_client=outscraper_client,
        )

    async def handle_normalize_prospects(payload: dict[str, object]) -> object:
        if prospect_store is None:
            return await _unconfigured_prospect_handler(payload)
        return await normalize_prospect_batch(
            payload,
            store=prospect_store,
            queue=queue,
            website_resolver=prospect_website_resolver or ProspectWebsiteResolver(),
        )

    async def handle_assess_prospects(payload: dict[str, object]) -> object:
        if prospect_store is None:
            return await _unconfigured_prospect_handler(payload)
        return await assess_prospect_batch(
            payload,
            store=prospect_store,
            queue=queue,
            website_auditor=prospect_website_auditor or ProspectWebsiteAuditor(),
        )

    async def handle_enrich_prospect_contacts(payload: dict[str, object]) -> object:
        if prospect_store is None:
            return await _unconfigured_prospect_handler(payload)
        return await enrich_prospect_contact_batch(
            payload,
            store=prospect_store,
            apollo_client=apollo_client,
            queue=queue,
        )

    async def handle_prepare_shadow_review(payload: dict[str, object]) -> object:
        if prospect_store is None:
            return await _unconfigured_prospect_handler(payload)
        return await prepare_review(
            payload,
            store=prospect_store,
        )

    async def handle_purge_prospect_data(payload: dict[str, object]) -> object:
        if prospect_store is None:
            return await _unconfigured_prospect_handler(payload)
        return await purge_prospect_snapshots(
            payload,
            store=prospect_store,
        )

    handlers: dict[JobType, PipelineHandler] = {
        JobType.INGEST_CSV: handle_ingest,
        JobType.ENRICH_LEAD: handle_enrich,
        JobType.QUALIFY_LEAD: handle_qualify,
        JobType.GENERATE_PREVIEW: handle_generate_preview,
        JobType.SCHEDULE_OUTREACH: schedule_handler,
        JobType.START_DISCOVERY: handle_start_discovery,
        JobType.POLL_OUTSCRAPER: handle_poll_outscraper,
        JobType.NORMALIZE_PROSPECTS: handle_normalize_prospects,
        JobType.ASSESS_PROSPECTS: handle_assess_prospects,
        JobType.ENRICH_PROSPECT_CONTACTS: handle_enrich_prospect_contacts,
        JobType.PREPARE_SHADOW_REVIEW: handle_prepare_shadow_review,
        JobType.PURGE_PROSPECT_DATA: handle_purge_prospect_data,
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
    outscraper_client: object | None = None,
    apollo_client: object | None = None,
    prospect_website_resolver: object | None = None,
    prospect_website_auditor: object | None = None,
    ingest_worker: FlexibleWorker | None = None,
    enrich_worker: FlexibleWorker | None = None,
    qualify_worker: FlexibleWorker | None = None,
    generate_preview_worker: FlexibleWorker | None = None,
    schedule_worker: FlexibleWorker | None = None,
    start_discovery_worker: FlexibleWorker | None = None,
    poll_outscraper_worker: FlexibleWorker | None = None,
    normalize_prospects_worker: FlexibleWorker | None = None,
    assess_prospects_worker: FlexibleWorker | None = None,
    enrich_prospect_contacts_worker: FlexibleWorker | None = None,
    prepare_shadow_review_worker: FlexibleWorker | None = None,
    purge_prospect_data_worker: FlexibleWorker | None = None,
    rate_limits: dict[JobType, RateLimiter] | None = None,
) -> dict[JobType, PipelineHandler]:
    ingest: FlexibleWorker = ingest_worker or cast(FlexibleWorker, ingest_csv_file)
    enrich: FlexibleWorker = enrich_worker or cast(FlexibleWorker, enrich_lead)
    qualify: FlexibleWorker = qualify_worker or cast(FlexibleWorker, qualify_lead)
    preview: FlexibleWorker = generate_preview_worker or cast(FlexibleWorker, generate_preview)
    schedule: FlexibleWorker = schedule_worker or cast(FlexibleWorker, schedule_outreach)
    start_prospects: FlexibleWorker = start_discovery_worker or cast(
        FlexibleWorker, start_discovery
    )
    poll_prospects: FlexibleWorker = poll_outscraper_worker or cast(
        FlexibleWorker, poll_outscraper
    )
    normalize_prospect_batch: FlexibleWorker = normalize_prospects_worker or cast(
        FlexibleWorker, normalize_prospects
    )
    assess_prospect_batch: FlexibleWorker = assess_prospects_worker or cast(
        FlexibleWorker, assess_prospects
    )
    enrich_prospect_contact_batch: FlexibleWorker = enrich_prospect_contacts_worker or cast(
        FlexibleWorker, enrich_prospect_contacts
    )
    prepare_review: FlexibleWorker = prepare_shadow_review_worker or cast(
        FlexibleWorker, prepare_shadow_review
    )
    purge_prospect_snapshots: FlexibleWorker = purge_prospect_data_worker or cast(
        FlexibleWorker, purge_prospect_data
    )
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
                score_threshold=int(str(payload["score_threshold"])),
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

    async def handle_start_discovery(payload: dict[str, object]) -> object:
        if outscraper_client is None:
            return await _unconfigured_prospect_handler(payload)
        async with connection_pool.acquire() as connection:
            return await start_prospects(
                payload,
                store=ProspectStore(connection),
                queue=queue,
                outscraper_client=outscraper_client,
            )

    async def handle_poll_outscraper(payload: dict[str, object]) -> object:
        if outscraper_client is None:
            return await _unconfigured_prospect_handler(payload)
        async with connection_pool.acquire() as connection:
            return await poll_prospects(
                payload,
                store=ProspectStore(connection),
                queue=queue,
                outscraper_client=outscraper_client,
            )

    async def handle_normalize_prospects(payload: dict[str, object]) -> object:
        async with connection_pool.acquire() as connection:
            return await normalize_prospect_batch(
                payload,
                store=ProspectStore(connection),
                queue=queue,
                website_resolver=prospect_website_resolver or ProspectWebsiteResolver(),
            )

    async def handle_assess_prospects(payload: dict[str, object]) -> object:
        async with connection_pool.acquire() as connection:
            return await assess_prospect_batch(
                payload,
                store=ProspectStore(connection),
                queue=queue,
                website_auditor=prospect_website_auditor or ProspectWebsiteAuditor(),
            )

    async def handle_enrich_prospect_contacts(payload: dict[str, object]) -> object:
        async with connection_pool.acquire() as connection:
            return await enrich_prospect_contact_batch(
                payload,
                store=ProspectStore(connection),
                apollo_client=apollo_client,
                queue=queue,
            )

    async def handle_prepare_shadow_review(payload: dict[str, object]) -> object:
        async with connection_pool.acquire() as connection:
            return await prepare_review(
                payload,
                store=ProspectStore(connection),
            )

    async def handle_purge_prospect_data(payload: dict[str, object]) -> object:
        async with connection_pool.acquire() as connection:
            return await purge_prospect_snapshots(
                payload,
                store=ProspectStore(connection),
            )

    handlers: dict[JobType, PipelineHandler] = {
        JobType.INGEST_CSV: handle_ingest,
        JobType.ENRICH_LEAD: handle_enrich,
        JobType.QUALIFY_LEAD: handle_qualify,
        JobType.GENERATE_PREVIEW: handle_generate_preview,
        JobType.SCHEDULE_OUTREACH: handle_schedule,
        JobType.START_DISCOVERY: handle_start_discovery,
        JobType.POLL_OUTSCRAPER: handle_poll_outscraper,
        JobType.NORMALIZE_PROSPECTS: handle_normalize_prospects,
        JobType.ASSESS_PROSPECTS: handle_assess_prospects,
        JobType.ENRICH_PROSPECT_CONTACTS: handle_enrich_prospect_contacts,
        JobType.PREPARE_SHADOW_REVIEW: handle_prepare_shadow_review,
        JobType.PURGE_PROSPECT_DATA: handle_purge_prospect_data,
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


async def _unconfigured_prospect_handler(_: dict[str, object]) -> object:
    raise RuntimeError("prospect handler is not configured with production dependencies")


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
        JobType.START_DISCOVERY: 3,
        JobType.POLL_OUTSCRAPER: 5,
        JobType.NORMALIZE_PROSPECTS: 3,
        JobType.ASSESS_PROSPECTS: 3,
        JobType.ENRICH_PROSPECT_CONTACTS: 5,
        JobType.PREPARE_SHADOW_REVIEW: 3,
        JobType.PURGE_PROSPECT_DATA: 3,
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
        await self._queue.recover_active()
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
        payload = dict(message.payload)
        marker_recovered = _pop_recovered_active_marker(payload)
        recovered_active = message.recovered_active or marker_recovered

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
                retry_if_unavailable=recovered_active,
                recover_stale_active=recovered_active,
            )
        except QueueLeaseUnavailableError:
            if not recovered_active:
                await self._queue.ack(message)
                return True
            retry_payload = dict(payload)
            retry_payload[_RECOVERED_ACTIVE_RETRY_MARKER] = True
            await self._queue.enqueue(
                retry_payload,
                delay_until=datetime.now(UTC) + timedelta(minutes=10),
            )
            await self._queue.ack(message)
            return False
        except SendWindowNotReachedError:
            retry_at = _future_send_after(payload)
            await self._queue.enqueue(payload, delay_until=retry_at)
            await self._queue.ack(message)
            return False
        except Exception as error:
            if attempt_count < max_attempts:
                retry_payload = dict(payload)
                retry_payload["attempt_count"] = attempt_count + 1
                delay_until = (
                    _outscraper_retry_at(error, attempt_count=attempt_count)
                    if job_type == JobType.POLL_OUTSCRAPER
                    and isinstance(error, OutscraperRetryableError)
                    else None
                )
                await self._queue.enqueue(retry_payload, delay_until=delay_until)
            await self._queue.ack(message)
            return True
        await self._queue.ack(message)
        return True


def _pop_recovered_active_marker(payload: dict[str, object]) -> bool:
    return payload.pop(_RECOVERED_ACTIVE_RETRY_MARKER, False) is True


class RedisPipelineQueue:
    def __init__(self, redis: object, *, queue_name: str = "pipeline") -> None:
        self._redis = cast(Any, redis)
        self._wait_key = f"bull:{queue_name}:wait"
        self._active_key = f"bull:{queue_name}:active"
        self._delayed_key = f"bull:{queue_name}:delayed"
        self._dead_key = f"bull:{queue_name}:dead"
        self._job_key_prefix = f"bull:{queue_name}:"
        self._recovered_active_items: set[str] = set()

    async def recover_active(self) -> int:
        recovered = 0
        while True:
            raw_item = await self._redis.rpoplpush(self._active_key, self._wait_key)
            if raw_item is None:
                break
            self._recovered_active_items.add(_decode_redis_value(raw_item))
            recovered += 1
        return recovered

    async def pop(self) -> QueueMessage | None:
        await self._promote_due_jobs()
        raw_item = await self._redis.rpoplpush(self._wait_key, self._active_key)
        if raw_item is None:
            return await self._pop_bullmq_hash_job()
        item = _decode_redis_value(raw_item)
        try:
            payload = await self._payload_from_item(item)
        except ValueError:
            self._recovered_active_items.discard(item)
            await self._redis.rpush(self._dead_key, item)
            await self._redis.lrem(self._active_key, 1, item)
            return None
        recovered_active = item in self._recovered_active_items
        self._recovered_active_items.discard(item)
        return QueueMessage(
            payload=payload,
            ack_token=item,
            recovered_active=recovered_active,
        )

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
        if not message.ack_token.startswith("{"):
            await self._redis.delete(f"{self._job_key_prefix}{message.ack_token}")

    async def _pop_bullmq_hash_job(self) -> QueueMessage | None:
        raw_active_items = await self._redis.lrange(self._active_key, 0, -1)
        active_items = {_decode_redis_value(item) for item in raw_active_items}
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
            job_id = key.removeprefix(self._job_key_prefix)
            if job_id in active_items:
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


def _outscraper_retry_at(
    error: OutscraperRetryableError, *, attempt_count: int
) -> datetime:
    exponential_seconds = min(30 * (2 ** max(0, attempt_count - 1)), 300)
    jitter_seconds = random.uniform(0, min(10, exponential_seconds * 0.25))
    delay_seconds = max(
        exponential_seconds + jitter_seconds,
        float(error.retry_after_seconds or 0),
    )
    return datetime.now(UTC) + timedelta(seconds=delay_seconds)


async def smoke_check() -> str:
    load_pipeline_env()
    redis = get_redis_client()
    try:
        await cast(Awaitable[object], redis.ping())
        pending_count = await _redis_int(redis.llen("bull:pipeline:wait"))
    finally:
        await redis.aclose()

    handlers = build_pipeline_handlers()
    registered = ", ".join(job_type.value for job_type in handlers)
    return (
        f"Registered pipeline workers: {registered}; "
        f"pipeline concurrency: {PIPELINE_CONCURRENCY}; "
        f"pending jobs: {pending_count}"
    )


async def _redis_int(value: Awaitable[int] | int) -> int:
    if isinstance(value, int):
        return value
    return await value


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
        outscraper_client=OutscraperClient.from_env(),
        apollo_client=_apollo_client_from_env_or_none(),
        prospect_website_auditor=ProspectWebsiteAuditor(),
    )
    return PipelineQueueManager(
        queue=queue,
        store=cast(QueueJobRepository, PooledQueueJobStore(pool)),
        handlers=handlers,
    )


def _apollo_client_from_env_or_none() -> ApolloClient | None:
    try:
        return ApolloClient.from_env()
    except MissingApolloAPIKeyError:
        return None


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

from __future__ import annotations

import asyncio
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, cast

if __package__ == "src.workers":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from clients.redis_client import get_redis_client
from env import load_pipeline_env
from pipeline_queue.definitions import JobType
from workers.enrich import enrich_lead
from workers.ingest import ingest_csv_file
from workers.qualify import qualify_lead
from workers.schedule_outreach import schedule_outreach

PIPELINE_CONCURRENCY = 5
REPLY_CONCURRENCY = 10
INSTANTLY_RATE_LIMIT_PER_MINUTE = 50
CLAUDE_RATE_LIMIT_PER_MINUTE = 50

PipelineHandler = Callable[[dict[str, object]], Awaitable[object]]
Clock = Callable[[], float]
Sleeper = Callable[[float], Awaitable[None]]
ScheduleOutreachWorker = Callable[..., Awaitable[object]]


class RateLimiter(Protocol):
    async def acquire(self) -> None:
        """Wait until the next rate-limited call is allowed."""


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
    schedule_outreach_handler: PipelineHandler | None = None,
    rate_limits: dict[JobType, RateLimiter] | None = None,
) -> dict[JobType, PipelineHandler]:
    handlers: dict[JobType, PipelineHandler] = {
        JobType.INGEST_CSV: cast(PipelineHandler, ingest_csv_file),
        JobType.ENRICH_LEAD: cast(PipelineHandler, enrich_lead),
        JobType.QUALIFY_LEAD: cast(PipelineHandler, qualify_lead),
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


def build_limited_handler(
    handler: PipelineHandler,
    rate_limiter: RateLimiter,
) -> PipelineHandler:
    async def limited(payload: dict[str, object]) -> object:
        await rate_limiter.acquire()
        return await handler(payload)

    return limited


async def _unconfigured_schedule_outreach_handler(_: dict[str, object]) -> object:
    raise RuntimeError("schedule_outreach handler is not configured with production dependencies")


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
        JobType.SCHEDULE_OUTREACH: RateLimit(INSTANTLY_RATE_LIMIT_PER_MINUTE),
    }


def pipeline_rate_limiters() -> dict[JobType, MinuteRateLimiter]:
    return {
        job_type: MinuteRateLimiter(calls_per_minute=rate_limit.calls_per_minute)
        for job_type, rate_limit in pipeline_rate_limits().items()
    }


async def smoke_check() -> str:
    load_pipeline_env()
    redis = get_redis_client()
    try:
        await cast(Awaitable[object], redis.ping())
        pending_count = await cast(Awaitable[int], redis.llen("bull:pipeline:wait"))
    finally:
        await redis.aclose()

    handlers = build_pipeline_handlers()
    registered = ", ".join(job_type.value for job_type in handlers)
    return (
        f"Registered pipeline workers: {registered}; "
        f"pipeline concurrency: {PIPELINE_CONCURRENCY}; "
        f"reply concurrency: {REPLY_CONCURRENCY}; "
        f"pending jobs: {pending_count}"
    )


def main() -> None:
    print(asyncio.run(smoke_check()))


if __name__ == "__main__":
    main()

from __future__ import annotations

import asyncio

import pytest

from pipeline_queue.definitions import JobType
from workers.orchestrator import (
    CLAUDE_RATE_LIMIT_PER_MINUTE,
    INSTANTLY_RATE_LIMIT_PER_MINUTE,
    PIPELINE_CONCURRENCY,
    MinuteRateLimiter,
    build_limited_handler,
    build_pipeline_handlers,
    build_schedule_outreach_handler,
    pipeline_rate_limiters,
)


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

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest

from db.queries import QueueProgress
from ops.stall_detector import PipelineProgressSnapshot
from ops.stall_monitor import (
    ALERT_COOLDOWN_SECONDS,
    OpsAlert,
    QueueProgressReader,
    RedisAlertThrottle,
    StallCheckResult,
    run_stall_check,
)

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
NOW = datetime(2026, 9, 8, 9, 0, tzinfo=UTC)


@dataclass
class FakeReader:
    snapshot: PipelineProgressSnapshot
    reads: int = 0

    async def read_progress(self) -> PipelineProgressSnapshot:
        self.reads += 1
        return self.snapshot


@dataclass
class FakeSink:
    sent: list[OpsAlert] = field(default_factory=list)
    fail_with: Exception | None = None

    async def send_ops_alert(self, alert: OpsAlert) -> None:
        if self.fail_with is not None:
            raise self.fail_with
        self.sent.append(alert)


@dataclass
class FakeThrottle:
    claimable: bool = True
    outstanding: bool = False
    claims: int = 0
    clears: int = 0

    async def claim_alert(self, *, cooldown_seconds: float) -> bool:
        del cooldown_seconds
        self.claims += 1
        if not self.claimable:
            return False
        self.outstanding = True
        return True

    async def clear_alert(self) -> bool:
        self.clears += 1
        was_outstanding = self.outstanding
        self.outstanding = False
        return was_outstanding


@dataclass
class FakeRedis:
    lists: dict[str, int] = field(default_factory=dict)
    sorted_sets: dict[str, int] = field(default_factory=dict)
    keys: dict[str, str] = field(default_factory=dict)
    requested_list_keys: list[str] = field(default_factory=list)

    async def llen(self, key: str) -> int:
        self.requested_list_keys.append(key)
        return self.lists.get(key, 0)

    async def zcard(self, key: str) -> int:
        return self.sorted_sets.get(key, 0)

    async def set(
        self,
        key: str,
        value: str,
        *,
        nx: bool = False,
        ex: int | None = None,
    ) -> bool | None:
        del ex
        if nx and key in self.keys:
            return None
        self.keys[key] = value
        return True

    async def delete(self, key: str) -> int:
        return 1 if self.keys.pop(key, None) is not None else 0


@dataclass
class FakeProgressStore:
    progress: QueueProgress
    tenant_ids: list[UUID] = field(default_factory=list)

    async def fetch_queue_progress(self, *, tenant_id: UUID) -> QueueProgress:
        self.tenant_ids.append(tenant_id)
        return self.progress


def _august_snapshot() -> PipelineProgressSnapshot:
    return PipelineProgressSnapshot(
        observed_at=NOW,
        wait_depth=3321,
        active_depth=5,
        delayed_depth=0,
        last_completion_at=NOW - timedelta(days=14),
        last_start_at=NOW - timedelta(days=14),
        concurrency=5,
    )


def _healthy_snapshot() -> PipelineProgressSnapshot:
    return PipelineProgressSnapshot(
        observed_at=NOW,
        wait_depth=2893,
        active_depth=5,
        delayed_depth=183,
        last_completion_at=NOW - timedelta(seconds=11),
        last_start_at=NOW,
        concurrency=5,
    )


def test_august_deadlock_pages_the_operator() -> None:
    """End to end for the incident: stalled snapshot in, SMS text out.

    The detector deciding "stalled" is worth nothing if the alert never leaves
    the process, which is the failure mode this whole feature exists to
    correct. The assertion is on the delivered body, not on an internal flag.
    """

    async def scenario() -> None:
        reader = FakeReader(_august_snapshot())
        sink = FakeSink()
        throttle = FakeThrottle()

        result = await run_stall_check(reader=reader, sink=sink, throttle=throttle)

        assert isinstance(result, StallCheckResult)
        assert result.verdict.stalled is True
        assert result.alert_sent is True
        assert len(sink.sent) == 1
        assert "PrinterIQ pipeline STALLED" in sink.sent[0].body
        assert "3321 waiting" in sink.sent[0].body

    asyncio.run(scenario())


def test_healthy_pipeline_sends_nothing() -> None:
    """No alert, and no claim burned on the cooldown key either."""

    async def scenario() -> None:
        sink = FakeSink()
        throttle = FakeThrottle()

        result = await run_stall_check(
            reader=FakeReader(_healthy_snapshot()),
            sink=sink,
            throttle=throttle,
        )

        assert result.alert_sent is False
        assert result.recovery_sent is False
        assert sink.sent == []
        assert throttle.claims == 0

    asyncio.run(scenario())


def test_repeat_stall_inside_the_cooldown_does_not_resend() -> None:
    """A stall that lasts all night must not send an SMS every check.

    The monitor runs every 5 minutes, so an unthrottled alarm would send 288
    messages a day and the operator would mute the number, which is worse than
    no alarm at all.
    """

    async def scenario() -> None:
        sink = FakeSink()
        throttle = FakeThrottle(claimable=False)

        result = await run_stall_check(
            reader=FakeReader(_august_snapshot()),
            sink=sink,
            throttle=throttle,
        )

        assert result.verdict.stalled is True
        assert result.alert_sent is False
        assert result.suppressed_by_cooldown is True
        assert sink.sent == []

    asyncio.run(scenario())


def test_recovery_is_announced_once_after_an_alert() -> None:
    """The operator needs to know it is over without watching a dashboard."""

    async def scenario() -> None:
        sink = FakeSink()
        throttle = FakeThrottle(outstanding=True)

        result = await run_stall_check(
            reader=FakeReader(_healthy_snapshot()),
            sink=sink,
            throttle=throttle,
        )

        assert result.recovery_sent is True
        assert len(sink.sent) == 1
        assert "recovered" in sink.sent[0].body.lower()

        quiet = await run_stall_check(
            reader=FakeReader(_healthy_snapshot()),
            sink=sink,
            throttle=throttle,
        )

        assert quiet.recovery_sent is False
        assert len(sink.sent) == 1

    asyncio.run(scenario())


def test_failed_delivery_releases_the_cooldown() -> None:
    """A claimed cooldown with no SMS behind it would silence the next hour.

    Claim then send is two steps, and if the send throws while the claim
    stands, the alarm goes quiet for the full cooldown having never told
    anybody anything. That is the silent-failure shape this repository keeps
    shipping, so the claim is released before the error is re-raised.
    """

    async def scenario() -> None:
        sink = FakeSink(fail_with=RuntimeError("SMS gateway unreachable"))
        throttle = FakeThrottle()

        with pytest.raises(RuntimeError, match="SMS gateway unreachable"):
            await run_stall_check(
                reader=FakeReader(_august_snapshot()),
                sink=sink,
                throttle=throttle,
            )

        assert throttle.clears == 1
        assert throttle.outstanding is False

    asyncio.run(scenario())


def test_reader_combines_redis_depth_with_database_progress() -> None:
    """The two halves of the signal come from two different systems.

    Redis knows how much work is queued and how many slots are held. Only
    Postgres knows whether anything finished. A reader that quietly returned
    zeros for either half would produce a permanently healthy verdict, so the
    keys and the tenant scoping are asserted rather than assumed.
    """

    async def scenario() -> None:
        redis = FakeRedis(
            lists={"bull:pipeline:wait": 3321, "bull:pipeline:active": 5},
            sorted_sets={"bull:pipeline:delayed": 183},
        )
        store = FakeProgressStore(
            QueueProgress(
                last_completion_at=NOW - timedelta(days=14),
                last_start_at=NOW - timedelta(days=14),
                active_job_count=25,
                oldest_active_started_at=NOW - timedelta(days=14),
            )
        )
        reader = QueueProgressReader(
            redis=redis,
            store=store,
            tenant_id=TENANT_ID,
            concurrency=5,
            clock=lambda: NOW,
        )

        snapshot = await reader.read_progress()

        assert snapshot.wait_depth == 3321
        assert snapshot.active_depth == 5
        assert snapshot.delayed_depth == 183
        assert snapshot.last_completion_at == NOW - timedelta(days=14)
        assert store.tenant_ids == [TENANT_ID]
        assert redis.requested_list_keys == ["bull:pipeline:wait", "bull:pipeline:active"]

    asyncio.run(scenario())


def test_redis_throttle_claims_once_then_refuses_until_cleared() -> None:
    """The cooldown has to survive process death, so it lives in Redis.

    The monitor is a one-shot process restarted on a cron by PM2. In-process
    state would be discarded between checks and every single check would page.
    """

    async def scenario() -> None:
        redis = FakeRedis()
        throttle = RedisAlertThrottle(redis=redis, key="printeriq:ops:pipeline_stall")

        assert await throttle.claim_alert(cooldown_seconds=ALERT_COOLDOWN_SECONDS) is True
        assert await throttle.claim_alert(cooldown_seconds=ALERT_COOLDOWN_SECONDS) is False
        assert await throttle.clear_alert() is True
        assert await throttle.clear_alert() is False
        assert await throttle.claim_alert(cooldown_seconds=ALERT_COOLDOWN_SECONDS) is True

    asyncio.run(scenario())

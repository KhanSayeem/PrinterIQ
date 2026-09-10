"""The stall alarm: read the queue, judge it, page the operator.

Runs as its own PM2 process, not inside the pipeline worker. That is the whole
point. On 2026-08-25 the worker was `online` with every concurrency slot held
by a job that never returned, so anything living inside that process would have
been just as wedged as the jobs it was supposed to be watching. A separate
process also survives the case an in-process watchdog cannot cover at all: a
handler that blocks the event loop synchronously, where no `asyncio.wait_for`
will ever fire.

The process is one-shot by default (`--once`) and PM2 restarts it on a cron
every five minutes, so a monitor that hangs is replaced by PM2 rather than
becoming a second silent failure.

Usage on the VPS:

    python -m ops.stall_monitor --once            # one check, what PM2 runs
    python -m ops.stall_monitor --once --dry-run  # print the SMS, send nothing
    python -m ops.stall_monitor                   # loop, for a foreground watch
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import logging
import os
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol, cast
from uuid import UUID

# PM2 runs this file by path, the way it runs the orchestrator, so `src` is not
# on sys.path when it starts. Mirrors the bootstrap in workers/orchestrator.py.
if __package__ in {None, "", "src.ops"}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db.queries import QueueJobStore, QueueProgress
from env import load_pipeline_env
from ops.alerting import OpsAlert, PrintingAlertSink, ReplyAgentAlertSink
from ops.stall_detector import (
    STALL_THRESHOLD_SECONDS,
    PipelineProgressSnapshot,
    StallVerdict,
    evaluate_pipeline_progress,
)
from pipeline_queue.definitions import PIPELINE_CONCURRENCY, QueueName

logger = logging.getLogger(__name__)

# One SMS an hour while a stall persists.
#
# The monitor checks every 5 minutes, so an unthrottled alarm would send 288
# messages a day, the operator would mute the number, and the next real stall
# would go unread. An hour is long enough to stay readable and short enough
# that a page nobody acted on comes back.
ALERT_COOLDOWN_SECONDS = 60 * 60

# How often the loop mode re-checks. PM2's cron does this in production.
CHECK_INTERVAL_SECONDS = 5 * 60

ALERT_STATE_KEY = "printeriq:ops:pipeline_stall"

Clock = Callable[[], datetime]


class ProgressReader(Protocol):
    async def read_progress(self) -> PipelineProgressSnapshot:
        """Return one reading of queue depth and completion progress."""


class AlertSink(Protocol):
    async def send_ops_alert(self, alert: OpsAlert) -> None:
        """Deliver one operational alert to the operator."""


class AlertThrottle(Protocol):
    async def claim_alert(self, *, cooldown_seconds: float) -> bool:
        """Return True if this caller may send, starting a new cooldown."""

    async def clear_alert(self) -> bool:
        """Clear any outstanding alert, returning True if one was standing."""


class QueueProgressSource(Protocol):
    async def fetch_queue_progress(self, *, tenant_id: UUID) -> QueueProgress:
        """Return the tenant's queue progress row."""


@dataclass(frozen=True)
class StallCheckResult:
    verdict: StallVerdict
    alert_sent: bool
    recovery_sent: bool
    suppressed_by_cooldown: bool


class QueueProgressReader:
    """Reads queue depth from Redis and completion progress from Postgres.

    Both halves are required and neither is sufficient. Redis alone cannot
    tell a stalled queue from a busy one: the live VPS on 2026-09-09 read
    wait=2,893 active=5, the same shape as the August deadlock, while draining
    8 jobs every 20 seconds. Postgres alone cannot tell a stalled queue from an
    empty one.
    """

    def __init__(
        self,
        *,
        redis: object,
        store: QueueProgressSource,
        tenant_id: UUID,
        concurrency: int = PIPELINE_CONCURRENCY,
        clock: Clock | None = None,
        queue_name: str = QueueName.PIPELINE.value,
    ) -> None:
        self._redis = cast(Any, redis)
        self._store = store
        self._tenant_id = tenant_id
        self._concurrency = concurrency
        self._clock = clock or (lambda: datetime.now(UTC))
        self._wait_key = f"bull:{queue_name}:wait"
        self._active_key = f"bull:{queue_name}:active"
        self._delayed_key = f"bull:{queue_name}:delayed"

    async def read_progress(self) -> PipelineProgressSnapshot:
        wait_depth = await _redis_int(self._redis.llen(self._wait_key))
        active_depth = await _redis_int(self._redis.llen(self._active_key))
        delayed_depth = await _redis_int(self._redis.zcard(self._delayed_key))
        progress = await self._store.fetch_queue_progress(tenant_id=self._tenant_id)
        return PipelineProgressSnapshot(
            observed_at=self._clock(),
            wait_depth=wait_depth,
            active_depth=active_depth,
            delayed_depth=delayed_depth,
            last_completion_at=progress.last_completion_at,
            last_start_at=progress.last_start_at,
            concurrency=self._concurrency,
        )


class RedisAlertThrottle:
    """Cooldown state that outlives the process, because the process is a cron.

    Each check runs in a fresh interpreter, so in-memory throttling would
    forget everything between checks and page every five minutes forever. Two
    keys: one with a TTL that enforces the cooldown, one that records an alert
    is standing so recovery can be announced exactly once.
    """

    def __init__(self, *, redis: object, key: str = ALERT_STATE_KEY) -> None:
        self._redis = cast(Any, redis)
        self._cooldown_key = f"{key}:cooldown"
        self._outstanding_key = f"{key}:outstanding"

    async def claim_alert(self, *, cooldown_seconds: float) -> bool:
        claimed = await self._redis.set(
            self._cooldown_key,
            "1",
            nx=True,
            ex=max(1, int(cooldown_seconds)),
        )
        if not claimed:
            return False
        # Seven days, so a stall nobody clears eventually stops claiming to be
        # outstanding rather than leaking a key forever.
        await self._redis.set(self._outstanding_key, "1", ex=7 * 24 * 60 * 60)
        return True

    async def clear_alert(self) -> bool:
        removed = await self._redis.delete(self._outstanding_key)
        # Drop the cooldown too, so a pipeline that stalls again right after
        # recovering pages immediately instead of waiting out the old window.
        await self._redis.delete(self._cooldown_key)
        return bool(removed)


class ReadOnlyAlertThrottle:
    """The throttle a `--dry-run` gets: answers the same questions, writes nothing.

    A rehearsal used to run against `RedisAlertThrottle`, because `--dry-run`
    only ever reached the SMS sink. So a dry run on the live box took the real
    cooldown claim for a full hour and then printed the alert to a terminal.
    The next scheduled check, the one that would have paged a human, found the
    cooldown held and stood down. Checking that the alarm worked was enough to
    switch it off, and nothing in the output said so.

    The recovery path was worse: `clear_alert` deletes the outstanding flag, so
    a rehearsal spent the one recovery text the operator was owed on a
    terminal nobody was reading, and production then believed it had already
    announced.

    So this reads the same keys and returns the same answers without a single
    write. It is deliberately not an always-yes stub: the point of a rehearsal
    is to show what production would do, and answering True while a cooldown
    stands would show an SMS production would never have sent.
    """

    def __init__(self, *, redis: object, key: str = ALERT_STATE_KEY) -> None:
        self._redis = cast(Any, redis)
        self._cooldown_key = f"{key}:cooldown"
        self._outstanding_key = f"{key}:outstanding"

    async def claim_alert(self, *, cooldown_seconds: float) -> bool:
        # EXISTS rather than SET NX. Same answer, no claim taken.
        del cooldown_seconds
        held = await self._redis.exists(self._cooldown_key)
        return not bool(held)

    async def clear_alert(self) -> bool:
        outstanding = await self._redis.exists(self._outstanding_key)
        return bool(outstanding)


def build_alert_throttle(*, redis: object, key: str, dry_run: bool) -> AlertThrottle:
    """Pick the throttle that matches the run.

    Both monitors constructed `RedisAlertThrottle` inline and both therefore
    had the dry-run bug. Choosing here means the next monitor inherits the
    fix instead of repeating the mistake.
    """
    if dry_run:
        return ReadOnlyAlertThrottle(redis=redis, key=key)
    return RedisAlertThrottle(redis=redis, key=key)


async def run_stall_check(
    *,
    reader: ProgressReader,
    sink: AlertSink,
    throttle: AlertThrottle,
    stall_threshold_seconds: float = STALL_THRESHOLD_SECONDS,
    alert_cooldown_seconds: float = ALERT_COOLDOWN_SECONDS,
) -> StallCheckResult:
    """Take one reading, judge it, and page or stand down accordingly."""
    snapshot = await reader.read_progress()
    verdict = evaluate_pipeline_progress(
        snapshot,
        stall_threshold_seconds=stall_threshold_seconds,
    )

    if not verdict.stalled:
        was_outstanding = await throttle.clear_alert()
        if not was_outstanding:
            return StallCheckResult(
                verdict=verdict,
                alert_sent=False,
                recovery_sent=False,
                suppressed_by_cooldown=False,
            )
        await sink.send_ops_alert(
            OpsAlert(
                subject="PrinterIQ pipeline recovered",
                body=f"PrinterIQ pipeline recovered. {verdict.summary}",
            )
        )
        return StallCheckResult(
            verdict=verdict,
            alert_sent=False,
            recovery_sent=True,
            suppressed_by_cooldown=False,
        )

    if not await throttle.claim_alert(cooldown_seconds=alert_cooldown_seconds):
        logger.warning("Pipeline stall still active, alert suppressed by cooldown")
        return StallCheckResult(
            verdict=verdict,
            alert_sent=False,
            recovery_sent=False,
            suppressed_by_cooldown=True,
        )

    try:
        await sink.send_ops_alert(
            OpsAlert(subject="PrinterIQ pipeline stalled", body=verdict.summary)
        )
    except Exception:
        # Claim first, send second. If the send fails while the claim stands,
        # the cooldown silences the next hour of checks having told nobody
        # anything, so the claim is handed back before the error propagates.
        await throttle.clear_alert()
        raise

    return StallCheckResult(
        verdict=verdict,
        alert_sent=True,
        recovery_sent=False,
        suppressed_by_cooldown=False,
    )


async def _redis_int(value: Awaitable[int] | int) -> int:
    if isinstance(value, int):
        return value
    return int(await value)


def _required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing env var: {name}")
    return value


def build_alert_sink(
    *,
    dry_run: bool = False,
    source: str = "pipeline-stall-monitor",
) -> AlertSink:
    """Build the alert path, or refuse to run.

    A monitor that starts without a delivery path is worse than no monitor: it
    fills the log with healthy checks and stays silent on the one that matters.
    Missing configuration raises here, at startup, where PM2 shows it.

    Shared with `ops.bounce_monitor`, which passes its own `source`. One place
    that knows how to reach the reply agent means one place to fix when that
    changes, and both alarms fail to start for the same reason if it breaks.
    """
    if dry_run:
        return PrintingAlertSink()
    return ReplyAgentAlertSink(
        base_url=_required_env("REPLY_AGENT_INTERNAL_URL"),
        secret=_required_env("OPS_ALERT_SECRET"),
        source=source,
    )


async def _run_checks(*, once: bool, dry_run: bool) -> StallCheckResult:
    load_pipeline_env()
    tenant_id = UUID(_required_env("TENANT_ID"))
    database_url = _required_env("DATABASE_URL")
    sink = build_alert_sink(dry_run=dry_run)

    redis_client = importlib.import_module("clients.redis_client").get_redis_client()
    asyncpg = importlib.import_module("asyncpg")
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2)
    throttle = build_alert_throttle(redis=redis_client, key=ALERT_STATE_KEY, dry_run=dry_run)

    try:
        while True:
            async with pool.acquire() as connection:
                reader = QueueProgressReader(
                    redis=redis_client,
                    store=QueueJobStore(connection),
                    tenant_id=tenant_id,
                )
                result = await run_stall_check(reader=reader, sink=sink, throttle=throttle)
            print(result.verdict.summary)
            if once:
                return result
            await asyncio.sleep(CHECK_INTERVAL_SECONDS)
    finally:
        await pool.close()
        await redis_client.aclose()


def main() -> int:
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="PrinterIQ pipeline stall monitor")
    parser.add_argument("--once", action="store_true", help="Run a single check and exit")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the alert instead of sending it",
    )
    args = parser.parse_args()

    try:
        result = asyncio.run(_run_checks(once=args.once, dry_run=args.dry_run))
    except Exception as error:
        # Exit 1 is the check itself failing, which is different from finding a
        # stall. PM2 shows it as errored, and an operator can tell the two
        # apart without reading the log.
        logger.error("Pipeline stall check failed: %s", error.__class__.__name__)
        raise

    # A found stall still exits 0. The alarm is the SMS, not the exit code, and
    # a non-zero exit on a cron process makes PM2 report the monitor as broken
    # when it is in fact working perfectly.
    return 0 if result is not None else 0


if __name__ == "__main__":
    sys.exit(main())

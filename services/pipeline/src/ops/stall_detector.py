"""Decide whether the pipeline worker is actually making progress.

On 2026-08-25 the pipeline worker deadlocked and nobody noticed for two weeks.
Everything an operator would normally look at said the service was fine:

* PM2 reported the process `online` with 0 unstable restarts
* CPU sat at 0% and memory was normal
* the last log line was two weeks old, but silence is not an alert

All five concurrency slots (`PIPELINE_CONCURRENCY = 5`) were held by jobs that
had started and would never finish, so the worker could not pick up job number
six. `bull:pipeline:wait` climbed to 3,321 and stayed there. The `queue_jobs`
rows those five jobs leased are still in the live database, stamped
2026-08-25 20:14:20, 20:38:31 and 20:39:59 UTC, still `active`.

Every signal that was available at the time was true and useless, so this
module is built on the one signal that was false: a queue job reaching a
terminal state and writing `completed_at`.

Why the obvious signals are not enough on their own:

* Process liveness said `online` throughout the incident.
* Queue depth cannot distinguish a stall from a busy afternoon. A snapshot
  taken from the live VPS on 2026-09-09 at 17:05 UTC read wait=2,893 and
  active=5, which is the August shape exactly, while the wait list drained by
  8 entries in 20 seconds.
* An empty queue is a legitimate resting state between campaign batches, so
  "nothing finished recently" cannot fire on its own either.

The rule is therefore the conjunction: nothing has reached a terminal state
for `STALL_THRESHOLD_SECONDS`, AND there is work that should be moving. Work
that should be moving means either jobs waiting in Redis or every concurrency
slot occupied, because a fully occupied worker is one that cannot accept job
number six no matter how empty the wait list looks.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from pipeline_queue.definitions import PIPELINE_CONCURRENCY

# Twenty minutes of total silence with work waiting.
#
# Measured against live traffic rather than guessed: the longest gap between
# two consecutive `queue_jobs.completed_at` values over the last seven days is
# 11 seconds, and the slowest single job ever recorded across 16,000+ completed
# rows is 100 seconds. Under campaign load the pipeline completes roughly 34
# jobs a minute.
#
# The watchdog in `pipeline_queue.worker_base` caps any single job at 15
# minutes, so no legitimately slow job can hold a slot long enough to produce
# 20 minutes of silence on its own, and with five slots the other four keep
# completing work regardless. 20 minutes is therefore comfortably above every
# healthy pattern production has produced and turns a two week outage into a
# twenty minute one.
STALL_THRESHOLD_SECONDS = 20 * 60

PipelineProgressState = Literal["healthy", "idle", "stalled", "unknown"]


@dataclass(frozen=True)
class PipelineProgressSnapshot:
    """One reading of the queue, from Redis and Postgres together.

    Redis knows how much work is queued and how many slots are held. Only
    Postgres knows whether anything finished, because `bull:pipeline:active`
    looks identical whether the jobs in it are progressing or dead.
    """

    observed_at: datetime
    wait_depth: int
    active_depth: int
    delayed_depth: int
    last_completion_at: datetime | None
    last_start_at: datetime | None
    concurrency: int = PIPELINE_CONCURRENCY


@dataclass(frozen=True)
class StallVerdict:
    state: PipelineProgressState
    summary: str
    seconds_since_completion: float | None
    seconds_since_start: float | None
    snapshot: PipelineProgressSnapshot

    @property
    def stalled(self) -> bool:
        return self.state == "stalled"


def evaluate_pipeline_progress(
    snapshot: PipelineProgressSnapshot,
    *,
    stall_threshold_seconds: float = STALL_THRESHOLD_SECONDS,
) -> StallVerdict:
    """Classify one snapshot as healthy, idle, stalled or unknown."""
    observed_at = _require_aware(snapshot.observed_at, "observed_at")
    last_completion_at = _optional_aware(snapshot.last_completion_at, "last_completion_at")
    last_start_at = _optional_aware(snapshot.last_start_at, "last_start_at")

    seconds_since_completion = _age_seconds(observed_at, last_completion_at)
    seconds_since_start = _age_seconds(observed_at, last_start_at)

    if last_completion_at is None and last_start_at is None:
        return StallVerdict(
            state="unknown",
            summary=(
                "PrinterIQ pipeline progress unknown: queue_jobs holds no history for this "
                f"tenant. {_work_phrase(snapshot)}."
            ),
            seconds_since_completion=None,
            seconds_since_start=None,
            snapshot=snapshot,
        )

    # `started_at` is refreshed on every lease and every retry, so it proves
    # only that the worker is picking jobs up. When there is no completion to
    # measure against it is the best available evidence of life, but a worker
    # that starts jobs and finishes none is still stalled, which is why
    # completion age wins whenever it exists.
    silence_seconds = (
        seconds_since_completion if seconds_since_completion is not None else seconds_since_start
    )
    assert silence_seconds is not None
    is_silent = silence_seconds >= stall_threshold_seconds

    if not is_silent:
        return StallVerdict(
            state="healthy",
            summary=(
                f"PrinterIQ pipeline healthy: last completion {_format_age(silence_seconds)} ago. "
                f"{_work_phrase(snapshot)}."
            ),
            seconds_since_completion=seconds_since_completion,
            seconds_since_start=seconds_since_start,
            snapshot=snapshot,
        )

    if not _has_work_that_should_be_moving(snapshot):
        return StallVerdict(
            state="idle",
            summary=(
                f"PrinterIQ pipeline idle: nothing queued and nothing running, last completion "
                f"{_format_age(silence_seconds)} ago."
            ),
            seconds_since_completion=seconds_since_completion,
            seconds_since_start=seconds_since_start,
            snapshot=snapshot,
        )

    completion_phrase = (
        f"nothing has completed for {_format_age(silence_seconds)}"
        if seconds_since_completion is not None
        else f"no job has ever completed and nothing has started for {_format_age(silence_seconds)}"
    )
    return StallVerdict(
        state="stalled",
        summary=(
            f"PrinterIQ pipeline STALLED: {completion_phrase}. {_work_phrase(snapshot)}. "
            "Check pm2 logs pipeline."
        ),
        seconds_since_completion=seconds_since_completion,
        seconds_since_start=seconds_since_start,
        snapshot=snapshot,
    )


def _has_work_that_should_be_moving(snapshot: PipelineProgressSnapshot) -> bool:
    """Is there work the worker owes us progress on?

    Either half is sufficient. A non-empty wait list is the August signature
    once the backlog had built up (3,321 jobs). Full slots is the same failure
    in its first minutes, before ingest had time to pile anything up, and it is
    the only evidence available when the wait list happens to be empty.
    """
    if snapshot.wait_depth > 0:
        return True
    return snapshot.concurrency > 0 and snapshot.active_depth >= snapshot.concurrency


def _work_phrase(snapshot: PipelineProgressSnapshot) -> str:
    return (
        f"{snapshot.wait_depth} waiting, "
        f"{snapshot.active_depth}/{snapshot.concurrency} slots busy, "
        f"{snapshot.delayed_depth} delayed"
    )


def _age_seconds(observed_at: datetime, moment: datetime | None) -> float | None:
    if moment is None:
        return None
    return (observed_at - moment).total_seconds()


def _format_age(seconds: float) -> str:
    if seconds < 60:
        return f"{int(seconds)}s"
    if seconds < 3600:
        return f"{int(seconds // 60)}m"
    if seconds < 86400:
        return f"{int(seconds // 3600)}h {int((seconds % 3600) // 60)}m"
    return f"{int(seconds // 86400)}d {int((seconds % 86400) // 3600)}h"


def _require_aware(value: datetime, field_name: str) -> datetime:
    if value.tzinfo is None:
        raise ValueError(f"{field_name} must carry a timezone")
    return value


def _optional_aware(value: datetime | None, field_name: str) -> datetime | None:
    if value is None:
        return None
    return _require_aware(value, field_name)

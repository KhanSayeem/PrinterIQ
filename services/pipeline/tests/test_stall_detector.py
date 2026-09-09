from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from ops.stall_detector import (
    STALL_THRESHOLD_SECONDS,
    PipelineProgressSnapshot,
    evaluate_pipeline_progress,
)

# The morning the August 2026 deadlock was finally noticed. Every timestamp in
# this module is anchored to it so the headline scenario reads as the incident
# actually happened rather than as an abstract "some time ago".
NOTICED_AT = datetime(2026, 9, 8, 9, 0, tzinfo=UTC)
CONCURRENCY = 5


def _snapshot(
    *,
    observed_at: datetime = NOTICED_AT,
    wait_depth: int = 0,
    active_depth: int = 0,
    delayed_depth: int = 0,
    last_completion_at: datetime | None = None,
    last_start_at: datetime | None = None,
    concurrency: int = CONCURRENCY,
) -> PipelineProgressSnapshot:
    return PipelineProgressSnapshot(
        observed_at=observed_at,
        wait_depth=wait_depth,
        active_depth=active_depth,
        delayed_depth=delayed_depth,
        last_completion_at=last_completion_at,
        last_start_at=last_start_at,
        concurrency=concurrency,
    )


def test_august_deadlock_signature_is_reported_as_stalled() -> None:
    """The headline case: reproduce the 2026-08-25 deadlock exactly.

    The process was `online` under PM2 with 0 unstable restarts, CPU at 0% and
    memory normal. `bull:pipeline:wait` held 3,321 jobs that never moved and
    `bull:pipeline:active` held exactly 5, one per concurrency slot, frozen
    from the instant the worker died. Nothing completed for two weeks and
    nothing raised. Every liveness-style signal available at the time said
    healthy, so the detector may only rely on the one signal that was actually
    false: a queue job reaching a terminal state.

    The oldest `queue_jobs` rows still sitting in `active` on the live database
    are stamped 2026-08-25 20:14:20, 20:38:31 and 20:39:59 UTC, which is where
    the two week gap below comes from.
    """
    verdict = evaluate_pipeline_progress(
        _snapshot(
            wait_depth=3321,
            active_depth=5,
            last_completion_at=NOTICED_AT - timedelta(days=14),
            last_start_at=NOTICED_AT - timedelta(days=14),
        )
    )

    assert verdict.stalled is True
    assert verdict.state == "stalled"
    assert verdict.seconds_since_completion == pytest.approx(14 * 24 * 3600)
    assert "3321" in verdict.summary
    assert "5" in verdict.summary


def test_replay_of_the_real_outage_window_fires_twenty_minutes_in() -> None:
    """Replayed against the timestamps the production database still holds.

    Queried read-only on 2026-09-09:

        SELECT date_trunc('day', completed_at), count(*) ...
        2026-08-25 | 5035
        2026-09-09 | 1649

    Nothing completed in between. The last completion before the hole is
    2026-08-25 23:27:29 UTC, and asking the same table what the most recent
    completion was as of 2026-09-01 09:00 returns that same row, 6.4 days
    stale.

    Two assertions, one incident. The alarm fires at the twenty minute mark
    rather than at the two week mark, and it was still firing days later
    rather than deciding the quiet had become normal.
    """
    last_completion = datetime(2026, 8, 25, 23, 27, 29, tzinfo=UTC)

    twenty_minutes_later = evaluate_pipeline_progress(
        _snapshot(
            observed_at=last_completion + timedelta(seconds=STALL_THRESHOLD_SECONDS),
            wait_depth=3321,
            active_depth=5,
            last_completion_at=last_completion,
            last_start_at=last_completion,
        )
    )

    assert twenty_minutes_later.stalled is True

    six_days_later = evaluate_pipeline_progress(
        _snapshot(
            observed_at=datetime(2026, 9, 1, 9, 0, tzinfo=UTC),
            wait_depth=3321,
            active_depth=5,
            last_completion_at=last_completion,
            last_start_at=last_completion,
        )
    )

    assert six_days_later.stalled is True
    assert "6d" in six_days_later.summary


def test_busy_pipeline_with_deep_backlog_and_full_slots_is_healthy() -> None:
    """A snapshot taken from the live VPS on 2026-09-09 at 17:05 UTC.

    `bull:pipeline:wait` was 2,893 and `bull:pipeline:active` was pinned at 5,
    which is the shape of the August failure in every respect but one: jobs
    were finishing. The wait list drained by 8 entries in 20 seconds and
    `max(completed_at)` was seconds old.

    This is the test that stops the detector from being a queue-depth alarm.
    Depth and slot occupancy look identical in both snapshots, so neither may
    fire on its own.
    """
    verdict = evaluate_pipeline_progress(
        _snapshot(
            wait_depth=2893,
            active_depth=5,
            delayed_depth=183,
            last_completion_at=NOTICED_AT - timedelta(seconds=11),
            last_start_at=NOTICED_AT,
        )
    )

    assert verdict.stalled is False
    assert verdict.state == "healthy"


def test_empty_queue_with_no_recent_completion_is_idle_not_stalled() -> None:
    """A drained queue is the normal resting state between campaign batches.

    Outreach only sends inside a send window, so the pipeline routinely has
    nothing to do for hours. Alarming on "no completions recently" without
    also requiring work to be waiting would page the operator every night.
    """
    verdict = evaluate_pipeline_progress(
        _snapshot(
            wait_depth=0,
            active_depth=0,
            last_completion_at=NOTICED_AT - timedelta(days=3),
            last_start_at=NOTICED_AT - timedelta(days=3),
        )
    )

    assert verdict.stalled is False
    assert verdict.state == "idle"


def test_every_slot_wedged_is_a_stall_even_with_an_empty_wait_list() -> None:
    """The deadlock can be caught before the backlog builds up.

    On 2026-08-25 the wait list only reached 3,321 because ingest kept feeding
    it for a fortnight. In the first minutes after the wedge, wait was near
    zero and the only evidence was 5 active jobs that never finished. Waiting
    for a backlog to accumulate would throw away that head start.
    """
    verdict = evaluate_pipeline_progress(
        _snapshot(
            wait_depth=0,
            active_depth=5,
            last_completion_at=NOTICED_AT - timedelta(minutes=30),
            last_start_at=NOTICED_AT - timedelta(minutes=30),
        )
    )

    assert verdict.stalled is True
    assert "slot" in verdict.summary.lower()


def test_partially_occupied_slots_with_an_empty_wait_list_is_idle() -> None:
    """Fewer active jobs than slots means the worker can still accept work.

    Three long jobs running with two free slots and nothing waiting is a slow
    afternoon, not a deadlock. Only a fully occupied worker can be unable to
    pick up job number six, which is the mechanism that produced the incident.
    """
    verdict = evaluate_pipeline_progress(
        _snapshot(
            wait_depth=0,
            active_depth=3,
            last_completion_at=NOTICED_AT - timedelta(minutes=30),
            last_start_at=NOTICED_AT - timedelta(minutes=30),
        )
    )

    assert verdict.stalled is False


def test_backlog_just_under_the_threshold_does_not_fire() -> None:
    """The threshold is a real boundary, not a suggestion.

    Longest observed gap between two consecutive completions across the last
    seven days of live traffic: 11 seconds. Slowest single job ever recorded:
    100 seconds. Nineteen minutes of silence is already far outside anything
    production has produced, but the alarm holds until the stated threshold so
    that the number in the runbook is the number in the code.
    """
    verdict = evaluate_pipeline_progress(
        _snapshot(
            wait_depth=2893,
            active_depth=5,
            last_completion_at=NOTICED_AT - timedelta(seconds=STALL_THRESHOLD_SECONDS - 1),
        )
    )

    assert verdict.stalled is False

    fired = evaluate_pipeline_progress(
        _snapshot(
            wait_depth=2893,
            active_depth=5,
            last_completion_at=NOTICED_AT - timedelta(seconds=STALL_THRESHOLD_SECONDS),
        )
    )

    assert fired.stalled is True


def test_worker_that_starts_jobs_but_finishes_none_is_stalled() -> None:
    """Starting work is not progress. Finishing it is.

    `queue_jobs.started_at` is refreshed every time a job is leased or retried,
    so a worker that picks jobs up and never completes them keeps that column
    moving. Only `completed_at` proves a job reached a terminal state, which is
    why the alarm is defined on completions and `last_start_at` is carried for
    diagnosis only.
    """
    verdict = evaluate_pipeline_progress(
        _snapshot(
            wait_depth=1200,
            active_depth=5,
            last_completion_at=NOTICED_AT - timedelta(hours=6),
            last_start_at=NOTICED_AT - timedelta(seconds=2),
        )
    )

    assert verdict.stalled is True


def test_backlog_with_no_completion_ever_recorded_is_stalled() -> None:
    """A worker that has never completed anything, with work waiting, is broken.

    This is the deploy that came up, leased jobs and wedged before the first
    completion. There is no `max(completed_at)` to compare against, so the age
    of the most recent evidence of life is used instead.
    """
    verdict = evaluate_pipeline_progress(
        _snapshot(
            wait_depth=800,
            active_depth=5,
            last_completion_at=None,
            last_start_at=NOTICED_AT - timedelta(hours=2),
        )
    )

    assert verdict.stalled is True
    assert verdict.seconds_since_completion is None


def test_untouched_queue_with_no_history_is_unknown_not_stalled() -> None:
    """A brand new database must not page anybody.

    An empty `queue_jobs` table means the pipeline has never run here. That is
    a fresh install or a restored database, not a deadlock, and the honest
    answer is that there is not enough evidence to judge.
    """
    verdict = evaluate_pipeline_progress(
        _snapshot(
            wait_depth=40,
            active_depth=0,
            last_completion_at=None,
            last_start_at=None,
        )
    )

    assert verdict.stalled is False
    assert verdict.state == "unknown"


def test_summary_carries_the_numbers_an_operator_needs() -> None:
    """The SMS body is the whole diagnosis for someone holding a phone.

    It has to say how long nothing has finished, how much work is queued and
    how many slots are occupied, because the operator will decide whether to
    restart production from that one line.
    """
    verdict = evaluate_pipeline_progress(
        _snapshot(
            wait_depth=3321,
            active_depth=5,
            last_completion_at=NOTICED_AT - timedelta(minutes=45),
        )
    )

    assert "45m" in verdict.summary
    assert "3321 waiting" in verdict.summary
    assert "5/5" in verdict.summary


def test_naive_timestamps_are_rejected() -> None:
    """Timezone-naive timestamps silently compare wrong and would hide a stall."""
    with pytest.raises(ValueError, match="timezone"):
        evaluate_pipeline_progress(
            _snapshot(last_completion_at=datetime(2026, 9, 8, 8, 0)),
        )

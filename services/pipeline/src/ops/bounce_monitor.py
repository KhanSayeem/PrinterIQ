"""The bounce rate alarm: read Instantly, judge it, page the operator.

Same shape as `stall_monitor`, for the same reasons. A one-shot process PM2
restarts on a cron, a pure detector that takes a snapshot and returns a
verdict, and throttling held in Redis so it survives the process exiting.
Nothing here lives inside the pipeline worker, because a worker that has
wedged cannot report on itself.

The one thing this monitor does not share with the stall alarm is its source
of truth. It reads Instantly directly rather than our own tables, because our
tables only learn about a bounce through a webhook that silently dropped every
event for months until #165 fixed it today. An alarm about deliverability
cannot be built on a feed that has already been silent for a whole quarter.

Two tiers, throttled separately
-------------------------------
3% and 40% call for different reactions, so they are different messages, and
they hold different cooldown keys. A single shared key would let a mild alert
claimed at 09:00 swallow a catastrophic one at 09:15, which is the one
suppression this alarm must never perform.

Usage on the VPS:

    python -m ops.bounce_monitor --once            # one check, what PM2 runs
    python -m ops.bounce_monitor --once --dry-run  # print the SMS, send nothing
    python -m ops.bounce_monitor                   # loop, for a foreground watch
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import logging
import os
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Protocol

# PM2 runs this file by path, so `src` is not on sys.path when it starts.
# Mirrors the bootstrap in ops/stall_monitor.py.
if __package__ in {None, "", "src.ops"}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from clients.instantly_client import InstantlyClient
from env import load_pipeline_env
from ops.alerting import OpsAlert
from ops.bounce_detector import (
    BOUNCE_RATE_THRESHOLD,
    CATASTROPHIC_BOUNCE_RATE_THRESHOLD,
    MINIMUM_SENDS_FOR_RATE,
    BounceSnapshot,
    BounceVerdict,
    CampaignBounceCounts,
    evaluate_bounce_rate,
)
from ops.stall_monitor import AlertSink, AlertThrottle, RedisAlertThrottle, build_alert_sink

logger = logging.getLogger(__name__)

# One SMS an hour per tier while a breach persists.
#
# Matches the stall alarm deliberately. The operator has one number and one
# tolerance for being paged, and two alarms with different rhythms would be
# harder to reason about at 3am than two alarms with the same one.
BOUNCE_ALERT_COOLDOWN_SECONDS = 60 * 60

# How often the loop mode re-checks. PM2's cron does this in production.
#
# Slower than the stall monitor's 5 minutes because the signal moves slower: a
# bounce rate is a daily aggregate and cannot change meaningfully inside a
# quarter of an hour, and each check is a live Instantly API call.
CHECK_INTERVAL_SECONDS = 15 * 60

ELEVATED_STATE_KEY = "printeriq:ops:bounce_rate:elevated"
CRITICAL_STATE_KEY = "printeriq:ops:bounce_rate:critical"

# The reply agent sends `subject: body`, so the subject is a label and the body
# carries the whole diagnosis. One subject for all three messages, because the
# tier is already the first word of the body and paying for the same words
# twice in a 320 character cap is how the approved action gets truncated off
# the end.
ALERT_SUBJECT = "PrinterIQ bounce alarm"

# How many days of sending the rate is measured over.
#
# One day, because that is the unit the estate is managed in: ADR 005 ramps
# per day, and Google's own spam rate line is "calculated daily". A trailing
# multi-day window would dilute a bad afternoon into an average that never
# crosses anything, which is how the rate that burns a domain hides.
#
# The cost is that every window starts empty. Until the day has produced 30
# sends the verdict is `insufficient_volume`, so the alarm arms as the send
# window fills rather than at midnight.
# Two UTC dates, because one cannot contain an Australian sending day.
#
# Instantly buckets its analytics by UTC. The campaigns send 09:00 to 17:00
# Australia/Melbourne, which in AEST is 23:00 to 07:00 UTC, so a single
# Australian sending day always straddles UTC midnight and always lands in two
# different UTC dates.
#
# Measured against production on 2026-09-10, for a day that really sent 30 and
# bounced 3: asking for `2026-09-10` alone returned 2 sent, while `2026-09-09`
# to `2026-09-10` returned 30 and 3. With a one day window and a floor of 30
# the monitor reported "not enough volume to judge" and would have done so
# every day for ever, never once judging the rate.
#
# The cost of the wider span, stated plainly: the earlier UTC date also holds
# the previous Australian day's afternoon, so both counts carry up to half a
# day of older traffic. A bounce *rate* over that span is still a real rate,
# which is why this is acceptable, but it is not "today" and nothing may call
# it that. See _format_window.
#
# Sub-day bounding is not available: verified that a one hour range on this
# endpoint, 2026-09-10T13:00:00Z to T14:00:00Z with zero sends inside it, still
# returned the whole 2026-09-10 UTC day. The endpoint truncates its range to
# calendar dates and sums every day it touches.
DEFAULT_WINDOW_DAYS = 2

Clock = Callable[[], datetime]


class BounceReader(Protocol):
    async def read_bounces(self) -> BounceSnapshot:
        """Return one reading of per-campaign send and bounce counts."""


@dataclass(frozen=True)
class BounceCheckResult:
    verdict: BounceVerdict
    alert_sent: bool
    recovery_sent: bool
    suppressed_by_cooldown: bool
    read_failed: bool


class CampaignAnalyticsReader:
    """Reads send and bounce counts for the configured campaigns.

    Scoped to the campaign ids it was given rather than trusting whatever the
    endpoint returns. The Instantly workspace also holds 10 accounts on
    `adsiqdigital.com` and `buildpredictiqdigital.com`, which ADR 005 states
    plainly are not PrinterIQ capacity, and 4,000 clean sends from another
    project would wash a PrinterIQ breach out of the average entirely.
    """

    def __init__(
        self,
        *,
        client: InstantlyClient,
        campaign_ids: Sequence[str],
        window_days: int = DEFAULT_WINDOW_DAYS,
        clock: Clock | None = None,
    ) -> None:
        self._client = client
        self._campaign_ids = tuple(campaign_ids)
        self._window_days = window_days
        self._clock = clock or (lambda: datetime.now(UTC))

    async def read_bounces(self) -> BounceSnapshot:
        observed_at = self._clock()
        end_date = observed_at.date()
        start_date = end_date - timedelta(days=self._window_days - 1)

        rows = await self._client.fetch_campaign_analytics(
            campaign_ids=self._campaign_ids,
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
        )

        wanted = set(self._campaign_ids)
        campaigns = tuple(
            CampaignBounceCounts(
                campaign_id=campaign_id,
                emails_sent_count=_required_count(row, "emails_sent_count"),
                bounced_count=_required_count(row, "bounced_count"),
            )
            for row in rows
            if (campaign_id := str(row.get("campaign_id", ""))) in wanted
        )

        return BounceSnapshot(
            observed_at=observed_at,
            window_days=self._window_days,
            campaigns=campaigns,
        )


async def run_bounce_check(
    *,
    reader: BounceReader,
    sink: AlertSink,
    elevated_throttle: AlertThrottle,
    critical_throttle: AlertThrottle,
    threshold: float = BOUNCE_RATE_THRESHOLD,
    catastrophic_threshold: float = CATASTROPHIC_BOUNCE_RATE_THRESHOLD,
    minimum_sends: int = MINIMUM_SENDS_FOR_RATE,
    alert_cooldown_seconds: float = BOUNCE_ALERT_COOLDOWN_SECONDS,
) -> BounceCheckResult:
    """Take one reading, judge it, and page or stand down accordingly."""
    snapshot = await reader.read_bounces()
    verdict = evaluate_bounce_rate(
        snapshot,
        threshold=threshold,
        catastrophic_threshold=catastrophic_threshold,
        minimum_sends=minimum_sends,
    )

    def result(
        *,
        alert_sent: bool = False,
        recovery_sent: bool = False,
        suppressed: bool = False,
        read_failed: bool = False,
    ) -> BounceCheckResult:
        return BounceCheckResult(
            verdict=verdict,
            alert_sent=alert_sent,
            recovery_sent=recovery_sent,
            suppressed_by_cooldown=suppressed,
            read_failed=read_failed,
        )

    if verdict.state == "unknown":
        # The read came back with nothing to judge. Not an alert, because an
        # SMS cannot fix a broken API call and the Twilio balance is finite,
        # but not silence either: the caller turns this into a non-zero exit
        # so `pm2 status` shows the monitor errored.
        logger.error("Bounce check could not read campaign analytics")
        return result(read_failed=True)

    if verdict.state == "insufficient_volume":
        # Deliberately inert. Not an alert, and, just as importantly, not a
        # recovery either. Every window starts at 0 sent, so treating an empty
        # window as recovery would follow a breach found at 18:00 with a
        # "recovered" text at 00:05 while nothing had changed but the date.
        # A standing alert is cleared only by evidence, which means a healthy
        # reading built on enough volume to mean something.
        logger.info("Bounce rate not judged: %s sent, below the floor", verdict.emails_sent)
        return result()

    if not verdict.breached:
        cleared_critical = await critical_throttle.clear_alert()
        cleared_elevated = await elevated_throttle.clear_alert()
        if not (cleared_critical or cleared_elevated):
            return result()
        await sink.send_ops_alert(
            OpsAlert(subject=ALERT_SUBJECT, body=f"Recovered. {verdict.summary}")
        )
        return result(recovery_sent=True)

    throttle = critical_throttle if verdict.critical else elevated_throttle

    if not await throttle.claim_alert(cooldown_seconds=alert_cooldown_seconds):
        logger.warning("Bounce rate still %s, alert suppressed by cooldown", verdict.state)
        return result(suppressed=True)

    try:
        await sink.send_ops_alert(OpsAlert(subject=ALERT_SUBJECT, body=verdict.summary))
    except Exception:
        # Claim first, send second. A claim that stands with no SMS behind it
        # silences the next hour having paged nobody, so it is handed back
        # before the error propagates.
        await throttle.clear_alert()
        raise

    return result(alert_sent=True)


def _required_count(row: dict[str, object], field_name: str) -> int:
    """Read one integer, or refuse.

    Defaulting a missing field to 0 would turn an Instantly field rename into
    a permanently healthy alarm, which is the same failure as the bounce
    webhook that dropped every event for months. The error message carries the
    field name only, never the row, because analytics rows carry campaign
    names and this string ends up in logs.
    """
    value = row.get(field_name)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"Campaign analytics row is missing {field_name}")
    return int(value)


def _required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing env var: {name}")
    return value


def _optional_float_env(name: str, default: float) -> float:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    return float(raw)


def _optional_int_env(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    return int(raw)


def _configured_campaign_ids() -> tuple[str, ...]:
    """The PrinterIQ campaigns, from the same env vars the pipeline sends to.

    Read from `INSTANTLY_CAMPAIGN_ID` and `INSTANTLY_NO_WEBSITE_CAMPAIGN_ID`
    rather than a list of its own, so the alarm cannot end up watching a
    different set of campaigns than the ones being sent to.
    """
    campaign_ids = []
    for name in ("INSTANTLY_CAMPAIGN_ID", "INSTANTLY_NO_WEBSITE_CAMPAIGN_ID"):
        value = (os.getenv(name) or "").strip()
        if value and value not in campaign_ids:
            campaign_ids.append(value)
    if not campaign_ids:
        raise RuntimeError("Missing env var: INSTANTLY_CAMPAIGN_ID")
    return tuple(campaign_ids)


async def _run_checks(*, once: bool, dry_run: bool) -> BounceCheckResult:
    load_pipeline_env()
    campaign_ids = _configured_campaign_ids()
    sink = build_alert_sink(dry_run=dry_run, source="pipeline-bounce-monitor")

    threshold = _optional_float_env("BOUNCE_RATE_THRESHOLD", BOUNCE_RATE_THRESHOLD)
    catastrophic_threshold = _optional_float_env(
        "BOUNCE_RATE_CRITICAL_THRESHOLD", CATASTROPHIC_BOUNCE_RATE_THRESHOLD
    )
    minimum_sends = _optional_int_env("BOUNCE_RATE_MIN_SENDS", MINIMUM_SENDS_FOR_RATE)
    window_days = _optional_int_env("BOUNCE_RATE_WINDOW_DAYS", DEFAULT_WINDOW_DAYS)

    redis_client = importlib.import_module("clients.redis_client").get_redis_client()
    reader = CampaignAnalyticsReader(
        client=InstantlyClient(api_key=_required_env("INSTANTLY_API_KEY")),
        campaign_ids=campaign_ids,
        window_days=window_days,
    )

    try:
        while True:
            result = await run_bounce_check(
                reader=reader,
                sink=sink,
                elevated_throttle=RedisAlertThrottle(redis=redis_client, key=ELEVATED_STATE_KEY),
                critical_throttle=RedisAlertThrottle(redis=redis_client, key=CRITICAL_STATE_KEY),
                threshold=threshold,
                catastrophic_threshold=catastrophic_threshold,
                minimum_sends=minimum_sends,
            )
            print(result.verdict.summary)
            # Per-campaign counts go to stdout only. The SMS carries the
            # estate total because that is what the approved decision acts on,
            # but a split of 0% and 20% is worth seeing on the box. Ids and
            # counts only, never a campaign name from the API response.
            for campaign in result.verdict.snapshot.campaigns:
                print(
                    f"  campaign {campaign.campaign_id}: "
                    f"{campaign.bounced_count} bounced of {campaign.emails_sent_count} sent"
                )
            if once:
                return result
            await asyncio.sleep(CHECK_INTERVAL_SECONDS)
    finally:
        await redis_client.aclose()


def main() -> int:
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="PrinterIQ cold email bounce rate alarm")
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
        # Exit non-zero is the check failing, which is different from finding a
        # high bounce rate. PM2 shows it as errored and an operator can tell
        # the two apart without reading the log.
        logger.error("Bounce rate check failed: %s", error.__class__.__name__)
        raise

    # A found breach still exits 0: the alarm is the SMS, not the exit code, and
    # a non-zero exit would make PM2 report the monitor as broken when it is
    # working perfectly. A read that returned nothing to judge is the one case
    # that does exit non-zero, because then the alarm really is blind.
    return 1 if result.read_failed else 0


if __name__ == "__main__":
    sys.exit(main())

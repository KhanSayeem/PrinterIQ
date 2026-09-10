from __future__ import annotations

from datetime import UTC, datetime

import pytest

from ops.bounce_detector import (
    BOUNCE_RATE_THRESHOLD,
    CATASTROPHIC_BOUNCE_RATE_THRESHOLD,
    MINIMUM_SENDS_FOR_RATE,
    BounceSnapshot,
    CampaignBounceCounts,
    evaluate_bounce_rate,
)

# The first live sending day. Two PrinterIQ AU campaigns went out and
# `GET /api/v2/campaigns/analytics` reported 30 sent and 3 bounced between
# them, which is the 10% reading every scenario below is anchored to.
FIRST_SENDING_DAY = datetime(2026, 9, 10, 18, 0, tzinfo=UTC)

CAMPAIGN_WITH_WEBSITE = "campaign-with-website"
CAMPAIGN_NO_WEBSITE = "campaign-no-website"


def _snapshot(
    *,
    observed_at: datetime = FIRST_SENDING_DAY,
    window_days: int = 1,
    campaigns: tuple[CampaignBounceCounts, ...] | None = None,
) -> BounceSnapshot:
    if campaigns is None:
        campaigns = (
            CampaignBounceCounts(
                campaign_id=CAMPAIGN_WITH_WEBSITE,
                emails_sent_count=20,
                bounced_count=2,
            ),
            CampaignBounceCounts(
                campaign_id=CAMPAIGN_NO_WEBSITE,
                emails_sent_count=10,
                bounced_count=1,
            ),
        )
    return BounceSnapshot(
        observed_at=observed_at,
        window_days=window_days,
        campaigns=campaigns,
    )


def _one_campaign(*, sent: int, bounced: int) -> tuple[CampaignBounceCounts, ...]:
    return (
        CampaignBounceCounts(
            campaign_id=CAMPAIGN_WITH_WEBSITE,
            emails_sent_count=sent,
            bounced_count=bounced,
        ),
    )


def test_first_sending_day_reading_is_a_breach() -> None:
    """The headline case: today's real numbers from Instantly.

    30 sent and 3 bounced across the two live PrinterIQ AU campaigns is 10%,
    more than three times the operating threshold, on the very first day the
    estate sent anything at volume. This is the reading the alarm exists for,
    and the counts are summed across campaigns because deliverability damage
    is done to the sending domains, which both campaigns share.
    """
    verdict = evaluate_bounce_rate(_snapshot())

    assert verdict.state == "elevated"
    assert verdict.breached is True
    assert verdict.emails_sent == 30
    assert verdict.bounced == 3
    assert verdict.bounce_rate == pytest.approx(0.1)


def test_summary_carries_the_rate_the_counts_and_the_approved_action() -> None:
    """The SMS body is the entire briefing for someone holding a phone.

    The operator has an approved decision waiting on this number, which is to
    pull the remaining unverified email bucket from the campaigns while the
    rate stays above 3%. A message that reported a rate without naming that
    decision would send them to a laptop to find out what to do, which is the
    delay the alarm is supposed to remove.
    """
    verdict = evaluate_bounce_rate(_snapshot())

    summary = verdict.summary
    assert "10.0%" in summary
    assert "3 bounced of 30 sent" in summary
    assert "2 campaigns" in summary
    assert "3%" in summary
    assert "unverified" in summary


def test_rate_at_the_threshold_fires_and_just_under_it_does_not() -> None:
    """The threshold is a boundary, so both sides of it are pinned down.

    A monitor that fired at 2.9% would page on days that are inside the
    operating rule, and one that held until 3.1% would sit quiet on a day that
    has already broken it. The number in the runbook has to be the number in
    the code, so equality fires.
    """
    at_threshold = evaluate_bounce_rate(_snapshot(campaigns=_one_campaign(sent=100, bounced=3)))

    assert at_threshold.bounce_rate == pytest.approx(BOUNCE_RATE_THRESHOLD)
    assert at_threshold.breached is True
    assert at_threshold.state == "elevated"

    just_under = evaluate_bounce_rate(_snapshot(campaigns=_one_campaign(sent=1000, bounced=29)))

    assert just_under.bounce_rate == pytest.approx(0.029)
    assert just_under.breached is False
    assert just_under.state == "healthy"

    just_over = evaluate_bounce_rate(_snapshot(campaigns=_one_campaign(sent=1000, bounced=31)))

    assert just_over.breached is True


def test_below_the_volume_floor_is_its_own_verdict_not_healthy() -> None:
    """One bounce out of two sends is 50% and means nothing.

    But the answer to "is 50% of two sends a problem" is "we cannot tell yet",
    not "everything is fine". Folding the two together is how a real problem
    hides: a campaign that sent 4 emails and bounced 2 would report healthy,
    and the operator would read a green line as evidence the estate is safe.
    `stall_detector` keeps idle as its own state for the same reason.
    """
    verdict = evaluate_bounce_rate(_snapshot(campaigns=_one_campaign(sent=2, bounced=1)))

    assert verdict.state == "insufficient_volume"
    assert verdict.breached is False
    assert verdict.bounce_rate == pytest.approx(0.5)
    assert "not enough volume" in verdict.summary.lower()
    # The words that would let an operator mistake this for an all clear.
    assert "healthy" not in verdict.summary.lower()
    assert "below the" not in verdict.summary.lower()


def test_volume_floor_is_the_ramp_day_one_volume_and_clears_at_it() -> None:
    """The floor is 30, which is day 1 of the ramp in ADR 005.

    A floor a normal sending day never reaches makes the alarm decorative, and
    the smallest day the ramp deliberately produces is 30 sends. So 30 sends
    is judged and 29 is not, which means the alarm is live on the very first
    day of a ramp rather than waiting for volume to build.

    At exactly 30 sends a single bounce is 3.3% and fires. That is deliberate
    and consistent with ADR 005, which halts the ramp on any meaningful rise
    in bounces rather than on a ratio, because at ramp volumes a ratio is
    nearly meaningless.
    """
    assert MINIMUM_SENDS_FOR_RATE == 30

    one_short = evaluate_bounce_rate(_snapshot(campaigns=_one_campaign(sent=29, bounced=3)))

    assert one_short.state == "insufficient_volume"

    at_the_floor = evaluate_bounce_rate(_snapshot(campaigns=_one_campaign(sent=30, bounced=1)))

    assert at_the_floor.state == "elevated"
    assert at_the_floor.bounce_rate == pytest.approx(1 / 30)


def test_catastrophic_rate_is_its_own_more_urgent_verdict() -> None:
    """3% and 40% call for different reactions, so they are different states.

    3% means pull the unverified bucket and hold the ramp. 40% means the list
    segment is dead and sending should stop now, before another batch goes
    out. One shared verdict would send the same text for both and the operator
    would have to judge the severity from the rate alone at 3am.
    """
    verdict = evaluate_bounce_rate(_snapshot(campaigns=_one_campaign(sent=50, bounced=21)))

    assert verdict.state == "critical"
    assert verdict.breached is True
    assert verdict.bounce_rate == pytest.approx(0.42)
    assert "pause sending" in verdict.summary.lower()


def test_catastrophic_boundary_fires_at_the_ceiling_and_not_below_it() -> None:
    """The urgent tier has a real boundary too, not a vibe."""
    assert CATASTROPHIC_BOUNCE_RATE_THRESHOLD == 0.15

    at_ceiling = evaluate_bounce_rate(_snapshot(campaigns=_one_campaign(sent=100, bounced=15)))

    assert at_ceiling.state == "critical"

    just_under = evaluate_bounce_rate(_snapshot(campaigns=_one_campaign(sent=1000, bounced=149)))

    assert just_under.state == "elevated"
    assert just_under.breached is True


def test_catastrophic_rate_below_the_volume_floor_still_waits_for_volume() -> None:
    """Two sends and two bounces is 100% and still proves nothing.

    The urgent tier is the same signal read at a higher level, so it inherits
    the same evidence requirement. Letting it skip the floor would make the
    most alarming message in the system the one with the least behind it.
    """
    verdict = evaluate_bounce_rate(_snapshot(campaigns=_one_campaign(sent=2, bounced=2)))

    assert verdict.state == "insufficient_volume"
    assert verdict.breached is False


def test_no_sends_at_all_is_insufficient_volume_not_a_divide_by_zero() -> None:
    """Before the send window opens the day has no sends in it.

    The monitor runs on a cron all day, so most of its checks land on a window
    that has not filled up yet. Zero sent must be an honest "nothing to judge"
    rather than an exception that shows up as an errored PM2 process.
    """
    verdict = evaluate_bounce_rate(_snapshot(campaigns=_one_campaign(sent=0, bounced=0)))

    assert verdict.state == "insufficient_volume"
    assert verdict.bounce_rate == pytest.approx(0.0)


def test_no_campaigns_returned_is_unknown_rather_than_healthy() -> None:
    """An empty analytics response is a broken read, not a clean estate.

    If the campaign ids drift or the API returns nothing for them, summing an
    empty list gives 0 sent and 0 bounced, which would otherwise look exactly
    like a quiet morning. This project has already shipped a webhook that
    silently dropped every event for months, so a read that returned nothing
    at all says so instead of blending into the healthy case.
    """
    verdict = evaluate_bounce_rate(_snapshot(campaigns=()))

    assert verdict.state == "unknown"
    assert verdict.breached is False
    assert "no campaign" in verdict.summary.lower()


def test_thresholds_are_configurable_and_the_summary_quotes_the_one_in_use() -> None:
    """ADR 005 declines to endorse any bounce rate figure at all.

    It records that no official Google or Microsoft bounce-rate threshold
    exists and that the commonly cited "under 2%" is vendor blog material. 3%
    is therefore a PrinterIQ operating choice rather than a vendor number, so
    it has to be tunable without a deploy, and the message has to quote the
    threshold actually in force rather than a hardcoded string.
    """
    assert BOUNCE_RATE_THRESHOLD == 0.03

    verdict = evaluate_bounce_rate(
        _snapshot(campaigns=_one_campaign(sent=1000, bounced=25)),
        threshold=0.02,
    )

    assert verdict.breached is True
    assert "2%" in verdict.summary

    tolerant = evaluate_bounce_rate(
        _snapshot(campaigns=_one_campaign(sent=1000, bounced=25)),
        threshold=0.05,
    )

    assert tolerant.breached is False


def test_minimum_sends_is_configurable_for_a_higher_volume_estate() -> None:
    """The floor is tied to today's ramp, and the ramp ends at 155 a day.

    Once the estate is at full volume a 30 send floor is met before breakfast
    and a higher floor would be the honest one, so the number is an argument
    rather than a constant baked into the comparison.
    """
    verdict = evaluate_bounce_rate(
        _snapshot(campaigns=_one_campaign(sent=100, bounced=10)),
        minimum_sends=155,
    )

    assert verdict.state == "insufficient_volume"
    assert "155" in verdict.summary


def test_naive_observation_timestamp_is_rejected() -> None:
    """Matches stall_detector: a naive timestamp compares wrong and hides."""
    with pytest.raises(ValueError, match="timezone"):
        evaluate_bounce_rate(_snapshot(observed_at=datetime(2026, 9, 10, 18, 0)))


def test_negative_counts_from_the_api_are_rejected_rather_than_averaged_away() -> None:
    """A negative count is a parsing bug, and it would dilute the rate.

    Summing a negative `bounced_count` into the total would push the rate down
    and could turn a real breach into a healthy reading, which is the one
    failure direction that must never happen quietly.
    """
    with pytest.raises(ValueError, match="negative"):
        evaluate_bounce_rate(_snapshot(campaigns=_one_campaign(sent=30, bounced=-1)))

    with pytest.raises(ValueError, match="negative"):
        evaluate_bounce_rate(_snapshot(campaigns=_one_campaign(sent=-30, bounced=1)))


def test_more_bounces_than_sends_is_rejected() -> None:
    """Impossible arithmetic means the two fields were read from the wrong keys."""
    with pytest.raises(ValueError, match="exceed"):
        evaluate_bounce_rate(_snapshot(campaigns=_one_campaign(sent=10, bounced=11)))


def test_summary_never_carries_an_email_address_or_a_campaign_name() -> None:
    """The whole message goes into logs and into an SMS. Counts only.

    The project rule is no PII in logs, and the analytics response arrives with
    campaign names attached. Nothing from that response reaches the summary
    except integers, so there is nothing in it to leak.
    """
    verdict = evaluate_bounce_rate(_snapshot())

    assert "@" not in verdict.summary
    assert CAMPAIGN_WITH_WEBSITE not in verdict.summary
    assert CAMPAIGN_NO_WEBSITE not in verdict.summary

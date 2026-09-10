"""Decide whether the cold email bounce rate is burning the sending domains.

A bounce is not just a lost lead. Bounces are one of the signals mailbox
providers use to judge a sender, and the PrinterIQ estate is 8 Prescia
mailboxes across 4 domains with almost no sending history behind them: ADR 005
records roughly 29 real cold emails sent in total before the ramp began. A
sender that thin has no reputation to absorb a bad list segment, so a bounce
rate left unwatched for a few days does not cost a few leads, it costs the
domains.

Why this reads Instantly and not our own database
-------------------------------------------------
Our `leads` tables only learn that an address bounced when Instantly posts a
bounce webhook, and that webhook silently dropped every event for months
until it was fixed today in #165. A deliverability alarm built on a source
that has already been silent for months would inherit exactly the failure it
is supposed to catch, so the counts come from
`GET /api/v2/campaigns/analytics`, which is what Instantly itself believes.

What ADR 005 actually says about the numbers
--------------------------------------------
ADR 005 does not set a bounce rate threshold, and it is worth being precise
about that rather than inventing a provider or a vendor to stand behind one:

* "No official Google or Microsoft bounce-rate threshold exists. The commonly
  cited 'under 2%' figure is vendor blog material, not provider guidance."
* Bounces are listed as something to watch, not to rate-limit: the ramp halts
  on "any meaningful rise in bounces".
* The percentage figures the ADR does carry are Google's *spam* rate lines
  (0.1% target, 0.3% never), and its own arithmetic that at 30 sends a day a
  single complaint is 3.3%, which is why its complaint rule is an absolute
  count rather than a ratio.

So 3% here is a PrinterIQ operating choice, not a vendor number. It is the
figure the operator's approved decision is already keyed to, it sits above the
2% the ADR dismisses as blog material, and at the ramp's day 1 volume of 30
sends it is effectively "more than one bounce today", which is the same
absolute-count reasoning the ADR applies to complaints. It is an argument to
`evaluate_bounce_rate`, not a constant, because a number nobody can defend
from provider guidance is a number that will need changing.

Why both halves of the rule matter
----------------------------------
A rate needs a denominator worth dividing by. One bounce out of two sends is
50% and means nothing at all, and an alarm that fired on it would be muted
within a week, which would take the real alarm down with it. So a breach is a
rate over the threshold *and* enough volume for the rate to carry information.

Below the floor the verdict is `insufficient_volume`, which is deliberately
not `healthy`. Those are different statements and conflating them is how a
real problem hides behind a green line. `stall_detector` keeps `idle` as its
own state for exactly this reason.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

# The operating threshold. See the module docstring: a PrinterIQ choice, not a
# published provider figure, because no provider publishes one.
BOUNCE_RATE_THRESHOLD = 0.03

# The urgent tier. 3% means the list is drifting and the approved fix is to
# pull the unverified bucket. 15% means the segment is dead, or a whole MX is
# refusing us, and the reaction is to stop sending before the next batch goes.
#
# 15% is 5 times the operating threshold, and the gap is real in counts and
# not just in decimals: at the 30 send floor, 3% is cleared by 1 bounce and
# 15% needs 5. That separation is what stops the urgent message from firing on
# the same evidence as the ordinary one.
CATASTROPHIC_BOUNCE_RATE_THRESHOLD = 0.15

# The volume floor, taken from day 1 of the ramp in ADR 005.
#
# The ramp is 30, 45, 68, 101, 152, 155 sends per day, so 30 is the smallest
# volume the estate deliberately produces on a live day. A floor above it
# would leave the alarm silent through the first two days of a ramp, which is
# precisely when a cold domain is most exposed and when the ADR most wants
# bounces watched. A floor below it starts reporting rates built on a handful
# of sends, which is the 1-out-of-2-is-50% problem.
#
# The honest cost of picking 30: at exactly 30 sends a single bounce is 3.3%
# and fires. That is accepted rather than worked around, because ADR 005 takes
# the same position on complaints, halting the ramp on an absolute count
# precisely because a ratio at ramp volume is nearly meaningless. Once the
# estate holds 155 a day this floor should rise, which is why it is an
# argument.
MINIMUM_SENDS_FOR_RATE = 30

BounceState = Literal["healthy", "insufficient_volume", "elevated", "critical", "unknown"]


@dataclass(frozen=True)
class CampaignBounceCounts:
    """One campaign's row from `GET /api/v2/campaigns/analytics`.

    Only the two integers are carried. The analytics response also holds the
    campaign name, and nothing from it is allowed anywhere near the summary,
    which ends up in both a log line and an SMS.
    """

    campaign_id: str
    emails_sent_count: int
    bounced_count: int


@dataclass(frozen=True)
class BounceSnapshot:
    """One reading of the live campaigns, summed across the sending estate.

    Summed rather than judged per campaign on purpose. The two PrinterIQ AU
    campaigns send from the same 8 mailboxes across the same 4 domains, so
    reputation damage from either lands on both, and the operator's approved
    decision applies to the campaigns together.
    """

    observed_at: datetime
    window_days: int
    campaigns: tuple[CampaignBounceCounts, ...]

    @property
    def emails_sent(self) -> int:
        return sum(campaign.emails_sent_count for campaign in self.campaigns)

    @property
    def bounced(self) -> int:
        return sum(campaign.bounced_count for campaign in self.campaigns)


@dataclass(frozen=True)
class BounceVerdict:
    state: BounceState
    summary: str
    bounce_rate: float
    emails_sent: int
    bounced: int
    threshold: float
    snapshot: BounceSnapshot

    @property
    def breached(self) -> bool:
        """True when the operator needs to be told, at either urgency."""
        return self.state in {"elevated", "critical"}

    @property
    def critical(self) -> bool:
        return self.state == "critical"


def evaluate_bounce_rate(
    snapshot: BounceSnapshot,
    *,
    threshold: float = BOUNCE_RATE_THRESHOLD,
    catastrophic_threshold: float = CATASTROPHIC_BOUNCE_RATE_THRESHOLD,
    minimum_sends: int = MINIMUM_SENDS_FOR_RATE,
) -> BounceVerdict:
    """Classify one reading as healthy, insufficient, elevated or critical."""
    _require_aware(snapshot.observed_at, "observed_at")
    _validate_counts(snapshot)

    emails_sent = snapshot.emails_sent
    bounced = snapshot.bounced
    bounce_rate = (bounced / emails_sent) if emails_sent > 0 else 0.0
    window = _format_window(snapshot.window_days)
    campaign_phrase = _campaign_phrase(len(snapshot.campaigns))

    def verdict(state: BounceState, summary: str) -> BounceVerdict:
        return BounceVerdict(
            state=state,
            summary=summary,
            bounce_rate=bounce_rate,
            emails_sent=emails_sent,
            bounced=bounced,
            threshold=threshold,
            snapshot=snapshot,
        )

    if not snapshot.campaigns:
        # Zero campaigns sums to 0 sent and 0 bounced, which is arithmetically
        # identical to a quiet morning and means something completely
        # different: the read failed, or the configured campaign ids no longer
        # match anything in Instantly. Saying so is the whole lesson of the
        # bounce webhook that dropped events for months.
        return verdict(
            "unknown",
            "Bounce rate unknown: Instantly returned no campaign analytics rows. "
            "Check INSTANTLY_CAMPAIGN_ID and INSTANTLY_NO_WEBSITE_CAMPAIGN_ID.",
        )

    if emails_sent < minimum_sends:
        return verdict(
            "insufficient_volume",
            f"Bounce rate not enough volume to judge: {emails_sent} sent and {bounced} bounced "
            f"across {campaign_phrase} {window}, floor is {minimum_sends} sends.",
        )

    counts = f"{bounced} bounced of {emails_sent} sent across {campaign_phrase}"

    if bounce_rate >= catastrophic_threshold:
        return verdict(
            "critical",
            f"Bounce rate CRITICAL {_format_rate(bounce_rate)} {window}, above "
            f"{_format_threshold(catastrophic_threshold)}. {counts}. Pause sending now, then "
            "pull the remaining unverified email bucket from the campaigns.",
        )

    if bounce_rate >= threshold:
        return verdict(
            "elevated",
            f"Bounce rate {_format_rate(bounce_rate)} {window}, above the "
            f"{_format_threshold(threshold)} threshold. {counts}. Approved action: pull the "
            "remaining unverified email bucket from the campaigns and hold the ramp.",
        )

    return verdict(
        "healthy",
        f"Bounce rate {_format_rate(bounce_rate)} {window}, under the "
        f"{_format_threshold(threshold)} threshold. {counts}.",
    )


def _validate_counts(snapshot: BounceSnapshot) -> None:
    """Refuse arithmetic that cannot have come from a correct read.

    A negative `bounced_count` would pull the summed rate down and could turn
    a real breach into a healthy reading, which is the one direction this
    module must never fail in quietly. More bounces than sends means the two
    fields were read from the wrong keys.
    """
    for campaign in snapshot.campaigns:
        if campaign.emails_sent_count < 0 or campaign.bounced_count < 0:
            raise ValueError("Campaign analytics carried a negative count")
        if campaign.bounced_count > campaign.emails_sent_count:
            raise ValueError("Campaign bounced_count cannot exceed emails_sent_count")


def _format_rate(rate: float) -> str:
    """The observed rate, always to one decimal place.

    10% and 10.4% are different arguments for the same decision and the
    operator should be able to see which one they have, so the measured rate
    keeps its decimal even when it lands on a round number.
    """
    return f"{rate * 100:.1f}%"


def _format_threshold(rate: float) -> str:
    """A configured threshold, with a trailing `.0` trimmed off.

    The threshold in the message has to match the threshold in the runbook
    character for character. An operator reading `3.0%` against a runbook that
    says `3%` has to stop and work out whether they are the same rule.
    """
    percent = rate * 100
    if abs(percent - round(percent)) < 0.05:
        return f"{round(percent)}%"
    return f"{percent:.1f}%"


def _format_window(window_days: int) -> str:
    if window_days == 1:
        return "today"
    return f"in the last {window_days}d"


def _campaign_phrase(count: int) -> str:
    return "1 campaign" if count == 1 else f"{count} campaigns"


def _require_aware(value: datetime, field_name: str) -> datetime:
    if value.tzinfo is None:
        raise ValueError(f"{field_name} must carry a timezone")
    return value

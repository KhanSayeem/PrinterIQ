from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx
import pytest

from clients.instantly_client import InstantlyClient
from ops.alerting import OpsAlert
from ops.bounce_detector import BounceSnapshot, CampaignBounceCounts, _format_window
from ops.bounce_monitor import (
    BOUNCE_ALERT_COOLDOWN_SECONDS,
    BounceCheckResult,
    CampaignAnalyticsReader,
    run_bounce_check,
)

FIRST_SENDING_DAY = datetime(2026, 9, 10, 18, 0, tzinfo=UTC)

CAMPAIGN_WITH_WEBSITE = "11111111-1111-1111-1111-111111111111"
CAMPAIGN_NO_WEBSITE = "22222222-2222-2222-2222-222222222222"


@dataclass
class FakeReader:
    snapshot: BounceSnapshot
    reads: int = 0

    async def read_bounces(self) -> BounceSnapshot:
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


def _snapshot(
    *,
    sent_with_website: int,
    bounced_with_website: int,
    sent_no_website: int = 0,
    bounced_no_website: int = 0,
    window_days: int = 1,
) -> BounceSnapshot:
    return BounceSnapshot(
        observed_at=FIRST_SENDING_DAY,
        window_days=window_days,
        campaigns=(
            CampaignBounceCounts(
                campaign_id=CAMPAIGN_WITH_WEBSITE,
                emails_sent_count=sent_with_website,
                bounced_count=bounced_with_website,
            ),
            CampaignBounceCounts(
                campaign_id=CAMPAIGN_NO_WEBSITE,
                emails_sent_count=sent_no_website,
                bounced_count=bounced_no_website,
            ),
        ),
    )


def _today_reading() -> BounceSnapshot:
    """The real numbers: 30 sent, 3 bounced across the two live campaigns."""
    return _snapshot(
        sent_with_website=20,
        bounced_with_website=2,
        sent_no_website=10,
        bounced_no_website=1,
    )


def _healthy_reading() -> BounceSnapshot:
    """Ramp day 5 with one bounce in 152 sends, which is 0.7%."""
    return _snapshot(
        sent_with_website=100,
        bounced_with_website=1,
        sent_no_website=52,
        bounced_no_website=0,
    )


async def _check(
    snapshot: BounceSnapshot,
    *,
    sink: FakeSink,
    elevated: FakeThrottle | None = None,
    critical: FakeThrottle | None = None,
) -> BounceCheckResult:
    return await run_bounce_check(
        reader=FakeReader(snapshot),
        sink=sink,
        elevated_throttle=elevated or FakeThrottle(),
        critical_throttle=critical or FakeThrottle(),
    )


def test_todays_reading_pages_the_operator_with_the_actionable_text() -> None:
    """End to end for the live situation: 10% in, an SMS body out.

    The detector reaching a verdict is worth nothing if the message never
    leaves the process, so the assertion is on the delivered body rather than
    on an internal flag. It has to carry the rate, the counts behind it, and
    the decision the operator has already approved.
    """

    async def scenario() -> None:
        sink = FakeSink()

        result = await _check(_today_reading(), sink=sink)

        assert isinstance(result, BounceCheckResult)
        assert result.verdict.breached is True
        assert result.alert_sent is True
        assert len(sink.sent) == 1
        body = sink.sent[0].body
        assert "10.0%" in body
        assert "3 bounced of 30 sent" in body
        assert "unverified email bucket" in body

    asyncio.run(scenario())


def test_healthy_rate_sends_nothing_and_burns_no_claim() -> None:
    """A good day must not touch the cooldown keys at all."""

    async def scenario() -> None:
        sink = FakeSink()
        elevated = FakeThrottle()
        critical = FakeThrottle()

        result = await _check(
            _healthy_reading(),
            sink=sink,
            elevated=elevated,
            critical=critical,
        )

        assert result.verdict.state == "healthy"
        assert result.alert_sent is False
        assert result.recovery_sent is False
        assert sink.sent == []
        assert elevated.claims == 0
        assert critical.claims == 0

    asyncio.run(scenario())


def test_second_check_in_the_same_period_is_suppressed() -> None:
    """A rate that stays high all day must not page on every cron tick.

    The monitor runs every 15 minutes, so an unthrottled alarm would send 96
    messages a day. The operator would mute the number and the next real
    breach would go unread, which is worse than having no alarm.
    """

    async def scenario() -> None:
        sink = FakeSink()
        elevated = FakeThrottle(claimable=False)

        result = await _check(_today_reading(), sink=sink, elevated=elevated)

        assert result.verdict.breached is True
        assert result.alert_sent is False
        assert result.suppressed_by_cooldown is True
        assert sink.sent == []

    asyncio.run(scenario())


def test_critical_has_its_own_cooldown_so_an_elevated_page_cannot_mute_it() -> None:
    """3% at 09:00 must not silence 40% at 09:15.

    A single shared cooldown key would do exactly that: the elevated alert
    claims the hour, the rate then collapses to catastrophic, and the urgent
    message is swallowed by a claim made for the mild one. The tiers are
    throttled separately so the more urgent message always gets through.
    """

    async def scenario() -> None:
        sink = FakeSink()
        elevated = FakeThrottle(claimable=False, outstanding=True)
        critical = FakeThrottle()

        result = await _check(
            _snapshot(sent_with_website=50, bounced_with_website=21),
            sink=sink,
            elevated=elevated,
            critical=critical,
        )

        assert result.verdict.state == "critical"
        assert result.alert_sent is True
        assert critical.claims == 1
        assert len(sink.sent) == 1
        assert "CRITICAL" in sink.sent[0].body
        assert "pause sending" in sink.sent[0].body.lower()

    asyncio.run(scenario())


def test_recovery_is_announced_once_after_a_breach() -> None:
    """The operator needs to know it is over without opening a dashboard."""

    async def scenario() -> None:
        sink = FakeSink()
        elevated = FakeThrottle(outstanding=True)
        critical = FakeThrottle()

        result = await _check(
            _healthy_reading(),
            sink=sink,
            elevated=elevated,
            critical=critical,
        )

        assert result.recovery_sent is True
        assert len(sink.sent) == 1
        assert "recovered" in sink.sent[0].body.lower()
        assert "0.7%" in sink.sent[0].body

        quiet = await _check(
            _healthy_reading(),
            sink=sink,
            elevated=elevated,
            critical=critical,
        )

        assert quiet.recovery_sent is False
        assert len(sink.sent) == 1

    asyncio.run(scenario())


def test_recovery_from_a_critical_breach_clears_both_tiers() -> None:
    """One recovery message, not one per tier that happened to be standing."""

    async def scenario() -> None:
        sink = FakeSink()
        elevated = FakeThrottle(outstanding=True)
        critical = FakeThrottle(outstanding=True)

        result = await _check(
            _healthy_reading(),
            sink=sink,
            elevated=elevated,
            critical=critical,
        )

        assert result.recovery_sent is True
        assert len(sink.sent) == 1
        assert elevated.outstanding is False
        assert critical.outstanding is False

    asyncio.run(scenario())


def test_a_new_day_with_no_sends_yet_is_not_a_recovery() -> None:
    """The window resets at midnight, and that is not the rate getting better.

    The counts are read for today, so every morning starts at 0 sent. If an
    empty window counted as recovery, a breach found at 18:00 would be
    followed by "recovered" at 00:05 while nothing had changed except the
    calendar, and the operator would stand down on a problem still there.
    Only a real healthy reading, built on enough volume to mean something,
    clears a standing alert.
    """

    async def scenario() -> None:
        sink = FakeSink()
        elevated = FakeThrottle(outstanding=True)

        result = await _check(
            _snapshot(sent_with_website=0, bounced_with_website=0),
            sink=sink,
            elevated=elevated,
        )

        assert result.verdict.state == "insufficient_volume"
        assert result.recovery_sent is False
        assert result.alert_sent is False
        assert sink.sent == []
        # The alert is still standing, so tomorrow's real healthy reading is
        # the thing that stands it down.
        assert elevated.outstanding is True

    asyncio.run(scenario())


def test_failed_delivery_releases_the_cooldown() -> None:
    """A claimed cooldown with no SMS behind it silences the next hour.

    Claim then send is two steps. If the send throws while the claim stands,
    the alarm goes quiet for the whole cooldown having told nobody anything,
    which is the exact silent-failure shape this project keeps shipping. The
    claim is handed back before the error propagates.
    """

    async def scenario() -> None:
        sink = FakeSink(fail_with=RuntimeError("reply agent unreachable"))
        elevated = FakeThrottle()

        with pytest.raises(RuntimeError, match="reply agent unreachable"):
            await _check(_today_reading(), sink=sink, elevated=elevated)

        assert elevated.clears == 1
        assert elevated.outstanding is False

    asyncio.run(scenario())


def test_failed_critical_delivery_releases_the_critical_cooldown() -> None:
    """Same guarantee on the urgent tier, which has its own key to release."""

    async def scenario() -> None:
        sink = FakeSink(fail_with=RuntimeError("reply agent unreachable"))
        elevated = FakeThrottle()
        critical = FakeThrottle()

        with pytest.raises(RuntimeError):
            await _check(
                _snapshot(sent_with_website=50, bounced_with_website=21),
                sink=sink,
                elevated=elevated,
                critical=critical,
            )

        assert critical.clears == 1
        assert critical.outstanding is False

    asyncio.run(scenario())


def test_broken_read_is_reported_as_a_failed_check_not_as_healthy() -> None:
    """No analytics rows means the read failed, and silence would hide it.

    Zero campaigns sums to 0 sent and 0 bounced, which is arithmetically the
    same as a quiet morning. The check reports it as a read failure so PM2
    shows the monitor as errored, rather than logging a reassuring line while
    the alarm is blind.
    """

    async def scenario() -> None:
        sink = FakeSink()

        result = await run_bounce_check(
            reader=FakeReader(
                BounceSnapshot(observed_at=FIRST_SENDING_DAY, window_days=1, campaigns=())
            ),
            sink=sink,
            elevated_throttle=FakeThrottle(),
            critical_throttle=FakeThrottle(),
        )

        assert result.verdict.state == "unknown"
        assert result.read_failed is True
        assert result.alert_sent is False
        assert sink.sent == []

    asyncio.run(scenario())


def test_alert_body_fits_the_reply_agent_sms_cap() -> None:
    """The reply agent truncates an ops alert body at 320 characters.

    That cap is real and it truncates from the tail, which is where the
    approved action lives. A body that overran it would arrive as a rate with
    no instruction, and it would do it silently. Room is left for the low
    balance warning the reply agent appends.
    """

    async def scenario() -> None:
        sink = FakeSink()

        await _check(_today_reading(), sink=sink)
        await _check(_snapshot(sent_with_website=50, bounced_with_website=21), sink=sink)

        for alert in sink.sent:
            assert len(f"{alert.subject}: {alert.body}") <= 260

    asyncio.run(scenario())


def test_reader_asks_instantly_for_the_configured_campaigns_and_maps_the_counts() -> None:
    """The signal comes from Instantly, so the request shape is asserted.

    A reader that quietly asked for the wrong campaigns, or read the wrong
    keys, would return zeros and the alarm would report healthy forever. The
    database is not an option here: it only learns about a bounce through the
    webhook that dropped every event for months until #165.
    """

    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                200,
                json=[
                    {
                        "campaign_id": CAMPAIGN_WITH_WEBSITE,
                        "campaign_name": "PrinterIQ AU with website",
                        "emails_sent_count": 20,
                        "bounced_count": 2,
                    },
                    {
                        "campaign_id": CAMPAIGN_NO_WEBSITE,
                        "campaign_name": "PrinterIQ AU no website",
                        "emails_sent_count": 10,
                        "bounced_count": 1,
                    },
                ],
            )

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            reader = CampaignAnalyticsReader(
                client=InstantlyClient(api_key="secret-key", http_client=http_client),
                campaign_ids=(CAMPAIGN_WITH_WEBSITE, CAMPAIGN_NO_WEBSITE),
                window_days=1,
                clock=lambda: FIRST_SENDING_DAY,
            )

            snapshot = await reader.read_bounces()

        assert snapshot.emails_sent == 30
        assert snapshot.bounced == 3
        assert snapshot.window_days == 1
        assert len(requests) == 1
        request = requests[0]
        assert request.method == "GET"
        assert request.url.path == "/api/v2/campaigns/analytics"
        assert request.headers["Authorization"] == "Bearer secret-key"
        assert request.url.params.get_list("campaign_id") == [
            CAMPAIGN_WITH_WEBSITE,
            CAMPAIGN_NO_WEBSITE,
        ]
        assert request.url.params["start_date"] == "2026-09-10"
        assert request.url.params["end_date"] == "2026-09-10"

    asyncio.run(scenario())


def test_reader_drops_campaigns_the_monitor_was_not_asked_about() -> None:
    """There are 10 accounts on two other projects' domains in this Instantly.

    ADR 005 is explicit that `adsiqdigital.com` and
    `buildpredictiqdigital.com` are not PrinterIQ capacity. If the analytics
    endpoint ever answers with more than it was asked for, another project's
    campaign must not dilute or inflate the PrinterIQ rate.
    """

    async def scenario() -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json=[
                    {
                        "campaign_id": CAMPAIGN_WITH_WEBSITE,
                        "emails_sent_count": 30,
                        "bounced_count": 3,
                    },
                    {
                        "campaign_id": "99999999-9999-9999-9999-999999999999",
                        "emails_sent_count": 4000,
                        "bounced_count": 0,
                    },
                ],
            )

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            reader = CampaignAnalyticsReader(
                client=InstantlyClient(api_key="secret-key", http_client=http_client),
                campaign_ids=(CAMPAIGN_WITH_WEBSITE,),
                window_days=1,
                clock=lambda: FIRST_SENDING_DAY,
            )

            snapshot = await reader.read_bounces()

        assert snapshot.emails_sent == 30
        assert snapshot.bounced == 3

    asyncio.run(scenario())


def test_reader_treats_a_missing_count_as_a_broken_read_not_as_zero() -> None:
    """A renamed field must not read as a clean estate.

    Defaulting a missing `bounced_count` to 0 would turn an Instantly schema
    change into a permanently healthy alarm, which is the same shape as the
    bounce webhook that silently dropped events for months.
    """

    async def scenario() -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json=[{"campaign_id": CAMPAIGN_WITH_WEBSITE, "emails_sent_count": 30}],
            )

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            reader = CampaignAnalyticsReader(
                client=InstantlyClient(api_key="secret-key", http_client=http_client),
                campaign_ids=(CAMPAIGN_WITH_WEBSITE,),
                window_days=1,
                clock=lambda: FIRST_SENDING_DAY,
            )

            with pytest.raises(ValueError, match="bounced_count"):
                await reader.read_bounces()

    asyncio.run(scenario())


def test_cooldown_default_is_one_hour() -> None:
    """Documented here so the runbook and the code cannot drift apart."""
    assert BOUNCE_ALERT_COOLDOWN_SECONDS == 60 * 60


def test_dry_run_entrypoint_prints_the_sms_and_sends_nothing(monkeypatch, capsys) -> None:
    """The code PM2 actually runs, end to end, with nothing real behind it.

    `_run_checks` is the wiring: env vars, campaign ids, the Instantly client,
    the Redis throttles and the sink. Every unit above this can pass while a
    single wrong keyword here means the alarm never runs at all, and PM2 would
    report that as `errored` at 09:00 tomorrow rather than now. This is also
    the check the runbook tells the operator to run to prove the alarm is
    armed, so `--dry-run` must print the exact body and send no SMS.
    """
    from ops import bounce_monitor

    monkeypatch.setenv("INSTANTLY_API_KEY", "test-key")
    monkeypatch.setenv("INSTANTLY_CAMPAIGN_ID", CAMPAIGN_WITH_WEBSITE)
    monkeypatch.setenv("INSTANTLY_NO_WEBSITE_CAMPAIGN_ID", CAMPAIGN_NO_WEBSITE)
    monkeypatch.setattr(bounce_monitor, "load_pipeline_env", lambda: False)

    class FakeRedisClient:
        def __init__(self) -> None:
            self.keys: dict[str, str] = {}
            self.closed = False

        async def set(
            self, key: str, value: str, *, nx: bool = False, ex: int | None = None
        ) -> bool | None:
            del ex
            if nx and key in self.keys:
                return None
            self.keys[key] = value
            return True

        async def delete(self, key: str) -> int:
            return 1 if self.keys.pop(key, None) is not None else 0

        async def aclose(self) -> None:
            self.closed = True

    redis_client = FakeRedisClient()
    monkeypatch.setattr(
        bounce_monitor.importlib,
        "import_module",
        lambda name: type("Module", (), {"get_redis_client": staticmethod(lambda: redis_client)}),
    )

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[
                {
                    "campaign_id": CAMPAIGN_WITH_WEBSITE,
                    "emails_sent_count": 20,
                    "bounced_count": 2,
                },
                {"campaign_id": CAMPAIGN_NO_WEBSITE, "emails_sent_count": 10, "bounced_count": 1},
            ],
        )

    real_client_class = bounce_monitor.InstantlyClient
    monkeypatch.setattr(
        bounce_monitor,
        "InstantlyClient",
        lambda *, api_key: real_client_class(
            api_key=api_key,
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        ),
    )

    result = asyncio.run(bounce_monitor._run_checks(once=True, dry_run=True))

    assert result.verdict.state == "elevated"
    assert result.alert_sent is True
    assert redis_client.closed is True

    printed = capsys.readouterr().out
    # `--dry-run` is the operator's proof the alarm is armed, so the body it
    # prints has to be the body that would have been sent.
    assert "[dry-run] PrinterIQ bounce alarm: Bounce rate 10.0%" in printed
    assert "unverified email bucket" in printed
    # Per-campaign detail on stdout, ids and counts only, no campaign names.
    assert f"campaign {CAMPAIGN_WITH_WEBSITE}: 2 bounced of 20 sent" in printed
    assert f"campaign {CAMPAIGN_NO_WEBSITE}: 1 bounced of 10 sent" in printed


def test_dry_run_entrypoint_refuses_to_run_without_campaign_ids(monkeypatch) -> None:
    """An alarm watching no campaigns would report healthy forever.

    Raising at startup puts the reason in `pm2 logs` rather than producing a
    reassuring line about an estate nobody is looking at.
    """
    from ops import bounce_monitor

    monkeypatch.setattr(bounce_monitor, "load_pipeline_env", lambda: False)
    monkeypatch.delenv("INSTANTLY_CAMPAIGN_ID", raising=False)
    monkeypatch.delenv("INSTANTLY_NO_WEBSITE_CAMPAIGN_ID", raising=False)

    with pytest.raises(RuntimeError, match="INSTANTLY_CAMPAIGN_ID"):
        asyncio.run(bounce_monitor._run_checks(once=True, dry_run=True))


def test_default_window_spans_the_utc_dates_one_australian_sending_day_lands_in() -> None:
    """A one UTC day window can never see a whole Australian sending day.

    Instantly buckets its analytics by UTC. The campaigns send 09:00 to 17:00
    Australia/Melbourne, which in AEST is 23:00 to 07:00 UTC, so one Australian
    sending day always straddles UTC midnight and always lands in two different
    UTC dates.

    Measured against production on 2026-09-10, for a day that really sent 30
    emails and bounced 3: asking for `2026-09-10` alone returned 2 sent, while
    asking for `2026-09-09` to `2026-09-10` returned 30 sent and 3 bounced. The
    monitor's floor is 30 sends, so with a one day window it reported "not
    enough volume to judge" and would have done so every day, for ever, never
    once judging the bounce rate. An alarm that cannot fire is worse than no
    alarm because it manufactures confidence.

    This test pins the default window to the span, not the arithmetic, so
    reverting the default is caught here rather than in production silence.
    """

    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            # The same 28 / 2 split production showed, expressed as the totals
            # the endpoint returns for a range covering both UTC dates.
            return httpx.Response(
                200,
                json=[
                    {
                        "campaign_id": CAMPAIGN_WITH_WEBSITE,
                        "campaign_name": "PrinterIQ AU with website",
                        "emails_sent_count": 15,
                        "bounced_count": 1,
                    },
                    {
                        "campaign_id": CAMPAIGN_NO_WEBSITE,
                        "campaign_name": "PrinterIQ AU no website",
                        "emails_sent_count": 15,
                        "bounced_count": 2,
                    },
                ],
            )

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            reader = CampaignAnalyticsReader(
                client=InstantlyClient(api_key="secret-key", http_client=http_client),
                campaign_ids=(CAMPAIGN_WITH_WEBSITE, CAMPAIGN_NO_WEBSITE),
                clock=lambda: FIRST_SENDING_DAY,
            )

            snapshot = await reader.read_bounces()

        request = requests[0]
        start = request.url.params.get("start_date")
        end = request.url.params.get("end_date")

        # FIRST_SENDING_DAY is 2026-09-10T18:00Z, so the UTC date is the 10th
        # and the Australian sending day it belongs to also touched the 9th.
        assert end == "2026-09-10"
        assert start == "2026-09-09", (
            "a single UTC date cannot contain an Australian sending day: "
            f"asked for {start} to {end}"
        )
        assert snapshot.emails_sent == 30
        assert snapshot.bounced == 3

    asyncio.run(scenario())


def test_the_window_is_never_described_as_today() -> None:
    """"Today" is a claim about a calendar day in Melbourne, and this is not one.

    The window is a span of UTC dates chosen to contain an Australian sending
    day, so it also carries the tail of the previous Australian day. A bounce
    rate over that span is still a real rate, but calling it "today" would be a
    second false claim of exactly the kind this dashboard has just been audited
    for.
    """
    assert "today" not in _format_window(1).lower()
    assert "today" not in _format_window(2).lower()
    assert "utc" in _format_window(2).lower()

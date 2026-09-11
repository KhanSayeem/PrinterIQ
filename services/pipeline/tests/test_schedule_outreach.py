from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest

from pipeline_queue.definitions import JobType
from workers.schedule_outreach import (
    OutreachSendLockedError,
    SendWindowNotReachedError,
    UnverifiedEmailError,
    schedule_outreach,
)

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
LEAD_ID = UUID("20000000-0000-0000-0000-000000000002")
PREVIEW_URL = "https://preview.presciaiq.com/p/preview-token-1234567890abcdef/"


@dataclass
class FakeLeadFetcher:
    lead: dict[str, object]

    async def get_lead(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        assert tenant_id == TENANT_ID
        assert lead_id == LEAD_ID
        return self.lead


@dataclass
class FakeQualificationFetcher:
    qualification: dict[str, object]

    async def get_qualification(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        assert tenant_id == TENANT_ID
        assert lead_id == LEAD_ID
        return self.qualification


@dataclass
class FakeOutreachRepository:
    inserted: list[dict[str, object]] = field(default_factory=list)
    updates: list[tuple[UUID, UUID]] = field(default_factory=list)
    reserved: list[dict[str, object]] = field(default_factory=list)
    completed: list[dict[str, object]] = field(default_factory=list)
    abandoned: list[dict[str, object]] = field(default_factory=list)
    events: list[str] = field(default_factory=list)
    existing: dict[str, object] | None = None
    website_preview: dict[str, object] | None = field(
        default_factory=lambda: {"preview_url": PREVIEW_URL}
    )
    preview_gets: list[tuple[UUID, UUID]] = field(default_factory=list)
    lock_acquired: bool = False
    lock_released: bool = False

    async def get_outreach_send(
        self,
        *,
        tenant_id: UUID,
        lead_id: UUID,
        instantly_campaign_id: str,
        channel: str,
    ) -> dict[str, object] | None:
        return self.existing

    async def get_website_preview(
        self, *, tenant_id: UUID, lead_id: UUID
    ) -> dict[str, object] | None:
        self.preview_gets.append((tenant_id, lead_id))
        return self.website_preview

    async def insert_outreach_send(self, send: dict[str, object]) -> UUID:
        assert self.lock_acquired is True
        self.inserted.append(send)
        return UUID("30000000-0000-0000-0000-000000000003")

    async def reserve_outreach_send(self, send: dict[str, object]) -> UUID:
        assert self.lock_acquired is True
        self.events.append("reserve")
        self.reserved.append(send)
        return UUID("30000000-0000-0000-0000-000000000003")

    async def complete_outreach_send(self, send: dict[str, object]) -> UUID:
        self.events.append("complete")
        self.completed.append(send)
        return UUID("30000000-0000-0000-0000-000000000003")

    async def abandon_outreach_send_reservation(self, send: dict[str, object]) -> None:
        self.events.append("abandon")
        self.abandoned.append(send)

    async def mark_lead_contacted(self, *, tenant_id: UUID, lead_id: UUID) -> bool:
        self.events.append("contacted")
        self.updates.append((tenant_id, lead_id))
        return True

    async def acquire_outreach_send_lock(
        self,
        *,
        tenant_id: UUID,
        lead_id: UUID,
        instantly_campaign_id: str,
        channel: str,
    ) -> bool:
        self.lock_acquired = True
        return True

    async def release_outreach_send_lock(
        self,
        *,
        tenant_id: UUID,
        lead_id: UUID,
        instantly_campaign_id: str,
        channel: str,
    ) -> None:
        self.lock_released = True


@dataclass
class FakeInstantlyClient:
    result: dict[str, object] | Exception
    calls: list[dict[str, object]] = field(default_factory=list)

    async def add_lead_to_campaign(self, payload: dict[str, object]) -> dict[str, object]:
        if "events" in payload:
            events = payload["events"]
            assert isinstance(events, list)
            events.append("instantly")
        self.calls.append(payload)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def _lead() -> dict[str, object]:
    return {
        "id": LEAD_ID,
        "tenant_id": TENANT_ID,
        "email": "brett@stonebuilders.com.au",
        "first_name": "Brett",
        "last_name": "Stone",
        "business_name": "Stone Builders",
        "website_url": "https://stonebuilders.com.au",
        "phone": "+61400000001",
        "status": "qualified",
        "email_status": "Verified",
    }


def _qualification() -> dict[str, object]:
    return {
        "lead_id": LEAD_ID,
        "tenant_id": TENANT_ID,
        "top_weakness": "no_mobile",
        "personalised_opener": "Brett, your site is hard to use on mobile.",
        "followup_1": "Worth fixing before the next batch of quote requests.",
        "followup_2": "Happy to show what a fast tradie site can look like.",
        "weakness_sentence": (
            "your site isn't built for mobile, so most visitors give up before they call"
        ),
    }


def _payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "job_type": JobType.SCHEDULE_OUTREACH.value,
        "tenant_id": str(TENANT_ID),
        "lead_id": str(LEAD_ID),
        "campaign_id": "campaign-from-payload",
        "send_after": "2026-05-20T09:00:00+10:00",
    }
    payload.update(overrides)
    return payload


def test_successful_job_adds_instantly_lead_writes_outreach_and_marks_contacted() -> None:
    async def scenario() -> None:
        repo = FakeOutreachRepository()
        instantly = FakeInstantlyClient(result={"created_leads": [{"id": "instantly-lead-1"}]})

        await schedule_outreach(
            _payload(
                channel="email",
                send_after="2026-05-20T09:00:00+10:00",
                preview_url=PREVIEW_URL,
            ),
            lead_fetcher=FakeLeadFetcher(_lead()),
            qualification_fetcher=FakeQualificationFetcher(_qualification()),
            outreach_repo=repo,
            instantly_client=instantly,
        )

        assert instantly.calls == [
            {
                "campaign_id": "campaign-from-payload",
                "leads": [
                    {
                        "email": "brett@stonebuilders.com.au",
                        "personalization": "Brett, your site is hard to use on mobile.",
                        "website": "https://stonebuilders.com.au",
                        "first_name": "Brett",
                        "last_name": "Stone",
                        "company_name": "Stone Builders",
                        "phone": "+61400000001",
                        "custom_variables": {
                            "opener": "Brett, your site is hard to use on mobile.",
                            "weakness": "no_mobile",
                            "weakness_sentence": (
                                "your site isn't built for mobile, so most visitors give up "
                                "before they call"
                            ),
                            "followup_1": "Worth fixing before the next batch of quote requests.",
                            "followup_2": "Happy to show what a fast tradie site can look like.",
                            "tenant_id": str(TENANT_ID),
                            "lead_id": str(LEAD_ID),
                            "website_preview_url": PREVIEW_URL,
                            "preview_url": PREVIEW_URL,
                        },
                    }
                ],
            }
        ]
        assert repo.reserved == [
            {
                "tenant_id": TENANT_ID,
                "lead_id": LEAD_ID,
                "instantly_campaign_id": "campaign-from-payload",
                "channel": "email",
            }
        ]
        assert repo.completed == [
            {
                "tenant_id": TENANT_ID,
                "lead_id": LEAD_ID,
                "instantly_campaign_id": "campaign-from-payload",
                "instantly_lead_id": "instantly-lead-1",
                "channel": "email",
            }
        ]
        assert repo.updates == [(TENANT_ID, LEAD_ID)]
        assert repo.preview_gets == [(TENANT_ID, LEAD_ID)]
        assert repo.lock_released is True

    asyncio.run(scenario())


def test_null_weakness_sentence_does_not_crash_and_sends_empty_string() -> None:
    async def scenario() -> None:
        repo = FakeOutreachRepository()
        instantly = FakeInstantlyClient(result={"created_leads": [{"id": "instantly-lead-1"}]})
        qualification = _qualification()
        qualification["weakness_sentence"] = None

        await schedule_outreach(
            _payload(),
            lead_fetcher=FakeLeadFetcher(_lead()),
            qualification_fetcher=FakeQualificationFetcher(qualification),
            outreach_repo=repo,
            instantly_client=instantly,
        )

        custom_variables = instantly.calls[0]["leads"][0]["custom_variables"]
        assert isinstance(custom_variables, dict)
        assert custom_variables["weakness_sentence"] == ""

    asyncio.run(scenario())


def test_preview_url_must_match_tenant_scoped_preview_row() -> None:
    async def scenario() -> None:
        repo = FakeOutreachRepository()
        instantly = FakeInstantlyClient(result={"id": "instantly-lead-1"})

        with pytest.raises(ValueError, match="preview_url does not match tenant preview"):
            await schedule_outreach(
                _payload(preview_url="https://attacker.example/preview"),
                lead_fetcher=FakeLeadFetcher(_lead()),
                qualification_fetcher=FakeQualificationFetcher(_qualification()),
                outreach_repo=repo,
                instantly_client=instantly,
            )

        assert repo.reserved == []
        assert repo.completed == []
        assert repo.preview_gets == [(TENANT_ID, LEAD_ID)]
        assert instantly.calls == []

    asyncio.run(scenario())


def test_preview_url_requires_existing_tenant_scoped_preview_row() -> None:
    async def scenario() -> None:
        repo = FakeOutreachRepository(website_preview=None)
        instantly = FakeInstantlyClient(result={"id": "instantly-lead-1"})

        with pytest.raises(ValueError, match="preview_url does not match tenant preview"):
            await schedule_outreach(
                _payload(preview_url=PREVIEW_URL),
                lead_fetcher=FakeLeadFetcher(_lead()),
                qualification_fetcher=FakeQualificationFetcher(_qualification()),
                outreach_repo=repo,
                instantly_client=instantly,
            )

        assert repo.reserved == []
        assert repo.completed == []
        assert repo.preview_gets == [(TENANT_ID, LEAD_ID)]
        assert instantly.calls == []

    asyncio.run(scenario())


def test_successful_job_reserves_outreach_before_calling_instantly() -> None:
    async def scenario() -> None:
        repo = FakeOutreachRepository()

        class EventInstantlyClient(FakeInstantlyClient):
            async def add_lead_to_campaign(self, payload: dict[str, object]) -> dict[str, object]:
                repo.events.append("instantly")
                return await super().add_lead_to_campaign(payload)

        await schedule_outreach(
            _payload(),
            lead_fetcher=FakeLeadFetcher(_lead()),
            qualification_fetcher=FakeQualificationFetcher(_qualification()),
            outreach_repo=repo,
            instantly_client=EventInstantlyClient(
                result={"created_leads": [{"id": "instantly-lead-1"}]}
            ),
        )

        assert repo.events == ["reserve", "instantly", "complete", "contacted"]
        assert repo.reserved == [
            {
                "tenant_id": TENANT_ID,
                "lead_id": LEAD_ID,
                "instantly_campaign_id": "campaign-from-payload",
                "channel": "email",
            }
        ]
        assert repo.completed == [
            {
                "tenant_id": TENANT_ID,
                "lead_id": LEAD_ID,
                "instantly_campaign_id": "campaign-from-payload",
                "instantly_lead_id": "instantly-lead-1",
                "channel": "email",
            }
        ]

    asyncio.run(scenario())


def test_successful_job_defaults_website_preview_url_when_preview_payload_missing() -> None:
    async def scenario() -> None:
        repo = FakeOutreachRepository()
        instantly = FakeInstantlyClient(result={"created_leads": [{"id": "instantly-lead-1"}]})

        await schedule_outreach(
            _payload(),
            lead_fetcher=FakeLeadFetcher(_lead()),
            qualification_fetcher=FakeQualificationFetcher(_qualification()),
            outreach_repo=repo,
            instantly_client=instantly,
        )

        custom_variables = instantly.calls[0]["leads"][0]["custom_variables"]
        assert isinstance(custom_variables, dict)
        assert custom_variables["website_preview_url"] == ""
        assert repo.preview_gets == []

    asyncio.run(scenario())


def test_pending_outreach_reservation_does_not_call_instantly_again() -> None:
    async def scenario() -> None:
        repo = FakeOutreachRepository(
            existing={
                "id": UUID("30000000-0000-0000-0000-000000000003"),
                "instantly_lead_id": None,
            }
        )
        instantly = FakeInstantlyClient(result={"id": "unused"})

        with pytest.raises(RuntimeError, match="reserved but not completed"):
            await schedule_outreach(
                _payload(),
                lead_fetcher=FakeLeadFetcher(_lead()),
                qualification_fetcher=FakeQualificationFetcher(_qualification()),
                outreach_repo=repo,
                instantly_client=instantly,
            )

        assert instantly.calls == []
        assert repo.updates == []
        assert repo.lock_acquired is False

    asyncio.run(scenario())


def test_existing_outreach_send_marks_contacted_without_calling_instantly_again() -> None:
    async def scenario() -> None:
        repo = FakeOutreachRepository(
            existing={
                "id": UUID("30000000-0000-0000-0000-000000000003"),
                "instantly_lead_id": "instantly-lead-1",
            }
        )
        instantly = FakeInstantlyClient(result={"id": "unused"})

        await schedule_outreach(
            _payload(),
            lead_fetcher=FakeLeadFetcher(_lead()),
            qualification_fetcher=FakeQualificationFetcher(_qualification()),
            outreach_repo=repo,
            instantly_client=instantly,
        )

        assert instantly.calls == []
        assert repo.inserted == []
        assert repo.updates == [(TENANT_ID, LEAD_ID)]
        assert repo.lock_acquired is False

    asyncio.run(scenario())


def test_instantly_failure_writes_no_outreach_and_does_not_mark_contacted() -> None:
    async def scenario() -> None:
        repo = FakeOutreachRepository()

        with pytest.raises(RuntimeError, match="Instantly unavailable"):
            await schedule_outreach(
                _payload(),
                lead_fetcher=FakeLeadFetcher(_lead()),
                qualification_fetcher=FakeQualificationFetcher(_qualification()),
                outreach_repo=repo,
                instantly_client=FakeInstantlyClient(result=RuntimeError("Instantly unavailable")),
            )

        assert repo.inserted == []
        assert repo.abandoned == [
            {
                "tenant_id": TENANT_ID,
                "lead_id": LEAD_ID,
                "instantly_campaign_id": "campaign-from-payload",
                "channel": "email",
            }
        ]
        assert repo.updates == []
        assert repo.lock_released is True

    asyncio.run(scenario())


def test_future_send_after_delays_before_instantly_side_effect() -> None:
    async def scenario() -> None:
        repo = FakeOutreachRepository()
        instantly = FakeInstantlyClient(result={"id": "unused"})
        future = datetime.now(UTC) + timedelta(hours=1)

        with pytest.raises(SendWindowNotReachedError, match="send_after is in the future"):
            await schedule_outreach(
                _payload(send_after=future.isoformat()),
                lead_fetcher=FakeLeadFetcher(_lead()),
                qualification_fetcher=FakeQualificationFetcher(_qualification()),
                outreach_repo=repo,
                instantly_client=instantly,
            )

        assert instantly.calls == []
        assert repo.inserted == []
        assert repo.updates == []
        assert repo.lock_acquired is False

    asyncio.run(scenario())


def test_unavailable_outreach_lock_delays_before_instantly_side_effect() -> None:
    async def scenario() -> None:
        class LockedRepository(FakeOutreachRepository):
            async def acquire_outreach_send_lock(
                self,
                *,
                tenant_id: UUID,
                lead_id: UUID,
                instantly_campaign_id: str,
                channel: str,
            ) -> bool:
                self.lock_acquired = True
                return False

        repo = LockedRepository()
        instantly = FakeInstantlyClient(result={"id": "unused"})

        with pytest.raises(OutreachSendLockedError, match="outreach send is already locked"):
            await schedule_outreach(
                _payload(),
                lead_fetcher=FakeLeadFetcher(_lead()),
                qualification_fetcher=FakeQualificationFetcher(_qualification()),
                outreach_repo=repo,
                instantly_client=instantly,
            )

        assert instantly.calls == []
        assert repo.inserted == []
        assert repo.updates == []
        assert repo.lock_acquired is True
        assert repo.lock_released is False

    asyncio.run(scenario())


def test_missing_default_campaign_id_fails_clearly(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        monkeypatch.delenv("INSTANTLY_CAMPAIGN_ID", raising=False)

        with pytest.raises(ValueError, match="campaign_id missing"):
            await schedule_outreach(
                {
                    "job_type": JobType.SCHEDULE_OUTREACH.value,
                    "tenant_id": str(TENANT_ID),
                    "lead_id": str(LEAD_ID),
                    "send_after": "2026-05-20T09:00:00+10:00",
                },
                lead_fetcher=FakeLeadFetcher(_lead()),
                qualification_fetcher=FakeQualificationFetcher(_qualification()),
                outreach_repo=FakeOutreachRepository(),
                instantly_client=FakeInstantlyClient(result={"id": "unused"}),
            )

    asyncio.run(scenario())


def test_campaign_id_defaults_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        monkeypatch.setenv("INSTANTLY_CAMPAIGN_ID", "campaign-from-env")
        instantly = FakeInstantlyClient(result={"created_leads": [{"id": "instantly-lead-1"}]})

        await schedule_outreach(
            {
                "job_type": JobType.SCHEDULE_OUTREACH.value,
                "tenant_id": str(TENANT_ID),
                "lead_id": str(LEAD_ID),
                "send_after": "2026-05-20T09:00:00+10:00",
            },
            lead_fetcher=FakeLeadFetcher(_lead()),
            qualification_fetcher=FakeQualificationFetcher(_qualification()),
            outreach_repo=FakeOutreachRepository(),
            instantly_client=instantly,
        )

        assert instantly.calls[0]["campaign_id"] == "campaign-from-env"

    asyncio.run(scenario())


def test_worker_refuses_qualification_without_personalised_opener() -> None:
    async def scenario() -> None:
        qualification = _qualification()
        qualification["personalised_opener"] = ""

        with pytest.raises(ValueError, match="personalised_opener"):
            await schedule_outreach(
                _payload(),
                lead_fetcher=FakeLeadFetcher(_lead()),
                qualification_fetcher=FakeQualificationFetcher(qualification),
                outreach_repo=FakeOutreachRepository(),
                instantly_client=FakeInstantlyClient(result={"id": "unused"}),
            )

    asyncio.run(scenario())


def test_missing_created_leads_in_instantly_response_fails_clearly() -> None:
    async def scenario() -> None:
        repo = FakeOutreachRepository()
        instantly = FakeInstantlyClient(result={"created_leads": []})

        with pytest.raises(ValueError, match="Instantly response did not include id"):
            await schedule_outreach(
                _payload(),
                lead_fetcher=FakeLeadFetcher(_lead()),
                qualification_fetcher=FakeQualificationFetcher(_qualification()),
                outreach_repo=repo,
                instantly_client=instantly,
            )

        assert repo.completed == []
        assert repo.updates == []
        assert repo.lock_released is True

    asyncio.run(scenario())


def test_custom_variables_carry_the_tenant_id_alongside_the_lead_id() -> None:
    """Instantly echoes custom variables back on reply, bounce and unsubscribe
    webhooks, and the reply-agent needs a tenant to scope its lookups by. We
    sent lead_id and never sent tenant_id, so a lead that could otherwise be
    identified from the echoed pair alone could not be."""

    async def scenario() -> None:
        repo = FakeOutreachRepository()
        instantly = FakeInstantlyClient(result={"created_leads": [{"id": "instantly-lead-1"}]})

        await schedule_outreach(
            _payload(),
            lead_fetcher=FakeLeadFetcher(_lead()),
            qualification_fetcher=FakeQualificationFetcher(_qualification()),
            outreach_repo=repo,
            instantly_client=instantly,
        )

        custom_variables = instantly.calls[0]["leads"][0]["custom_variables"]
        assert isinstance(custom_variables, dict)
        assert custom_variables["tenant_id"] == str(TENANT_ID)
        assert custom_variables["lead_id"] == str(LEAD_ID)

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "email_status",
    [
        # The two vendor buckets that bounced in production. On 2026-09-10 the
        # first bounced 3 of the day's 30 sends; on 2026-09-11 the second
        # bounced 4 of about 15 in one campaign, while 878 verified sends had
        # bounced none.
        "Syntactically valid public business email",
        "Publicly Listed",
        "unverified",
        "",
        None,
    ],
)
def test_refuses_to_hand_an_unverified_email_to_instantly(email_status: object) -> None:
    """Every bounce so far came from an unverified email, and none from a verified one.

    Nothing between import and Instantly looked at `email_status`, so any
    lead that scored well enough was sent whatever its email was worth. Once
    handed off, Instantly sends on its own schedule, and pulling leads back
    out afterwards is the slow, after-the-damage path. The check has to sit
    here, before the handoff.
    """

    async def scenario() -> None:
        repo = FakeOutreachRepository()
        instantly = FakeInstantlyClient(result={"created_leads": [{"id": "instantly-lead-1"}]})
        lead = _lead()
        lead["email_status"] = email_status

        with pytest.raises(UnverifiedEmailError):
            await schedule_outreach(
                _payload(preview_url=PREVIEW_URL),
                lead_fetcher=FakeLeadFetcher(lead),
                qualification_fetcher=FakeQualificationFetcher(_qualification()),
                outreach_repo=repo,
                instantly_client=instantly,
            )

        assert instantly.calls == []
        assert repo.reserved == []
        assert repo.lock_acquired is False

    asyncio.run(scenario())


def test_refuses_a_lead_whose_email_status_was_never_read() -> None:
    """A lead dict without the key is refused, not waved through.

    The production lead query did not select `email_status` at all. Treating
    a missing key as fine would have made this guard a no-op in exactly the
    place it runs.
    """

    async def scenario() -> None:
        instantly = FakeInstantlyClient(result={"created_leads": [{"id": "instantly-lead-1"}]})
        lead = _lead()
        del lead["email_status"]

        with pytest.raises(UnverifiedEmailError):
            await schedule_outreach(
                _payload(preview_url=PREVIEW_URL),
                lead_fetcher=FakeLeadFetcher(lead),
                qualification_fetcher=FakeQualificationFetcher(_qualification()),
                outreach_repo=FakeOutreachRepository(),
                instantly_client=instantly,
            )

        assert instantly.calls == []

    asyncio.run(scenario())


@pytest.mark.parametrize("email_status", ["Verified", "verified", "valid", " VALID "])
def test_hands_off_a_verified_email_whatever_the_casing(email_status: str) -> None:
    """The verified labels in production are spelled more than one way.

    878 handed-off leads read "Verified", 12 read "verified" and 4 read
    "valid", and none of them has bounced. Refusing one spelling would stall
    good leads for no reason.
    """

    async def scenario() -> None:
        instantly = FakeInstantlyClient(result={"created_leads": [{"id": "instantly-lead-1"}]})
        lead = _lead()
        lead["email_status"] = email_status

        await schedule_outreach(
            _payload(preview_url=PREVIEW_URL),
            lead_fetcher=FakeLeadFetcher(lead),
            qualification_fetcher=FakeQualificationFetcher(_qualification()),
            outreach_repo=FakeOutreachRepository(),
            instantly_client=instantly,
        )

        assert len(instantly.calls) == 1

    asyncio.run(scenario())

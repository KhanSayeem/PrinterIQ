from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from uuid import UUID

import pytest

from db.queries import (
    QualificationInsert,
    get_enrichment_by_lead_id,
    insert_qualification,
)
from pipeline_queue.definitions import JobType
from workers.qualify import (
    _HAIKU_SCHEMA,
    _SONNET_SCHEMA,
    ClaudeResponse,
    DeadLetterError,
    _parse_and_validate,
    qualify_lead,
)

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
LEAD_ID = UUID("20000000-0000-0000-0000-000000000002")
ENRICHMENT_ID = UUID("30000000-0000-0000-0000-000000000003")

HAIKU_MODEL = "claude-haiku-4-5-20251001"
SONNET_MODEL = "claude-sonnet-4-6"

HAIKU_COST = Decimal("0.000100")
SONNET_COST = Decimal("0.000300")


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


@dataclass
class FakeLeadFetcher:
    lead: dict[str, object]

    async def get_lead(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        return self.lead


@dataclass
class FakeEnrichmentFetcher:
    enrichment: dict[str, object]

    async def get_enrichment(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        return self.enrichment


@dataclass
class FakeQualificationRepository:
    inserted: list[dict[str, object]] = field(default_factory=list)
    status_updates: list[tuple[UUID, UUID, str]] = field(default_factory=list)

    async def insert_qualification(self, q: dict[str, object]) -> UUID:
        self.inserted.append(q)
        return UUID(f"40000000-0000-0000-0000-{len(self.inserted):012d}")

    async def update_lead_status(self, *, tenant_id: UUID, lead_id: UUID, status: str) -> None:
        self.status_updates.append((tenant_id, lead_id, status))


@dataclass
class FakeOutreachQueue:
    jobs: list[dict[str, object]] = field(default_factory=list)

    async def enqueue(self, payload: dict[str, object]) -> None:
        self.jobs.append(payload)


@dataclass
class FakeClaudeClient:
    """Returns responses in order. Raises DeadLetterError if responses exhausted."""

    responses: list[ClaudeResponse | Exception]
    calls: list[tuple[str, dict[str, str]]] = field(default_factory=list)
    _index: int = field(default=0, init=False)

    async def call(self, prompt_name: str, variables: dict[str, str]) -> ClaudeResponse:
        self.calls.append((prompt_name, variables))
        response = self.responses[self._index]
        self._index += 1
        if isinstance(response, Exception):
            raise response
        return response


class RecordingConnection:
    def __init__(self, *, fetchval_result: object = None) -> None:
        self.fetchval_result = fetchval_result
        self.queries: list[str] = []
        self.args: list[tuple[object, ...]] = []

    async def fetchval(self, query: str, *args: object) -> object:
        self.queries.append(query)
        self.args.append(args)
        return self.fetchval_result

    async def fetchrow(self, query: str, *args: object) -> object:
        self.queries.append(query)
        self.args.append(args)
        return None

    async def execute(self, query: str, *args: object) -> object:
        self.queries.append(query)
        self.args.append(args)
        return "UPDATE 1"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_lead() -> dict[str, object]:
    return {
        "id": LEAD_ID,
        "tenant_id": TENANT_ID,
        "first_name": "Brett",
        "last_name": "Stone",
        "email": "brett@stonebuilders.com.au",
        "phone": "+61400000001",
        "business_name": "Stone Builders",
        "city": "Melbourne",
        "state": "VIC",
        "website_url": "https://stonebuilders.com.au",
        "technologies": "WordPress",
        "status": "enriched",
    }


def _make_enrichment() -> dict[str, object]:
    return {
        "id": ENRICHMENT_ID,
        "lead_id": LEAD_ID,
        "tenant_id": TENANT_ID,
        "has_site": True,
        "is_reachable": True,
        "is_mobile_friendly": False,
        "has_ssl": True,
        "has_meta_title": True,
        "has_meta_description": False,
        "has_h1": True,
        "load_ms": 3800,
        "cms_detected": "WordPress",
        "tech_source": "apollo",
        "weaknesses": ["no_mobile", "no_meta_description"],
        "raw_audit": None,
    }


def _haiku_response(
    score: int = 75,
    top_weakness: str = "no_mobile",
    weakness_label: str = "no_mobile",
) -> ClaudeResponse:
    # weakness_label defaults to "no_mobile", which matches an entry in
    # _make_enrichment()'s weaknesses list, so callers get a grounded
    # response by default and don't trip the grounding retry unintentionally.
    # No has_actionable_weakness: the model is not asked for it, and the
    # schema rejects it if supplied. Drive that gate from the enrichment
    # weaknesses array instead.
    content = json.dumps(
        {
            "score": score,
            "rationale": "No mobile site, slow load. Strong weakness for pitch.",
            "top_weakness": top_weakness,
            "weakness_label": weakness_label,
        }
    )
    return ClaudeResponse(text=content, cost_usd=HAIKU_COST, model=HAIKU_MODEL)


def _sonnet_response() -> ClaudeResponse:
    content = json.dumps(
        {
            "subject_line": "Stone Builders — your site's costing you mobile jobs",
            "opener": "Brett, Stone Builders online — great work, but site's invisible on phones.",
            "followup_1": "Could be worth a quick chat — I build sites for tradies that get found.",
            "followup_2": "No pressure, just happy to show you what's possible.",
            "weakness_sentence": (
                "your site isn't built for mobile, so most visitors give up before they call"
            ),
        }
    )
    return ClaudeResponse(text=content, cost_usd=SONNET_COST, model=SONNET_MODEL)


def _payload(score_threshold: int = 40, **overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "job_type": JobType.QUALIFY_LEAD.value,
        "tenant_id": str(TENANT_ID),
        "lead_id": str(LEAD_ID),
        "score_threshold": score_threshold,
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# Worker tests
# ---------------------------------------------------------------------------


def test_missing_score_threshold_rejects_without_claude_call() -> None:
    async def scenario() -> None:
        payload = _payload()
        payload.pop("score_threshold")
        client = FakeClaudeClient(responses=[_haiku_response(score=75)])

        with pytest.raises(ValueError, match="score_threshold missing from qualify_lead payload"):
            await qualify_lead(
                payload,
                lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
                enrichment_fetcher=FakeEnrichmentFetcher(enrichment=_make_enrichment()),
                qualification_repo=FakeQualificationRepository(),
                outreach_queue=FakeOutreachQueue(),
                claude_client=client,
            )

        assert client.calls == []

    asyncio.run(scenario())


def test_below_threshold_archives_lead_without_sonnet_call() -> None:
    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(responses=[_haiku_response(score=30)])

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=fetcher,
            enrichment_fetcher=enrichment,
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert len(repo.inserted) == 1
        q = repo.inserted[0]
        assert q["score"] == 30
        assert q["model_sonnet"] is None
        assert q["personalised_opener"] is None
        assert q["followup_1"] is None
        assert q["weakness_sentence"] is None
        assert q["has_actionable_weakness"] is True
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "archived")]
        assert queue.jobs == []
        assert len(client.calls) == 1
        assert client.calls[0][0] == "qualify-v1"

    asyncio.run(scenario())


def test_below_threshold_archives_lead_regardless_of_actionable_weakness() -> None:
    async def scenario(weaknesses: list[str], expected_gate: bool) -> None:
        enrichment_data = _make_enrichment()
        enrichment_data["weaknesses"] = weaknesses
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=enrichment_data)
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(responses=[_haiku_response(score=30)])

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=fetcher,
            enrichment_fetcher=enrichment,
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "archived")]
        assert repo.inserted[0]["has_actionable_weakness"] is expected_gate
        assert repo.inserted[0]["model_sonnet"] is None
        assert queue.jobs == []
        assert len(client.calls) == 1

    asyncio.run(scenario(["no_mobile", "no_meta_description"], True))
    asyncio.run(scenario([], False))


def test_above_threshold_without_actionable_weakness_archives_lead_single_claude_call() -> None:
    async def scenario() -> None:
        # No measured weakness, so the derived gate archives the lead even
        # though it scores well above threshold.
        enrichment_data = _make_enrichment()
        enrichment_data["weaknesses"] = []
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=enrichment_data)
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(responses=[_haiku_response(score=75)])

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=fetcher,
            enrichment_fetcher=enrichment,
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert len(repo.inserted) == 1
        q = repo.inserted[0]
        assert q["score"] == 75
        assert q["has_actionable_weakness"] is False
        assert q["subject_line"] is None
        assert q["personalised_opener"] is None
        assert q["followup_1"] is None
        assert q["followup_2"] is None
        assert q["weakness_sentence"] is None
        assert q["model_sonnet"] is None
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "archived")]
        assert queue.jobs == []
        assert len(client.calls) == 1
        assert client.calls[0][0] == "qualify-v1"

    asyncio.run(scenario())


def test_haiku_response_supplying_has_actionable_weakness_dead_letters_after_retry() -> None:
    """Successor to test_haiku_response_missing_has_actionable_weakness_...

    The field used to be required; now it is forbidden. A model that supplies
    it anyway must not be able to override the code-derived gate, so the
    response is rejected and retried rather than trusted.
    """

    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        supplies_gate = ClaudeResponse(
            text=json.dumps(
                {
                    "score": 75,
                    "rationale": "No mobile site, slow load.",
                    "top_weakness": "no_mobile",
                    "weakness_label": "no_mobile",
                    # The code owns this now; the model must not send it.
                    "has_actionable_weakness": False,
                }
            ),
            cost_usd=HAIKU_COST,
            model=HAIKU_MODEL,
        )
        client = FakeClaudeClient(responses=[supplies_gate, supplies_gate])

        with pytest.raises(DeadLetterError):
            await qualify_lead(
                _payload(score_threshold=40),
                lead_fetcher=fetcher,
                enrichment_fetcher=enrichment,
                qualification_repo=repo,
                outreach_queue=queue,
                claude_client=client,
            )

        assert repo.inserted == []
        assert queue.jobs == []
        assert len(client.calls) == 2

    asyncio.run(scenario())


def test_haiku_schema_validates_with_only_core_fields() -> None:
    data = {
        "score": 75,
        "rationale": "No mobile site, slow load.",
        "top_weakness": "no_mobile",
        "weakness_label": "no_mobile",
    }

    result = _parse_and_validate(json.dumps(data), _HAIKU_SCHEMA)

    assert result == data


def test_haiku_schema_no_longer_rejects_an_unknown_weakness_label() -> None:
    """Replaces test_haiku_schema_rejects_weakness_label_outside_enum.

    Rejection moved from the schema to the grounding check, which is stronger.
    See test_ungrounded_weakness_label_still_dead_letters_when_something_was_
    measured for the end-to-end guarantee this hands off to.
    """
    data = {
        "score": 75,
        "rationale": "No mobile site, slow load.",
        "top_weakness": "no_mobile",
        "weakness_label": "not_a_real_label",
    }

    assert _parse_and_validate(json.dumps(data), _HAIKU_SCHEMA) == data


def test_haiku_schema_requires_weakness_label() -> None:
    data = {
        "score": 75,
        "rationale": "No mobile site, slow load.",
        "top_weakness": "no_mobile",
    }

    result = _parse_and_validate(json.dumps(data), _HAIKU_SCHEMA)

    assert result is None


# ---------------------------------------------------------------------------
# weakness_label grounding (CHANGE 3b)
# ---------------------------------------------------------------------------


def test_haiku_weakness_label_outside_enum_dead_letters_after_retry() -> None:
    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        invalid_label = ClaudeResponse(
            text=json.dumps(
                {
                    "score": 75,
                    "rationale": "No mobile site.",
                    "top_weakness": "no_mobile",
                    "weakness_label": "not_a_real_label",
                }
            ),
            cost_usd=HAIKU_COST,
            model=HAIKU_MODEL,
        )
        client = FakeClaudeClient(responses=[invalid_label, invalid_label])

        with pytest.raises(DeadLetterError):
            await qualify_lead(
                _payload(score_threshold=40),
                lead_fetcher=fetcher,
                enrichment_fetcher=enrichment,
                qualification_repo=repo,
                outreach_queue=queue,
                claude_client=client,
            )

        assert repo.inserted == []
        assert queue.jobs == []
        assert len(client.calls) == 2

    asyncio.run(scenario())


def test_haiku_weakness_label_not_grounded_in_enrichment_weaknesses_dead_letters_after_retry() -> (
    None
):
    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        # _make_enrichment()'s weaknesses are ["no_mobile", "no_meta_description"] —
        # "no_ssl" is a valid enum member but was never measured on this lead.
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        ungrounded = ClaudeResponse(
            text=json.dumps(
                {
                    "score": 75,
                    "rationale": "Site has no SSL certificate.",
                    "top_weakness": "no_ssl",
                    "weakness_label": "no_ssl",
                }
            ),
            cost_usd=HAIKU_COST,
            model=HAIKU_MODEL,
        )
        client = FakeClaudeClient(responses=[ungrounded, ungrounded])

        with pytest.raises(DeadLetterError):
            await qualify_lead(
                _payload(score_threshold=40),
                lead_fetcher=fetcher,
                enrichment_fetcher=enrichment,
                qualification_repo=repo,
                outreach_queue=queue,
                claude_client=client,
            )

        assert repo.inserted == []
        assert queue.jobs == []
        assert len(client.calls) == 2
        assert client.calls[0][0] == "qualify-v1"
        assert client.calls[1][0] == "qualify-v1"

    asyncio.run(scenario())


def test_haiku_weakness_label_grounded_on_retry_proceeds_to_sonnet() -> None:
    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        ungrounded = ClaudeResponse(
            text=json.dumps(
                {
                    "score": 75,
                    "rationale": "Site has no SSL certificate.",
                    "top_weakness": "no_ssl",
                    "weakness_label": "no_ssl",
                }
            ),
            cost_usd=HAIKU_COST,
            model=HAIKU_MODEL,
        )
        grounded = _haiku_response(score=75, weakness_label="no_mobile", top_weakness="no_mobile")
        client = FakeClaudeClient(responses=[ungrounded, grounded, _sonnet_response()])

        await qualify_lead(
            _payload(score_threshold=40, campaign_id="campaign-x"),
            lead_fetcher=fetcher,
            enrichment_fetcher=enrichment,
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert len(client.calls) == 3
        assert client.calls[0][0] == "qualify-v1"
        assert client.calls[1][0] == "qualify-v1"
        assert client.calls[2][0] == "opener-v2"
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "qualified")]
        assert len(queue.jobs) == 1

    asyncio.run(scenario())


def test_empty_weaknesses_array_with_no_actionable_weakness_archives_without_dead_letter() -> (
    None
):
    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment_data = _make_enrichment()
        enrichment_data["weaknesses"] = []
        enrichment = FakeEnrichmentFetcher(enrichment=enrichment_data)
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        haiku = ClaudeResponse(
            text=json.dumps(
                {
                    "score": 75,
                    "rationale": "Site looks solid already.",
                    "top_weakness": "no weaknesses found",
                    # weakness_label must still be schema-valid even though
                    # nothing was actually measured. The grounding check that
                    # would otherwise dead-letter on it never runs, because
                    # the derived has_actionable_weakness=False archives
                    # first. This ordering is the point of the test.
                    "weakness_label": "no_mobile",
                }
            ),
            cost_usd=HAIKU_COST,
            model=HAIKU_MODEL,
        )
        client = FakeClaudeClient(responses=[haiku])

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=fetcher,
            enrichment_fetcher=enrichment,
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "archived")]
        assert repo.inserted[0]["has_actionable_weakness"] is False
        assert queue.jobs == []
        assert len(client.calls) == 1

    asyncio.run(scenario())


def test_sonnet_call_receives_enrichment_json() -> None:
    async def scenario() -> None:
        enrichment_data = _make_enrichment()
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(responses=[_haiku_response(score=75), _sonnet_response()])

        await qualify_lead(
            _payload(score_threshold=40, campaign_id="campaign-x"),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=enrichment_data),
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        haiku_call = client.calls[0]
        sonnet_call = client.calls[1]
        assert haiku_call[0] == "qualify-v1"
        assert "enrichment_json" in haiku_call[1]
        assert sonnet_call[0] == "opener-v2"
        assert "enrichment_json" in sonnet_call[1]
        assert json.loads(sonnet_call[1]["enrichment_json"]) == json.loads(
            json.dumps(enrichment_data, default=str)
        )

    asyncio.run(scenario())


def test_sonnet_call_receives_the_offer_price() -> None:
    """opener-v2 renders {price_aud}, so the caller must supply it.

    Without this the prompt would emit a literal "{price_aud}" into
    customer-facing email copy.
    """

    async def scenario() -> None:
        client = FakeClaudeClient(responses=[_haiku_response(score=75), _sonnet_response()])

        await qualify_lead(
            _payload(score_threshold=40, campaign_id="campaign-x"),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=_make_enrichment()),
            qualification_repo=FakeQualificationRepository(),
            outreach_queue=FakeOutreachQueue(),
            claude_client=client,
        )

        sonnet_call = client.calls[1]
        assert sonnet_call[0] == "opener-v2"
        assert sonnet_call[1]["price_aud"] == "1,499"

    asyncio.run(scenario())


def test_top_weakness_em_dash_is_normalised_on_persist() -> None:
    async def scenario() -> None:
        repo = FakeQualificationRepository()
        haiku = ClaudeResponse(
            text=json.dumps(
                {
                    "score": 30,
                    "rationale": "Weak site overall—worth flagging.",
                    "top_weakness": "Missing H1 tag on homepage—hurts SEO",
                    "weakness_label": "no_mobile",
                }
            ),
            cost_usd=HAIKU_COST,
            model=HAIKU_MODEL,
        )
        client = FakeClaudeClient(responses=[haiku])

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=_make_enrichment()),
            qualification_repo=repo,
            outreach_queue=FakeOutreachQueue(),
            claude_client=client,
        )

        q = repo.inserted[0]
        assert "—" not in q["top_weakness"]
        assert "—" not in q["rationale"]
        assert q["top_weakness"] == "Missing H1 tag on homepage, hurts SEO"
        assert q["rationale"] == "Weak site overall, worth flagging."

    asyncio.run(scenario())


def test_top_weakness_en_dash_is_normalised_on_persist() -> None:
    async def scenario() -> None:
        repo = FakeQualificationRepository()
        haiku = ClaudeResponse(
            text=json.dumps(
                {
                    "score": 30,
                    "rationale": "Slow across the board.",
                    "top_weakness": (
                        "Website load time is 5.5 seconds – slower than ideal"
                    ),
                    "weakness_label": "slow_load",
                }
            ),
            cost_usd=HAIKU_COST,
            model=HAIKU_MODEL,
        )
        client = FakeClaudeClient(responses=[haiku])

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=_make_enrichment()),
            qualification_repo=repo,
            outreach_queue=FakeOutreachQueue(),
            claude_client=client,
        )

        q = repo.inserted[0]
        assert "–" not in q["top_weakness"]
        assert q["top_weakness"] == "Website load time is 5.5 seconds, slower than ideal"

    asyncio.run(scenario())


def test_sonnet_outputs_with_dashes_are_normalised_on_persist() -> None:
    async def scenario() -> None:
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        sonnet = ClaudeResponse(
            text=json.dumps(
                {
                    "subject_line": "Stone Builders—your site's costing you jobs",
                    "opener": "Brett, your site loads slow – that's costing quotes.",
                    "followup_1": "Quick fix available—want a look?",
                    "followup_2": "Last nudge – offer's open if timing works.",
                    "weakness_sentence": "loads slow—that costs you jobs",
                }
            ),
            cost_usd=SONNET_COST,
            model=SONNET_MODEL,
        )
        client = FakeClaudeClient(responses=[_haiku_response(score=75), sonnet])

        await qualify_lead(
            _payload(score_threshold=40, campaign_id="campaign-x"),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=_make_enrichment()),
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        q = repo.inserted[0]
        assert q["subject_line"] == "Stone Builders, your site's costing you jobs"
        assert q["personalised_opener"] == "Brett, your site loads slow, that's costing quotes."
        assert q["followup_1"] == "Quick fix available, want a look?"
        assert q["followup_2"] == "Last nudge, offer's open if timing works."
        assert q["weakness_sentence"] == "loads slow, that costs you jobs"
        for field_name in (
            "subject_line",
            "personalised_opener",
            "followup_1",
            "followup_2",
            "weakness_sentence",
        ):
            assert "—" not in q[field_name]
            assert "–" not in q[field_name]

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# has_actionable_weakness is code-derived, not model-judged
# ---------------------------------------------------------------------------


def test_actionable_weakness_derived_true_from_non_empty_enrichment_weaknesses() -> None:
    """The gate comes from the enrichment array, so Haiku need not supply it."""

    async def scenario() -> None:
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(
            responses=[_haiku_response(score=75), _sonnet_response()]
        )

        await qualify_lead(
            _payload(score_threshold=40, campaign_id="campaign-x"),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=_make_enrichment()),
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert repo.inserted[0]["has_actionable_weakness"] is True
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "qualified")]
        assert len(queue.jobs) == 1

    asyncio.run(scenario())


def test_actionable_weakness_derived_false_from_empty_enrichment_weaknesses() -> None:
    """An empty weaknesses array archives even when Haiku scores the lead well.

    This is the original defect the gate was built for and it must keep
    working once the value is derived rather than asked for.
    """

    async def scenario() -> None:
        enrichment_data = _make_enrichment()
        enrichment_data["weaknesses"] = []
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(responses=[_haiku_response(score=95)])

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=enrichment_data),
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert repo.inserted[0]["has_actionable_weakness"] is False
        assert repo.inserted[0]["model_sonnet"] is None
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "archived")]
        assert queue.jobs == []
        assert len(client.calls) == 1

    asyncio.run(scenario())


def test_measured_weakness_reaches_sonnet_despite_being_minor() -> None:
    """The production bug: a lone no_h1 archived because the model judged it
    not "worth pitching a rebuild over". Severity is the score threshold's
    job; presence of a measured defect is the gate's."""

    async def scenario() -> None:
        enrichment_data = _make_enrichment()
        enrichment_data["weaknesses"] = ["no_h1"]
        enrichment_data["is_mobile_friendly"] = True
        enrichment_data["has_meta_description"] = True
        enrichment_data["has_h1"] = False
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(
            responses=[
                _haiku_response(
                    score=42, top_weakness="no_h1", weakness_label="no_h1"
                ),
                _sonnet_response(),
            ]
        )

        await qualify_lead(
            _payload(score_threshold=40, campaign_id="campaign-x"),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=enrichment_data),
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert repo.inserted[0]["has_actionable_weakness"] is True
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "qualified")]
        assert len(queue.jobs) == 1

    asyncio.run(scenario())


def test_missing_enrichment_weaknesses_key_derives_false_and_archives() -> None:
    async def scenario() -> None:
        enrichment_data = _make_enrichment()
        del enrichment_data["weaknesses"]
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(responses=[_haiku_response(score=95)])

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=enrichment_data),
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert repo.inserted[0]["has_actionable_weakness"] is False
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "archived")]
        assert queue.jobs == []

    asyncio.run(scenario())


def test_non_list_enrichment_weaknesses_derives_false_and_archives() -> None:
    """A non-list `weaknesses` must never be read as measured weaknesses.

    The truthy case is the one that matters. An undecoded jsonb str is
    truthy, and `"no_mobile" in '["no_mobile"]'` is True by substring match,
    so without the isinstance guard the lead would clear both the derived
    gate and the grounding check and be emailed on data nothing verified.
    Delete the guard and this test fails; `None` alone cannot catch that,
    because bool(None) already archives before the guard is reached.
    """

    async def scenario(weaknesses: object) -> None:
        enrichment_data = _make_enrichment()
        enrichment_data["weaknesses"] = weaknesses
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(responses=[_haiku_response(score=95)])

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=enrichment_data),
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert repo.inserted[0]["has_actionable_weakness"] is False
        assert repo.inserted[0]["model_sonnet"] is None
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "archived")]
        assert queue.jobs == []
        assert len(client.calls) == 1

    asyncio.run(scenario(None))
    asyncio.run(scenario('["no_mobile"]'))


def test_empty_weaknesses_with_weakness_label_none_archives_without_dead_letter() -> None:
    """Found by re-enriching production: a clean site dead-lettered.

    The prompt tells Haiku to pick a label matching an entry in the enrichment
    weaknesses array. When that array is empty there is no such entry, so it
    answers "none", which failed the enum. Schema validation runs before the
    archive gates and cannot be reordered after them, so the lead died on
    parsing instead of archiving on the derived gate. Roughly 60% of real
    audits have an empty array, so this was set to dead-letter leads in bulk.
    """

    async def scenario() -> None:
        enrichment_data = _make_enrichment()
        enrichment_data["weaknesses"] = []
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        haiku = ClaudeResponse(
            text=json.dumps(
                {
                    "score": 30,
                    "rationale": "Site is in good shape already.",
                    "top_weakness": "none found",
                    "weakness_label": "none",
                }
            ),
            cost_usd=HAIKU_COST,
            model=HAIKU_MODEL,
        )
        client = FakeClaudeClient(responses=[haiku])

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=enrichment_data),
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert repo.inserted[0]["has_actionable_weakness"] is False
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "archived")]
        assert queue.jobs == []
        assert len(client.calls) == 1

    asyncio.run(scenario())


def test_weakness_label_none_against_measured_weaknesses_still_dead_letters() -> None:
    """"none" must not become an escape hatch for a lead that does have one.

    If the enrichment measured something, "none" is ungrounded and the lead
    must not reach Sonnet on it.
    """

    async def scenario() -> None:
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        says_none = _haiku_response(score=75, weakness_label="none", top_weakness="none found")
        client = FakeClaudeClient(responses=[says_none, says_none])

        with pytest.raises(DeadLetterError):
            await qualify_lead(
                _payload(score_threshold=40),
                lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
                enrichment_fetcher=FakeEnrichmentFetcher(enrichment=_make_enrichment()),
                qualification_repo=repo,
                outreach_queue=queue,
                claude_client=client,
            )

        assert repo.inserted == []
        assert queue.jobs == []

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "label", ["none", "", "no_weakness_detected", "n/a", "None detected in audit"]
)
def test_any_weakness_label_archives_cleanly_when_nothing_was_measured(label: str) -> None:
    """Haiku has no single spelling for "nothing", and it does not need one.

    Production returned "none", "" and "no_weakness_detected" for the same
    situation within one batch. Constraining the field to an enum turned each
    new spelling into a dead-lettered lead. The label only feeds the grounding
    check, which never runs for an empty array because the derived gate
    archives first, so any value here is harmless.
    """

    async def scenario() -> None:
        enrichment_data = _make_enrichment()
        enrichment_data["weaknesses"] = []
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        haiku = ClaudeResponse(
            text=json.dumps(
                {
                    "score": 30,
                    "rationale": "Site is in good shape already.",
                    "top_weakness": "none found",
                    "weakness_label": label,
                }
            ),
            cost_usd=HAIKU_COST,
            model=HAIKU_MODEL,
        )
        client = FakeClaudeClient(responses=[haiku])

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=enrichment_data),
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "archived")]
        assert repo.inserted[0]["has_actionable_weakness"] is False
        assert queue.jobs == []
        assert len(client.calls) == 1

    asyncio.run(scenario())


@pytest.mark.parametrize("label", ["none", "", "not_a_real_label", "no_ssl"])
def test_ungrounded_weakness_label_still_dead_letters_when_something_was_measured(
    label: str,
) -> None:
    """Dropping the enum must not weaken the guarantee that matters.

    The grounding check is stronger than the enum ever was: it validates
    against what this lead's audit actually measured, not merely against the
    vocabulary. "no_ssl" is a perfectly valid canonical label and still has to
    be rejected here, because this lead's array does not contain it.
    """

    async def scenario() -> None:
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        ungrounded = _haiku_response(score=75, weakness_label=label, top_weakness="x")
        client = FakeClaudeClient(responses=[ungrounded, ungrounded])

        with pytest.raises(DeadLetterError):
            await qualify_lead(
                _payload(score_threshold=40),
                lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
                enrichment_fetcher=FakeEnrichmentFetcher(enrichment=_make_enrichment()),
                qualification_repo=repo,
                outreach_queue=queue,
                claude_client=client,
            )

        assert repo.inserted == []
        assert queue.jobs == []

    asyncio.run(scenario())


def test_haiku_schema_accepts_weakness_label_none() -> None:
    data = {
        "score": 30,
        "rationale": "Site is in good shape already.",
        "top_weakness": "none found",
        "weakness_label": "none",
    }

    assert _parse_and_validate(json.dumps(data), _HAIKU_SCHEMA) == data


def test_none_is_not_added_to_the_canonical_measured_vocabulary() -> None:
    """"none" is a Haiku answer, not a weakness a producer can measure."""
    from weaknesses import WEAKNESS_LABELS

    assert "none" not in WEAKNESS_LABELS


def test_haiku_schema_rejects_model_supplied_actionable_weakness() -> None:
    """The model must not be able to send the gate value at all.

    additionalProperties is False, so a stray has_actionable_weakness fails
    validation and takes the retry path rather than silently overriding a
    value the code now owns.
    """
    data = {
        "score": 75,
        "rationale": "No mobile site, slow load.",
        "top_weakness": "no_mobile",
        "weakness_label": "no_mobile",
        "has_actionable_weakness": False,
    }

    assert _parse_and_validate(json.dumps(data), _HAIKU_SCHEMA) is None


def test_schema_violation_logs_the_validation_error_not_invalid_json(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A stray field must not be reported to the operator as malformed JSON.

    The retry-then-dead-letter path is deliberately fail-closed, so if the
    model ever starts emitting has_actionable_weakness systematically the
    operator sees a wave of dead-letters. "Haiku returned invalid JSON" would
    send them looking at the parser; the schema error names the real cause.
    """
    data = {
        "score": 75,
        "rationale": "No mobile site, slow load.",
        "top_weakness": "no_mobile",
        "weakness_label": "no_mobile",
        "has_actionable_weakness": False,
    }

    with caplog.at_level(logging.WARNING, logger="workers.qualify"):
        assert _parse_and_validate(json.dumps(data), _HAIKU_SCHEMA) is None

    logged = " ".join(record.getMessage() for record in caplog.records)
    assert "has_actionable_weakness" in logged
    assert "invalid JSON" not in logged


def test_malformed_json_logs_a_decode_error_distinct_from_schema_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger="workers.qualify"):
        assert _parse_and_validate("{not json at all", _HAIKU_SCHEMA) is None

    logged = " ".join(record.getMessage() for record in caplog.records)
    assert "schema" not in logged.lower()


def test_haiku_schema_validates_response_without_actionable_weakness() -> None:
    data = {
        "score": 75,
        "rationale": "No mobile site, slow load.",
        "top_weakness": "no_mobile",
        "weakness_label": "no_mobile",
    }

    assert _parse_and_validate(json.dumps(data), _HAIKU_SCHEMA) == data


def test_sonnet_response_missing_weakness_sentence_dead_letters_after_retry() -> None:
    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        sonnet_missing_field = ClaudeResponse(
            text=json.dumps(
                {
                    "subject_line": "Stone Builders, your site's costing you mobile jobs",
                    "opener": "Brett, Stone Builders online, great work, but invisible on phones.",
                    "followup_1": "Could be worth a quick chat, I build sites for tradies.",
                    "followup_2": "No pressure, just happy to show you what's possible.",
                }
            ),
            cost_usd=SONNET_COST,
            model=SONNET_MODEL,
        )
        client = FakeClaudeClient(
            responses=[
                _haiku_response(score=75),
                sonnet_missing_field,
                sonnet_missing_field,
            ]
        )

        with pytest.raises(DeadLetterError):
            await qualify_lead(
                _payload(score_threshold=40),
                lead_fetcher=fetcher,
                enrichment_fetcher=enrichment,
                qualification_repo=repo,
                outreach_queue=queue,
                claude_client=client,
            )

        assert repo.inserted == []
        assert repo.status_updates == []
        assert queue.jobs == []
        assert len(client.calls) == 3

    asyncio.run(scenario())


def test_sonnet_schema_requires_weakness_sentence() -> None:
    data = {
        "subject_line": "Subject",
        "opener": "Opener",
        "followup_1": "Follow 1",
        "followup_2": "Follow 2",
    }

    result = _parse_and_validate(json.dumps(data), _SONNET_SCHEMA)

    assert result is None


def test_happy_path_persists_weakness_sentence() -> None:
    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(responses=[_haiku_response(score=75), _sonnet_response()])

        await qualify_lead(
            _payload(score_threshold=40, campaign_id="campaign-x"),
            lead_fetcher=fetcher,
            enrichment_fetcher=enrichment,
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        q = repo.inserted[0]
        assert q["weakness_sentence"] == (
            "your site isn't built for mobile, so most visitors give up before they call"
        )

    asyncio.run(scenario())


def test_weakness_sentence_dashes_normalised_on_persist() -> None:
    async def scenario() -> None:
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        sonnet = ClaudeResponse(
            text=json.dumps(
                {
                    "subject_line": "Subject",
                    "opener": "Opener",
                    "followup_1": "Follow 1",
                    "followup_2": "Follow 2",
                    "weakness_sentence": (
                        "site loads slowly—that costs you jobs, and takes 5 seconds "
                        "– too long for mobile users"
                    ),
                }
            ),
            cost_usd=SONNET_COST,
            model=SONNET_MODEL,
        )
        client = FakeClaudeClient(responses=[_haiku_response(score=75), sonnet])

        await qualify_lead(
            _payload(score_threshold=40, campaign_id="campaign-x"),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=_make_enrichment()),
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        q = repo.inserted[0]
        assert "—" not in q["weakness_sentence"]
        assert "–" not in q["weakness_sentence"]
        assert q["weakness_sentence"] == (
            "site loads slowly, that costs you jobs, and takes 5 seconds, "
            "too long for mobile users"
        )

    asyncio.run(scenario())


def test_above_threshold_qualifies_lead_calls_sonnet_enqueues_outreach(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        monkeypatch.setenv("INSTANTLY_CAMPAIGN_ID", "campaign-from-env")
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(responses=[_haiku_response(score=75), _sonnet_response()])

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=fetcher,
            enrichment_fetcher=enrichment,
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert len(repo.inserted) == 1
        q = repo.inserted[0]
        assert q["score"] == 75
        assert q["model_sonnet"] == SONNET_MODEL
        assert q["personalised_opener"] is not None
        assert q["has_actionable_weakness"] is True
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "qualified")]
        assert len(queue.jobs) == 1
        outreach_payload = queue.jobs[0]
        assert outreach_payload["job_type"] == JobType.GENERATE_PREVIEW.value
        assert outreach_payload["tenant_id"] == str(TENANT_ID)
        assert outreach_payload["lead_id"] == str(LEAD_ID)
        assert outreach_payload["campaign_id"] == "campaign-from-env"
        assert outreach_payload["channel"] == "email"
        assert isinstance(outreach_payload["send_after"], str)
        datetime.fromisoformat(outreach_payload["send_after"])
        assert len(client.calls) == 2
        assert client.calls[1][0] == "opener-v2"

    asyncio.run(scenario())


def test_fenced_haiku_json_is_accepted_and_qualifies_lead(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        monkeypatch.setenv("INSTANTLY_CAMPAIGN_ID", "campaign-from-env")
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        haiku = _haiku_response(score=75)
        fenced_haiku = ClaudeResponse(
            text=f"```json\n{haiku.text}\n```",
            cost_usd=haiku.cost_usd,
            model=haiku.model,
        )

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=_make_enrichment()),
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=FakeClaudeClient(responses=[fenced_haiku, _sonnet_response()]),
        )

        assert repo.inserted[0]["score"] == 75
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "qualified")]
        assert queue.jobs[0]["job_type"] == JobType.GENERATE_PREVIEW.value

    asyncio.run(scenario())


def test_outreach_campaign_id_can_come_from_qualify_payload() -> None:
    async def scenario() -> None:
        queue = FakeOutreachQueue()

        await qualify_lead(
            _payload(campaign_id="campaign-from-payload"),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=_make_enrichment()),
            qualification_repo=FakeQualificationRepository(),
            outreach_queue=queue,
            claude_client=FakeClaudeClient(
                responses=[_haiku_response(score=75), _sonnet_response()]
            ),
        )

        assert queue.jobs[0]["campaign_id"] == "campaign-from-payload"

    asyncio.run(scenario())


def test_outreach_send_after_preserves_qualify_payload_value() -> None:
    async def scenario() -> None:
        queue = FakeOutreachQueue()
        send_after = "2026-05-25T09:30:00+10:00"

        await qualify_lead(
            _payload(campaign_id="campaign-from-payload", send_after=send_after),
            lead_fetcher=FakeLeadFetcher(lead=_make_lead()),
            enrichment_fetcher=FakeEnrichmentFetcher(enrichment=_make_enrichment()),
            qualification_repo=FakeQualificationRepository(),
            outreach_queue=queue,
            claude_client=FakeClaudeClient(
                responses=[_haiku_response(score=75), _sonnet_response()]
            ),
        )

        assert queue.jobs[0]["job_type"] == JobType.GENERATE_PREVIEW.value
        assert queue.jobs[0]["send_after"] == send_after

    asyncio.run(scenario())


def test_bad_json_retries_once_then_raises_dead_letter_error() -> None:
    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        bad = ClaudeResponse(text="not json at all", cost_usd=HAIKU_COST, model=HAIKU_MODEL)
        client = FakeClaudeClient(responses=[bad, bad])

        try:
            await qualify_lead(
                _payload(),
                lead_fetcher=fetcher,
                enrichment_fetcher=enrichment,
                qualification_repo=repo,
                outreach_queue=queue,
                claude_client=client,
            )
            raise AssertionError("Expected DeadLetterError")
        except DeadLetterError:
            pass

        assert repo.inserted == []
        assert repo.status_updates == []
        assert queue.jobs == []
        assert len(client.calls) == 2

    asyncio.run(scenario())


def test_cost_usd_sums_haiku_and_sonnet() -> None:
    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(responses=[_haiku_response(score=75), _sonnet_response()])

        await qualify_lead(
            _payload(score_threshold=40, campaign_id="campaign-from-payload"),
            lead_fetcher=fetcher,
            enrichment_fetcher=enrichment,
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert repo.inserted[0]["cost_usd"] == HAIKU_COST + SONNET_COST

    asyncio.run(scenario())


def test_prompt_version_is_opener_v2_on_every_qualification_row() -> None:
    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(responses=[_haiku_response(score=30)])

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=fetcher,
            enrichment_fetcher=enrichment,
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert repo.inserted[0]["prompt_version"] == "opener-v2"

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# DB query tests
# ---------------------------------------------------------------------------


def test_get_enrichment_by_lead_id_is_tenant_scoped() -> None:
    async def scenario() -> None:
        expected = {"id": ENRICHMENT_ID, "lead_id": LEAD_ID, "tenant_id": TENANT_ID}

        class _Conn(RecordingConnection):
            async def fetchrow(self, query: str, *args: object) -> object:
                self.queries.append(query)
                self.args.append(args)
                return expected

        conn = _Conn()
        result = await get_enrichment_by_lead_id(conn, tenant_id=TENANT_ID, lead_id=LEAD_ID)

        assert "tenant_id = $1" in conn.queries[0]
        assert "lead_id = $2" in conn.queries[0]
        assert conn.args[0] == (TENANT_ID, LEAD_ID)
        assert result == expected

    asyncio.run(scenario())


def test_get_enrichment_by_lead_id_decodes_jsonb_columns() -> None:
    """asyncpg returns jsonb as str unless a codec is registered, and none is.

    Verified against production: `SELECT weaknesses FROM enrichments` comes
    back as the str '["no_ssl"]', not a list. Every consumer of this row
    type-checks the value, so an undecoded str silently reads as "no
    weaknesses measured" and archives the lead.
    """

    async def scenario() -> None:
        class _Conn(RecordingConnection):
            async def fetchrow(self, query: str, *args: object) -> object:
                self.queries.append(query)
                self.args.append(args)
                return {
                    "id": ENRICHMENT_ID,
                    "lead_id": LEAD_ID,
                    "tenant_id": TENANT_ID,
                    "weaknesses": '["no_h1", "slow_load"]',
                    "raw_audit": '{"url": "https://example.com", "status": 200}',
                }

        result = await get_enrichment_by_lead_id(_Conn(), tenant_id=TENANT_ID, lead_id=LEAD_ID)

        assert result["weaknesses"] == ["no_h1", "slow_load"]
        assert result["raw_audit"] == {"url": "https://example.com", "status": 200}

    asyncio.run(scenario())


def test_get_enrichment_by_lead_id_passes_through_already_decoded_values() -> None:
    """Must stay correct if a jsonb codec is ever registered on the pool."""

    async def scenario() -> None:
        class _Conn(RecordingConnection):
            async def fetchrow(self, query: str, *args: object) -> object:
                self.queries.append(query)
                self.args.append(args)
                return {
                    "id": ENRICHMENT_ID,
                    "weaknesses": ["no_h1"],
                    "raw_audit": None,
                }

        result = await get_enrichment_by_lead_id(_Conn(), tenant_id=TENANT_ID, lead_id=LEAD_ID)

        assert result["weaknesses"] == ["no_h1"]
        assert result["raw_audit"] is None

    asyncio.run(scenario())


def test_insert_qualification_writes_tenant_scoped_row() -> None:
    async def scenario() -> None:
        qual_id = UUID("40000000-0000-0000-0000-000000000001")
        conn = RecordingConnection(fetchval_result=qual_id)

        inserted_id = await insert_qualification(
            conn,
            QualificationInsert(
                lead_id=LEAD_ID,
                tenant_id=TENANT_ID,
                score=75,
                rationale="Strong weakness",
                top_weakness="no_mobile",
                has_actionable_weakness=True,
                subject_line="Subject",
                personalised_opener="Opener",
                followup_1="Follow 1",
                followup_2="Follow 2",
                weakness_sentence="Weakness sentence",
                model_haiku=HAIKU_MODEL,
                model_sonnet=SONNET_MODEL,
                cost_usd=HAIKU_COST + SONNET_COST,
                prompt_version="qualify-v1",
            ),
        )

        assert inserted_id == qual_id
        q = conn.queries[0]
        assert "INSERT INTO qualifications" in q
        assert "SELECT" in q
        assert "FROM leads" in q
        assert "WHERE id = $1" in q
        assert "tenant_id = $2" in q
        assert "ON CONFLICT (lead_id) DO UPDATE" in q
        assert "qualifications.tenant_id = EXCLUDED.tenant_id" in q
        assert "tenant_id" in q
        assert "lead_id" in q
        assert "has_actionable_weakness" in q
        assert "weakness_sentence" in q
        assert conn.args[0][0] == LEAD_ID
        assert conn.args[0][1] == TENANT_ID

    asyncio.run(scenario())


def test_grounding_retry_returning_below_threshold_score_archives_without_sonnet() -> None:
    """The grounding retry replaces score, so the threshold gate must re-run.

    Without this the retried lead reaches Sonnet and is emailed despite scoring
    below threshold, because the gate above already ran on the superseded
    response.
    """

    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        ungrounded = _haiku_response(score=75, weakness_label="no_ssl", top_weakness="no_ssl")
        retried_low_score = _haiku_response(score=5, weakness_label="no_mobile")
        client = FakeClaudeClient(responses=[ungrounded, retried_low_score])

        await qualify_lead(
            _payload(score_threshold=40, campaign_id="campaign-x"),
            lead_fetcher=fetcher,
            enrichment_fetcher=enrichment,
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert len(client.calls) == 2
        assert all(call[0] == "qualify-v1" for call in client.calls)
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "archived")]
        assert repo.inserted[0]["personalised_opener"] is None
        assert queue.jobs == []

    asyncio.run(scenario())


def test_grounding_retry_cannot_supply_has_actionable_weakness() -> None:
    """Successor to test_grounding_retry_returning_no_actionable_weakness_...

    That test protected the re-check of a gate the retry could replace. The
    retry can no longer replace it: the value is derived from enrichment,
    which no model call changes. What still needs protecting is the retry
    path's schema validation, so a retry that smuggles the field in is
    rejected rather than trusted, exactly as the first call would be.
    """

    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        ungrounded = _haiku_response(score=75, weakness_label="no_ssl", top_weakness="no_ssl")
        retried_supplying_gate = ClaudeResponse(
            text=json.dumps(
                {
                    "score": 75,
                    "rationale": "No mobile site.",
                    "top_weakness": "no_mobile",
                    "weakness_label": "no_mobile",
                    "has_actionable_weakness": False,
                }
            ),
            cost_usd=HAIKU_COST,
            model=HAIKU_MODEL,
        )
        client = FakeClaudeClient(responses=[ungrounded, retried_supplying_gate])

        with pytest.raises(DeadLetterError):
            await qualify_lead(
                _payload(score_threshold=40, campaign_id="campaign-x"),
                lead_fetcher=fetcher,
                enrichment_fetcher=enrichment,
                qualification_repo=repo,
                outreach_queue=queue,
                claude_client=client,
            )

        assert len(client.calls) == 2
        assert repo.inserted == []
        assert queue.jobs == []

    asyncio.run(scenario())


def test_grounding_retry_persists_derived_gate_not_a_model_claim() -> None:
    """A successful grounding retry still persists the derived gate value."""

    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        ungrounded = _haiku_response(score=75, weakness_label="no_ssl", top_weakness="no_ssl")
        grounded = _haiku_response(score=75, weakness_label="no_mobile")
        client = FakeClaudeClient(responses=[ungrounded, grounded, _sonnet_response()])

        await qualify_lead(
            _payload(score_threshold=40, campaign_id="campaign-x"),
            lead_fetcher=fetcher,
            enrichment_fetcher=enrichment,
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert repo.inserted[0]["has_actionable_weakness"] is True
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "qualified")]

    asyncio.run(scenario())

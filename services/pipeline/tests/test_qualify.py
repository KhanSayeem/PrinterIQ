from __future__ import annotations

import asyncio
import json
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
    has_actionable_weakness: bool = True,
    top_weakness: str = "no_mobile",
) -> ClaudeResponse:
    content = json.dumps(
        {
            "score": score,
            "rationale": "No mobile site, slow load. Strong weakness for pitch.",
            "top_weakness": top_weakness,
            "has_actionable_weakness": has_actionable_weakness,
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
        assert q["has_actionable_weakness"] is True
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "archived")]
        assert queue.jobs == []
        assert len(client.calls) == 1
        assert client.calls[0][0] == "qualify-v1"

    asyncio.run(scenario())


def test_below_threshold_archives_lead_regardless_of_actionable_weakness() -> None:
    async def scenario(has_actionable_weakness: bool) -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(
            responses=[_haiku_response(score=30, has_actionable_weakness=has_actionable_weakness)]
        )

        await qualify_lead(
            _payload(score_threshold=40),
            lead_fetcher=fetcher,
            enrichment_fetcher=enrichment,
            qualification_repo=repo,
            outreach_queue=queue,
            claude_client=client,
        )

        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "archived")]
        assert repo.inserted[0]["has_actionable_weakness"] == has_actionable_weakness
        assert repo.inserted[0]["model_sonnet"] is None
        assert queue.jobs == []
        assert len(client.calls) == 1

    asyncio.run(scenario(True))
    asyncio.run(scenario(False))


def test_above_threshold_without_actionable_weakness_archives_lead_single_claude_call() -> None:
    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        client = FakeClaudeClient(
            responses=[_haiku_response(score=75, has_actionable_weakness=False)]
        )

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
        assert q["model_sonnet"] is None
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "archived")]
        assert queue.jobs == []
        assert len(client.calls) == 1
        assert client.calls[0][0] == "qualify-v1"

    asyncio.run(scenario())


def test_haiku_response_missing_has_actionable_weakness_dead_letters_after_retry() -> None:
    async def scenario() -> None:
        fetcher = FakeLeadFetcher(lead=_make_lead())
        enrichment = FakeEnrichmentFetcher(enrichment=_make_enrichment())
        repo = FakeQualificationRepository()
        queue = FakeOutreachQueue()
        missing_field = ClaudeResponse(
            text=json.dumps(
                {
                    "score": 75,
                    "rationale": "No mobile site, slow load.",
                    "top_weakness": "no_mobile",
                }
            ),
            cost_usd=HAIKU_COST,
            model=HAIKU_MODEL,
        )
        client = FakeClaudeClient(responses=[missing_field, missing_field])

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
        "has_actionable_weakness": True,
    }

    result = _parse_and_validate(json.dumps(data), _HAIKU_SCHEMA)

    assert result == data


def test_top_weakness_em_dash_is_normalised_on_persist() -> None:
    async def scenario() -> None:
        repo = FakeQualificationRepository()
        haiku = ClaudeResponse(
            text=json.dumps(
                {
                    "score": 30,
                    "rationale": "Weak site overall—worth flagging.",
                    "top_weakness": "Missing H1 tag on homepage—hurts SEO",
                    "has_actionable_weakness": True,
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
        assert q["top_weakness"] == "Missing H1 tag on homepage,hurts SEO"
        assert q["rationale"] == "Weak site overall,worth flagging."

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
                    "has_actionable_weakness": True,
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
        assert q["top_weakness"] == "Website load time is 5.5 seconds , slower than ideal"

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
        assert q["subject_line"] == "Stone Builders,your site's costing you jobs"
        assert q["personalised_opener"] == "Brett, your site loads slow , that's costing quotes."
        assert q["followup_1"] == "Quick fix available,want a look?"
        assert q["followup_2"] == "Last nudge , offer's open if timing works."
        for field_name in ("subject_line", "personalised_opener", "followup_1", "followup_2"):
            assert "—" not in q[field_name]
            assert "–" not in q[field_name]

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
        assert conn.args[0][0] == LEAD_ID
        assert conn.args[0][1] == TENANT_ID

    asyncio.run(scenario())

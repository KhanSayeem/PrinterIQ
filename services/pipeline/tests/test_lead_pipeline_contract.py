from __future__ import annotations

import asyncio
import csv
import json
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from uuid import UUID

from pipeline_queue.definitions import JobType
from workers.enrich import enrich_lead
from workers.generate_preview import select_template_key
from workers.ingest import ingest_csv_file
from workers.qualify import ClaudeResponse, qualify_lead

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
LEAD_ID = UUID("20000000-0000-0000-0000-000000000001")
ENRICHMENT_ID = UUID("30000000-0000-0000-0000-000000000001")
QUALIFICATION_ID = UUID("40000000-0000-0000-0000-000000000001")


@dataclass
class FakeLeadStore:
    lead: dict[str, object] | None = None
    email_checks: list[tuple[UUID, str]] = field(default_factory=list)

    async def email_exists(self, *, tenant_id: UUID, email: str) -> bool:
        self.email_checks.append((tenant_id, email))
        return False

    async def insert_lead(self, lead: dict[str, object]) -> UUID:
        self.lead = {**lead, "id": LEAD_ID}
        return LEAD_ID

    async def get_lead(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        if tenant_id != TENANT_ID or lead_id != LEAD_ID or self.lead is None:
            raise AssertionError("unexpected lead fetch")
        return self.lead


@dataclass
class RecordingQueue:
    jobs: list[dict[str, object]] = field(default_factory=list)

    async def enqueue(self, payload: dict[str, object]) -> None:
        self.jobs.append(payload)


@dataclass
class FakeEnrichmentStore:
    enrichment: dict[str, object] | None = None
    status_updates: list[tuple[UUID, UUID, str]] = field(default_factory=list)

    async def insert_enrichment(self, enrichment: dict[str, object]) -> UUID:
        self.enrichment = {**enrichment, "id": ENRICHMENT_ID}
        return ENRICHMENT_ID

    async def update_lead_status(self, *, tenant_id: UUID, lead_id: UUID, status: str) -> None:
        self.status_updates.append((tenant_id, lead_id, status))

    async def get_enrichment(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        if tenant_id != TENANT_ID or lead_id != LEAD_ID or self.enrichment is None:
            raise AssertionError("unexpected enrichment fetch")
        return self.enrichment


@dataclass
class FakeQualificationStore:
    inserted: list[dict[str, object]] = field(default_factory=list)
    status_updates: list[tuple[UUID, UUID, str]] = field(default_factory=list)

    async def insert_qualification(self, q: dict[str, object]) -> UUID:
        self.inserted.append(q)
        return QUALIFICATION_ID

    async def update_lead_status(self, *, tenant_id: UUID, lead_id: UUID, status: str) -> None:
        self.status_updates.append((tenant_id, lead_id, status))


@dataclass
class StubAuditor:
    """CHANGE 2c: the Playwright audit now runs for every lead, including
    ones with Apollo `technologies` data, so this contract test needs a
    working auditor stub rather than one that asserts it is never called."""

    calls: list[str] = field(default_factory=list)

    async def audit(self, url: str) -> dict[str, object]:
        self.calls.append(url)
        return {
            "has_site": True,
            "is_reachable": True,
            "is_mobile_friendly": False,
            "has_ssl": True,
            "has_meta_title": True,
            "has_meta_description": True,
            "has_h1": True,
            "load_ms": 2100,
            "cms_detected": "WordPress",
            "lighthouse_mobile_score": None,
            "weaknesses": ["no_mobile"],
            "raw_audit": {"url": url, "status": 200},
        }


@dataclass
class FakeClaudeClient:
    calls: list[tuple[str, dict[str, str]]] = field(default_factory=list)

    async def call(self, prompt_name: str, variables: dict[str, str]) -> ClaudeResponse:
        self.calls.append((prompt_name, variables))
        return ClaudeResponse(
            text=json.dumps(
                {
                    "score": 54,
                    "rationale": "Below the configured threshold.",
                    "top_weakness": "no_mobile",
                    "weakness_label": "no_mobile",
                }
            ),
            cost_usd=Decimal("0.000100"),
            model="claude-haiku-test",
        )


def test_apollo_csv_pipeline_preserves_score_threshold_to_qualification(tmp_path: Path) -> None:
    async def scenario() -> None:
        csv_path = _write_apollo_csv(tmp_path)
        lead_store = FakeLeadStore()
        enrich_queue = RecordingQueue()

        summary = await ingest_csv_file(
            csv_path,
            tenant_id=TENANT_ID,
            source_file="apollo.csv",
            vertical="tradies",
            score_threshold=55,
            lead_repository=lead_store,
            queue=enrich_queue,
        )

        assert summary.inserted_rows == 1
        assert enrich_queue.jobs == [
            {
                "job_type": JobType.ENRICH_LEAD.value,
                "tenant_id": str(TENANT_ID),
                "lead_id": str(LEAD_ID),
                "score_threshold": 55,
            }
        ]

        enrichment_store = FakeEnrichmentStore()
        qualify_queue = RecordingQueue()
        auditor = StubAuditor()
        await enrich_lead(
            enrich_queue.jobs[0],
            lead_fetcher=lead_store,
            enrichment_repo=enrichment_store,
            qualify_queue=qualify_queue,
            auditor=auditor,
        )

        assert auditor.calls == ["https://stone.example.com"]

        assert qualify_queue.jobs == [
            {
                "job_type": JobType.QUALIFY_LEAD.value,
                "tenant_id": str(TENANT_ID),
                "lead_id": str(LEAD_ID),
                "score_threshold": 55,
            }
        ]

        qualification_store = FakeQualificationStore()
        outreach_queue = RecordingQueue()
        claude_client = FakeClaudeClient()
        await qualify_lead(
            qualify_queue.jobs[0],
            lead_fetcher=lead_store,
            enrichment_fetcher=enrichment_store,
            qualification_repo=qualification_store,
            outreach_queue=outreach_queue,
            claude_client=claude_client,
        )

        assert qualification_store.inserted[0]["score"] == 54
        assert qualification_store.status_updates == [(TENANT_ID, LEAD_ID, "archived")]
        assert outreach_queue.jobs == []
        assert [call[0] for call in claude_client.calls] == ["qualify-v2"]

    asyncio.run(scenario())


def _write_apollo_csv(tmp_path: Path) -> Path:
    path = tmp_path / "apollo.csv"
    fieldnames = [
        "First Name",
        "Last Name",
        "Email",
        "Email Status",
        "Mobile Phone",
        "Corporate Phone",
        "Company Name",
        "Website",
        "City",
        "State",
        "Technologies",
        "Apollo Contact Id",
        "Apollo Account Id",
        "Keywords",
        "Industry",
    ]
    row = {
        "First Name": "Avery",
        "Last Name": "Stone",
        "Email": "avery@example.com",
        "Email Status": "verified",
        "Mobile Phone": "+61400000000",
        "Corporate Phone": "",
        "Company Name": "Stone Plumbing",
        "Website": "https://stone.example.com",
        "City": "Sydney",
        "State": "NSW",
        "Technologies": "WordPress, SSL, Mobile Friendly",
        "Apollo Contact Id": "contact-1",
        "Apollo Account Id": "account-1",
        "Keywords": "plumber",
        "Industry": "Construction",
    }
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerow(row)
    return path


# ---------------------------------------------------------------------------
# The whole point of this branch, end to end through the real workers
# ---------------------------------------------------------------------------


@dataclass
class ExplodingAuditor:
    calls: list[str] = field(default_factory=list)

    async def audit(self, url: str) -> dict[str, object]:
        self.calls.append(url)
        raise AssertionError(f"no browser should launch for a lead with no website: {url!r}")


@dataclass
class NoSiteClaudeClient:
    """Haiku scores, then Sonnet writes copy. Both grounded in no_website."""

    calls: list[tuple[str, dict[str, str]]] = field(default_factory=list)

    async def call(self, prompt_name: str, variables: dict[str, str]) -> ClaudeResponse:
        self.calls.append((prompt_name, variables))
        if prompt_name.startswith("qualify"):
            text = json.dumps(
                {
                    "score": 72,
                    "rationale": (
                        "Opportunity 45 (no website at all), contactability 15, "
                        "dependence 12, live 10."
                    ),
                    "top_weakness": "no website at all",
                    "weakness_label": "no_website",
                }
            )
        else:
            text = json.dumps(
                {
                    "subject_line": "Nothing online for Brunswick Beans?",
                    "opener": "Went looking for Brunswick Beans and found nothing.",
                    "followup_1": "Happy to walk you through it.",
                    "followup_2": "Last nudge from me.",
                    "weakness_sentence": (
                        "there's no website for them anywhere I could find, so anyone "
                        "searching lands on a competitor"
                    ),
                }
            )
        return ClaudeResponse(
            text=text, cost_usd=Decimal("0.000100"), model="claude-test"
        )


def test_underscore_csv_no_website_non_trade_lead_survives_the_whole_pipeline(
    tmp_path: Path, monkeypatch
) -> None:
    """One cafe, no website, no phone, underscore headers, an OpenStreetMap
    industry tag.

    Before this branch this row died four separate times: rejected at ingest
    for unrecognised column names, rejected again for a blank Website and a
    blank phone, recorded by the auditor as a site that would not load, and
    archived in qualify for an empty weaknesses array. Every one of those has
    to be fixed for the row to reach outreach, so a unit test on any single
    stage cannot tell you whether the lead actually gets through.
    """

    async def scenario() -> None:
        monkeypatch.setenv("INSTANTLY_CAMPAIGN_ID", "campaign-default")
        monkeypatch.setenv("INSTANTLY_NO_WEBSITE_CAMPAIGN_ID", "campaign-nosite")

        csv_path = _write_underscore_csv(tmp_path)
        lead_store = FakeLeadStore()
        enrich_queue = RecordingQueue()

        summary = await ingest_csv_file(
            csv_path,
            tenant_id=TENANT_ID,
            source_file="au-slice.csv",
            vertical="tradies",
            score_threshold=35,
            lead_repository=lead_store,
            queue=enrich_queue,
        )

        assert summary.inserted_rows == 1
        assert summary.rejected_rows == 0
        assert lead_store.lead is not None
        assert lead_store.lead["website_url"] == ""
        assert lead_store.lead["phone"] == ""
        # amenity=cafe, normalised at ingest, is what reaches the scoring prompt.
        assert lead_store.lead["industry"] == "Cafe"

        enrichment_store = FakeEnrichmentStore()
        qualify_queue = RecordingQueue()
        auditor = ExplodingAuditor()
        await enrich_lead(
            enrich_queue.jobs[0],
            lead_fetcher=lead_store,
            enrichment_repo=enrichment_store,
            qualify_queue=qualify_queue,
            auditor=auditor,
        )

        assert auditor.calls == []
        assert enrichment_store.enrichment is not None
        assert enrichment_store.enrichment["has_site"] is False
        assert enrichment_store.enrichment["weaknesses"] == ["no_website"]
        assert enrichment_store.status_updates == [(TENANT_ID, LEAD_ID, "enriched")]

        qualification_store = FakeQualificationStore()
        outreach_queue = RecordingQueue()
        claude_client = NoSiteClaudeClient()
        await qualify_lead(
            qualify_queue.jobs[0],
            lead_fetcher=lead_store,
            enrichment_fetcher=enrichment_store,
            qualification_repo=qualification_store,
            outreach_queue=outreach_queue,
            claude_client=claude_client,
        )

        assert qualification_store.status_updates == [(TENANT_ID, LEAD_ID, "qualified")]
        assert qualification_store.inserted[0]["has_actionable_weakness"] is True
        assert qualification_store.inserted[0]["prompt_version"] == "opener-nosite-v1"
        assert [call[0] for call in claude_client.calls] == [
            "qualify-v2",
            "opener-nosite-v1",
        ]

        assert len(outreach_queue.jobs) == 1
        assert outreach_queue.jobs[0]["job_type"] == JobType.GENERATE_PREVIEW.value
        assert outreach_queue.jobs[0]["campaign_id"] == "campaign-nosite"

        # And the demo page this lead would receive is not a trades site.
        assert select_template_key(lead_store.lead) == "business"

    asyncio.run(scenario())


def _write_underscore_csv(tmp_path: Path) -> Path:
    """A row shaped exactly like the 900k Australian consolidated export."""
    path = tmp_path / "au-slice.csv"
    fieldnames = [
        "Full_Name",
        "First_Name",
        "Last_Name",
        "Company_Name",
        "Industry",
        "Email",
        "Email_Status",
        "Phone",
        "Mobile",
        "Website",
        "City",
        "State",
        "Country",
        "Keywords",
    ]
    row = {
        "Full_Name": "",
        "First_Name": "",
        "Last_Name": "",
        "Company_Name": "Brunswick Beans",
        "Industry": "amenity=cafe",
        "Email": "hello@brunswickbeans.example",
        "Email_Status": "Verified",
        "Phone": "",
        "Mobile": "",
        "Website": "",
        "City": "Brunswick",
        "State": "VIC",
        "Country": "Australia",
        "Keywords": "coffee",
    }
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerow(row)
    return path

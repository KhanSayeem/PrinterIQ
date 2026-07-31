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


class UnexpectedAuditor:
    async def audit(self, url: str) -> dict[str, object]:
        raise AssertionError(f"unexpected website audit for {url}")


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
                    "subject_line": "Subject",
                    "opener": "Opener",
                    "followup_1": "Follow 1",
                    "followup_2": "Follow 2",
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
        await enrich_lead(
            enrich_queue.jobs[0],
            lead_fetcher=lead_store,
            enrichment_repo=enrichment_store,
            qualify_queue=qualify_queue,
            auditor=UnexpectedAuditor(),
        )

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
        assert [call[0] for call in claude_client.calls] == ["qualify-v1"]

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

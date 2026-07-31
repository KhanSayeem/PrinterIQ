from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from uuid import UUID

from db.queries import (
    EnrichmentInsert,
    get_lead_by_id,
    insert_enrichment,
    update_lead_status,
)
from pipeline_queue.definitions import JobType
from workers.enrich import enrich_lead

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
LEAD_ID = UUID("20000000-0000-0000-0000-000000000001")


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


@dataclass
class FakeLeadFetcher:
    lead: dict[str, object]
    calls: list[tuple[UUID, UUID]] = field(default_factory=list)

    async def get_lead(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        self.calls.append((tenant_id, lead_id))
        return self.lead


@dataclass
class FakeEnrichmentRepository:
    inserted: list[dict[str, object]] = field(default_factory=list)
    status_updates: list[tuple[UUID, UUID, str]] = field(default_factory=list)

    async def insert_enrichment(self, enrichment: dict[str, object]) -> UUID:
        self.inserted.append(enrichment)
        return UUID(f"30000000-0000-0000-0000-{len(self.inserted):012d}")

    async def update_lead_status(self, *, tenant_id: UUID, lead_id: UUID, status: str) -> None:
        self.status_updates.append((tenant_id, lead_id, status))


@dataclass
class FakeQualifyQueue:
    jobs: list[dict[str, object]] = field(default_factory=list)

    async def enqueue(self, payload: dict[str, object]) -> None:
        self.jobs.append(payload)


@dataclass
class FakeAuditor:
    result: dict[str, object]
    calls: list[str] = field(default_factory=list)

    async def audit(self, url: str) -> dict[str, object]:
        self.calls.append(url)
        return self.result


class RecordingConnection:
    def __init__(self, *, fetchval_result: object) -> None:
        self.fetchval_result = fetchval_result
        self.queries: list[str] = []
        self.args: list[tuple[object, ...]] = []

    async def fetchval(self, query: str, *args: object) -> object:
        self.queries.append(query)
        self.args.append(args)
        return self.fetchval_result

    async def execute(self, query: str, *args: object) -> object:
        self.queries.append(query)
        self.args.append(args)
        return "UPDATE 1"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_lead(
    *,
    technologies: str = "",
    website_url: str = "https://example.com",
) -> dict[str, object]:
    return {
        "id": LEAD_ID,
        "tenant_id": TENANT_ID,
        "technologies": technologies,
        "website_url": website_url,
        "status": "imported",
    }


def _playwright_audit_result(*, is_reachable: bool = True) -> dict[str, object]:
    if not is_reachable:
        return {
            "has_site": True,
            "is_reachable": False,
            "is_mobile_friendly": None,
            "has_ssl": None,
            "has_meta_title": None,
            "has_meta_description": None,
            "has_h1": None,
            "load_ms": None,
            "cms_detected": None,
            "lighthouse_mobile_score": None,
            "weaknesses": [],
            "raw_audit": {},
        }
    return {
        "has_site": True,
        "is_reachable": True,
        "is_mobile_friendly": False,
        "has_ssl": True,
        "has_meta_title": True,
        "has_meta_description": False,
        "has_h1": True,
        "load_ms": 4200,
        "cms_detected": "WordPress",
        "lighthouse_mobile_score": None,
        "weaknesses": ["no_mobile", "no_meta_description"],
        "raw_audit": {},
    }


def _payload() -> dict[str, object]:
    return {
        "job_type": JobType.ENRICH_LEAD.value,
        "tenant_id": str(TENANT_ID),
        "lead_id": str(LEAD_ID),
        "score_threshold": 40,
    }


# ---------------------------------------------------------------------------
# Enrich worker tests
# ---------------------------------------------------------------------------


def test_apollo_present_path_uses_apollo_tech_source_and_skips_playwright() -> None:
    async def scenario() -> None:
        lead = _make_lead(technologies="WordPress, Mobile Friendly, Google Analytics")
        fetcher = FakeLeadFetcher(lead=lead)
        repo = FakeEnrichmentRepository()
        queue = FakeQualifyQueue()
        auditor = FakeAuditor(result={})

        await enrich_lead(
            _payload(),
            lead_fetcher=fetcher,
            enrichment_repo=repo,
            qualify_queue=queue,
            auditor=auditor,
        )

        assert len(repo.inserted) == 1
        enrichment = repo.inserted[0]
        assert enrichment["tech_source"] == "apollo"
        assert auditor.calls == []
        assert enrichment["tenant_id"] == TENANT_ID
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "enriched")]
        assert len(queue.jobs) == 1
        assert queue.jobs[0]["job_type"] == JobType.QUALIFY_LEAD.value
        assert queue.jobs[0]["score_threshold"] == 40

    asyncio.run(scenario())


def test_playwright_only_path_uses_playwright_tech_source_and_calls_auditor() -> None:
    async def scenario() -> None:
        lead = _make_lead(technologies="")
        fetcher = FakeLeadFetcher(lead=lead)
        repo = FakeEnrichmentRepository()
        queue = FakeQualifyQueue()
        auditor = FakeAuditor(result=_playwright_audit_result())

        await enrich_lead(
            _payload(),
            lead_fetcher=fetcher,
            enrichment_repo=repo,
            qualify_queue=queue,
            auditor=auditor,
        )

        assert len(repo.inserted) == 1
        enrichment = repo.inserted[0]
        assert enrichment["tech_source"] == "playwright"
        assert auditor.calls == ["https://example.com"]
        assert enrichment["tenant_id"] == TENANT_ID
        assert enrichment["is_reachable"] is True
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "enriched")]
        assert len(queue.jobs) == 1
        assert queue.jobs[0]["job_type"] == JobType.QUALIFY_LEAD.value

    asyncio.run(scenario())


def test_unreachable_website_still_writes_enrichment_and_enqueues_qualify() -> None:
    async def scenario() -> None:
        lead = _make_lead(technologies="")
        fetcher = FakeLeadFetcher(lead=lead)
        repo = FakeEnrichmentRepository()
        queue = FakeQualifyQueue()
        auditor = FakeAuditor(result=_playwright_audit_result(is_reachable=False))

        await enrich_lead(
            _payload(),
            lead_fetcher=fetcher,
            enrichment_repo=repo,
            qualify_queue=queue,
            auditor=auditor,
        )

        assert len(repo.inserted) == 1
        enrichment = repo.inserted[0]
        assert enrichment["is_reachable"] is False
        assert enrichment["tech_source"] == "playwright"
        assert enrichment["tenant_id"] == TENANT_ID
        assert repo.status_updates == [(TENANT_ID, LEAD_ID, "enriched")]
        assert len(queue.jobs) == 1
        assert queue.jobs[0]["job_type"] == JobType.QUALIFY_LEAD.value

    asyncio.run(scenario())


def test_tenant_id_present_on_every_written_enrichment_row() -> None:
    async def scenario() -> None:
        for technologies in ("WordPress", ""):
            lead = _make_lead(technologies=technologies)
            fetcher = FakeLeadFetcher(lead=lead)
            repo = FakeEnrichmentRepository()
            queue = FakeQualifyQueue()
            auditor = FakeAuditor(result=_playwright_audit_result())

            await enrich_lead(
                _payload(),
                lead_fetcher=fetcher,
                enrichment_repo=repo,
                qualify_queue=queue,
                auditor=auditor,
            )

            assert repo.inserted[0]["tenant_id"] == TENANT_ID

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# DB query tests
# ---------------------------------------------------------------------------


def test_get_lead_by_id_is_tenant_scoped() -> None:
    async def scenario() -> None:
        expected = {"id": LEAD_ID, "tenant_id": TENANT_ID, "technologies": "WordPress"}

        class _Conn(RecordingConnection):
            async def fetchrow(self, query: str, *args: object) -> object:
                self.queries.append(query)
                self.args.append(args)
                return expected

        conn = _Conn(fetchval_result=None)
        result = await get_lead_by_id(conn, tenant_id=TENANT_ID, lead_id=LEAD_ID)

        assert "tenant_id = $1" in conn.queries[0]
        assert "id = $2" in conn.queries[0]
        assert conn.args[0] == (TENANT_ID, LEAD_ID)
        assert result == expected

    asyncio.run(scenario())


def test_insert_enrichment_writes_tenant_scoped_row() -> None:
    async def scenario() -> None:
        enrichment_id = UUID("30000000-0000-0000-0000-000000000001")
        connection = RecordingConnection(fetchval_result=enrichment_id)

        inserted_id = await insert_enrichment(
            connection,
            EnrichmentInsert(
                lead_id=LEAD_ID,
                tenant_id=TENANT_ID,
                has_site=True,
                is_reachable=True,
                is_mobile_friendly=False,
                has_ssl=True,
                has_meta_title=True,
                has_meta_description=False,
                has_h1=True,
                load_ms=4200,
                lighthouse_mobile_score=None,
                cms_detected="WordPress",
                tech_source="playwright",
                weaknesses=["no_mobile"],
                raw_audit={},
            ),
        )

        assert inserted_id == enrichment_id
        q = connection.queries[0]
        assert "INSERT INTO enrichments" in q
        assert "SELECT" in q
        assert "FROM leads" in q
        assert "WHERE id = $1" in q
        assert "tenant_id = $2" in q
        assert "ON CONFLICT (lead_id) DO UPDATE" in q
        assert "enrichments.tenant_id = EXCLUDED.tenant_id" in q
        assert "tenant_id" in q
        assert "tech_source" in q
        assert connection.args[0][0] == LEAD_ID
        assert connection.args[0][1] == TENANT_ID

    asyncio.run(scenario())


def test_update_lead_status_is_tenant_scoped() -> None:
    async def scenario() -> None:
        connection = RecordingConnection(fetchval_result=None)

        await update_lead_status(
            connection,
            tenant_id=TENANT_ID,
            lead_id=LEAD_ID,
            status="enriched",
        )

        q = connection.queries[0]
        assert "UPDATE leads" in q
        assert "tenant_id = $" in q
        assert "id = $" in q
        assert "status IN ('imported')" in q
        assert "enriched" in connection.args[0]

    asyncio.run(scenario())

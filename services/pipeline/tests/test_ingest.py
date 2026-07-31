from __future__ import annotations

import asyncio
import csv
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import cast
from uuid import UUID

import pytest

from db.queries import LeadInsert, insert_lead, lead_email_exists
from pipeline_queue.definitions import JobType
from workers.ingest import ingest_csv_file, parse_ingest_args

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")


@dataclass(frozen=True)
class RecordedLead:
    tenant_id: UUID
    email: str
    status: str
    source_file: str
    vertical: str


class FakeLeadRepository:
    def __init__(self, *, existing_emails: set[str] | None = None) -> None:
        self.existing_emails = existing_emails or set()
        self.inserted: list[RecordedLead] = []
        self.email_checks: list[tuple[UUID, str]] = []

    async def email_exists(self, *, tenant_id: UUID, email: str) -> bool:
        self.email_checks.append((tenant_id, email))
        return email in self.existing_emails

    async def insert_lead(self, lead: dict[str, object]) -> UUID:
        self.inserted.append(
            RecordedLead(
                tenant_id=cast(UUID, lead["tenant_id"]),
                email=cast(str, lead["email"]),
                status=cast(str, lead["status"]),
                source_file=cast(str, lead["source_file"]),
                vertical=cast(str, lead["vertical"]),
            )
        )
        return UUID(f"20000000-0000-0000-0000-{len(self.inserted):012d}")


class FakeQueue:
    def __init__(self) -> None:
        self.jobs: list[dict[str, object]] = []

    async def enqueue(self, payload: dict[str, object]) -> None:
        self.jobs.append(payload)


class RecordingConnection:
    def __init__(self, *, fetchval_result: object) -> None:
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


def test_lead_email_lookup_is_tenant_scoped() -> None:
    async def scenario() -> None:
        connection = RecordingConnection(fetchval_result=True)

        exists = await lead_email_exists(
            connection,
            tenant_id=TENANT_ID,
            email="lead@example.com",
        )

        assert exists is True
        assert "tenant_id = $1" in connection.queries[0]
        assert "LOWER(email) = LOWER($2)" in connection.queries[0]
        assert "is_deleted = FALSE" in connection.queries[0]
        assert connection.args[0] == (TENANT_ID, "lead@example.com")

    asyncio.run(scenario())


def test_insert_lead_writes_tenant_scoped_imported_row() -> None:
    async def scenario() -> None:
        lead_id = UUID("20000000-0000-0000-0000-000000000001")
        connection = RecordingConnection(fetchval_result=lead_id)

        inserted_id = await insert_lead(
            connection,
            LeadInsert(
                tenant_id=TENANT_ID,
                first_name="Darren",
                last_name="Smith",
                email="darren@example.com",
                email_status="verified",
                phone="+61400000000",
                business_name="Aqua Options",
                city="Sydney",
                state="NSW",
                country="Australia",
                website_url="https://aqua.example.com",
                industry="Construction",
                keywords="plumber",
                technologies="WordPress",
                apollo_contact_id="contact-1",
                apollo_account_id="account-1",
                source_file="apollo.csv",
                vertical="tradies",
                status="imported",
            ),
        )

        assert inserted_id == lead_id
        insert_query = connection.queries[0]
        assert "INSERT INTO leads" in insert_query
        assert "tenant_id" in insert_query
        assert "status" in insert_query
        assert connection.args[0][0] == TENANT_ID
        assert connection.args[0][-1] == "imported"

    asyncio.run(scenario())


def test_cli_parser_accepts_file_and_dry_run_flag() -> None:
    args = parse_ingest_args(["--file", "uploads/apollo.csv", "--dry-run"])

    assert args.file == Path("uploads/apollo.csv")
    assert args.dry_run is True


def test_valid_apollo_csv_inserts_imported_leads_and_enqueues_enrichment(tmp_path: Path) -> None:
    async def scenario() -> None:
        csv_path = _write_apollo_csv(tmp_path, row_count=10)
        repository = FakeLeadRepository()
        queue = FakeQueue()

        summary = await ingest_csv_file(
            csv_path,
            tenant_id=TENANT_ID,
            source_file="apollo.csv",
            vertical="tradies",
            score_threshold=40,
            lead_repository=repository,
            queue=queue,
        )

        assert summary.total_rows == 10
        assert summary.inserted_rows == 10
        assert summary.enqueued_jobs == 10
        assert summary.rejected_rows == 0
        assert all(lead.tenant_id == TENANT_ID for lead in repository.inserted)
        assert all(lead.status == "imported" for lead in repository.inserted)
        assert all(lead.source_file == "apollo.csv" for lead in repository.inserted)
        assert all(lead.vertical == "tradies" for lead in repository.inserted)
        assert [job["job_type"] for job in queue.jobs] == [JobType.ENRICH_LEAD.value] * 10
        assert all(job["tenant_id"] == str(TENANT_ID) for job in queue.jobs)
        assert all(job["score_threshold"] == 40 for job in queue.jobs)

    asyncio.run(scenario())


def test_existing_email_is_skipped_without_insert_or_enrichment_job(tmp_path: Path) -> None:
    async def scenario() -> None:
        csv_path = _write_apollo_csv(tmp_path, row_count=1)
        repository = FakeLeadRepository(existing_emails={"lead0@example.com"})
        queue = FakeQueue()

        summary = await ingest_csv_file(
            csv_path,
            tenant_id=TENANT_ID,
            source_file="apollo.csv",
            vertical="tradies",
            score_threshold=40,
            lead_repository=repository,
            queue=queue,
        )

        assert summary.total_rows == 1
        assert summary.inserted_rows == 0
        assert summary.skipped_duplicates == 1
        assert repository.inserted == []
        assert queue.jobs == []
        assert repository.email_checks == [(TENANT_ID, "lead0@example.com")]

    asyncio.run(scenario())


def test_missing_required_email_is_rejected_without_crashing(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def scenario() -> None:
        csv_path = _write_apollo_csv(tmp_path, row_count=1, row_overrides={0: {"Email": ""}})
        repository = FakeLeadRepository()
        queue = FakeQueue()

        caplog.set_level(logging.WARNING)
        summary = await ingest_csv_file(
            csv_path,
            tenant_id=TENANT_ID,
            source_file="apollo.csv",
            vertical="tradies",
            score_threshold=40,
            lead_repository=repository,
            queue=queue,
        )

        assert summary.total_rows == 1
        assert summary.inserted_rows == 0
        assert summary.rejected_rows == 1
        assert repository.inserted == []
        assert queue.jobs == []
        assert "Rejected Apollo CSV row 1" in caplog.text
        assert "Email" in caplog.text

    asyncio.run(scenario())


def test_dry_run_reports_valid_rows_without_db_writes_or_jobs(tmp_path: Path) -> None:
    async def scenario() -> None:
        csv_path = _write_apollo_csv(tmp_path, row_count=2)
        repository = FakeLeadRepository()
        queue = FakeQueue()

        summary = await ingest_csv_file(
            csv_path,
            tenant_id=TENANT_ID,
            source_file="apollo.csv",
            vertical="tradies",
            score_threshold=40,
            lead_repository=repository,
            queue=queue,
            dry_run=True,
        )

        assert summary.total_rows == 2
        assert summary.inserted_rows == 0
        assert summary.rejected_rows == 0
        assert repository.inserted == []
        assert queue.jobs == []

    asyncio.run(scenario())


def _write_apollo_csv(
    tmp_path: Path,
    *,
    row_count: int,
    row_overrides: dict[int, dict[str, str]] | None = None,
) -> Path:
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
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for index in range(row_count):
            writer.writerow(_apollo_row(index, **(row_overrides or {}).get(index, {})))
    return path


def _apollo_row(index: int, **overrides: str) -> dict[str, str]:
    row: dict[str, str] = {
        "First Name": f"First{index}",
        "Last Name": f"Last{index}",
        "Email": f"lead{index}@example.com",
        "Email Status": "verified",
        "Mobile Phone": f"+61400000{index:03d}",
        "Corporate Phone": "",
        "Company Name": f"Trade Co {index}",
        "Website": f"https://trade{index}.example.com",
        "City": "Sydney",
        "State": "NSW",
        "Technologies": "WordPress, Mobile Friendly",
        "Apollo Contact Id": f"contact-{index}",
        "Apollo Account Id": f"account-{index}",
        "Keywords": "plumber",
        "Industry": "Construction",
    }
    row.update(overrides)
    return row

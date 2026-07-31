from __future__ import annotations

import csv
import logging
from argparse import ArgumentParser, Namespace
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from uuid import UUID

from pipeline_queue.definitions import JobType

logger = logging.getLogger(__name__)


class LeadRepository(Protocol):
    async def email_exists(self, *, tenant_id: UUID, email: str) -> bool:
        """Return whether a tenant already has a lead with this email."""

    async def insert_lead(self, lead: dict[str, object]) -> UUID:
        """Insert one lead and return its id."""


class EnrichmentQueue(Protocol):
    async def enqueue(self, payload: dict[str, object]) -> None:
        """Enqueue one downstream queue payload."""


@dataclass(frozen=True)
class IngestSummary:
    total_rows: int = 0
    inserted_rows: int = 0
    skipped_duplicates: int = 0
    rejected_rows: int = 0
    enqueued_jobs: int = 0


def parse_ingest_args(argv: Sequence[str] | None = None) -> Namespace:
    parser = ArgumentParser(description="Import Apollo CSV leads into PrinterIQ")
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


async def ingest_csv_file(
    file_path: Path,
    *,
    tenant_id: UUID,
    source_file: str,
    vertical: str,
    score_threshold: int,
    lead_repository: LeadRepository,
    queue: EnrichmentQueue,
    dry_run: bool = False,
) -> IngestSummary:
    total_rows = 0
    inserted_rows = 0
    skipped_duplicates = 0
    rejected_rows = 0
    enqueued_jobs = 0

    with file_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            total_rows += 1
            missing_fields = _missing_required_fields(row)
            if missing_fields:
                logger.warning(
                    "Rejected Apollo CSV row %s from %s: missing %s",
                    total_rows,
                    source_file,
                    ", ".join(missing_fields),
                )
                rejected_rows += 1
                continue
            lead = _lead_from_apollo_row(
                row,
                tenant_id=tenant_id,
                source_file=source_file,
                vertical=vertical,
            )
            email = str(lead["email"])
            if await lead_repository.email_exists(tenant_id=tenant_id, email=email):
                skipped_duplicates += 1
                continue
            if dry_run:
                continue
            lead_id = await lead_repository.insert_lead(lead)
            inserted_rows += 1
            await queue.enqueue(
                {
                    "job_type": JobType.ENRICH_LEAD.value,
                    "tenant_id": str(tenant_id),
                    "lead_id": str(lead_id),
                    "score_threshold": score_threshold,
                }
            )
            enqueued_jobs += 1

    return IngestSummary(
        total_rows=total_rows,
        inserted_rows=inserted_rows,
        skipped_duplicates=skipped_duplicates,
        rejected_rows=rejected_rows,
        enqueued_jobs=enqueued_jobs,
    )


def _missing_required_fields(row: Mapping[str, str]) -> list[str]:
    phone = (row.get("Mobile Phone") or row.get("Corporate Phone") or "").strip()
    required_values = {
        "Email": row.get("Email", ""),
        "Company Name": row.get("Company Name", ""),
        "Website": row.get("Website", ""),
        "State": row.get("State", ""),
        "Industry": row.get("Industry", ""),
        "Mobile Phone or Corporate Phone": phone,
    }
    return [field for field, value in required_values.items() if not value.strip()]


def _lead_from_apollo_row(
    row: Mapping[str, str],
    *,
    tenant_id: UUID,
    source_file: str,
    vertical: str,
) -> dict[str, object]:
    return {
        "tenant_id": tenant_id,
        "first_name": row.get("First Name", ""),
        "last_name": row.get("Last Name", ""),
        "email": row.get("Email", "").strip().lower(),
        "email_status": row.get("Email Status", "unverified"),
        "phone": row.get("Mobile Phone") or row.get("Corporate Phone") or "",
        "business_name": row.get("Company Name", ""),
        "city": row.get("City", ""),
        "state": row.get("State", ""),
        "country": "Australia",
        "website_url": row.get("Website", ""),
        "industry": row.get("Industry", ""),
        "keywords": row.get("Keywords", ""),
        "technologies": row.get("Technologies", ""),
        "apollo_contact_id": row.get("Apollo Contact Id", ""),
        "apollo_account_id": row.get("Apollo Account Id", ""),
        "source_file": source_file,
        "vertical": vertical,
        "status": "imported",
    }

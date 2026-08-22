from __future__ import annotations

import csv
import logging
import re
from argparse import ArgumentParser, Namespace
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol
from uuid import UUID

from pipeline_queue.definitions import JobType

logger = logging.getLogger(__name__)

# Header lookup is normalised rather than matched literally. The Apollo export
# spells its columns "Company Name" and "Mobile Phone"; the 900k Australian
# consolidated export spells the same things "Company_Name", "Mobile" and
# "Phone". Matching literally meant every row of the second file was rejected
# for missing required fields, and the failure looked like a data problem
# rather than a mapping one. Folding case and separators means a third naming
# style costs nothing.
_HEADER_NOISE_RE = re.compile(r"[^a-z0-9]+")

# Ordered aliases per canonical field: the first alias that carries a value
# wins. Order is meaningful for `phone`, where a mobile is preferred over a
# landline exactly as the Apollo-only code preferred "Mobile Phone" over
# "Corporate Phone".
_FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "first_name": ("first name",),
    "last_name": ("last name",),
    "email": ("email",),
    "email_status": ("email status",),
    "phone": ("mobile phone", "mobile", "corporate phone", "phone"),
    "business_name": ("company name", "business name"),
    "city": ("city", "company city"),
    "state": ("state",),
    "website": ("website",),
    "industry": ("industry",),
    "keywords": ("keywords",),
    "technologies": ("technologies",),
    "apollo_contact_id": ("apollo contact id",),
    "apollo_account_id": ("apollo account id",),
}

# An OpenStreetMap-style tag: a lower-case key, optionally namespaced with
# colons, then "=" or ":" and the value. Matching only lower-case keys is what
# keeps a curated label like "Retail: Grocery" out of this branch.
_OSM_TAG_RE = re.compile(r"^[a-z][a-z0-9_]*(?::[a-z0-9_]+)*\s*[=:]\s*(?P<value>.*)$")
_WHITESPACE_RE = re.compile(r"\s+")

# Values that mean "no value" while looking like one. "None" is a Python repr
# that leaked into the export.
_ABSENT_VALUES = frozenset({"", "none"})


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
    # Which required field was missing, and how often. A lump rejected_rows
    # count cannot distinguish "this column is absent from the file" from
    # "this column is genuinely sparse in the data", and those need opposite
    # responses. One row can be counted under several fields.
    rejected_by_field: dict[str, int] = field(default_factory=dict)


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
    rejected_by_field: dict[str, int] = {}

    with file_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            total_rows += 1
            values = _canonical_values(row)
            missing_fields = _missing_required_fields(values)
            if missing_fields:
                logger.warning(
                    "Rejected Apollo CSV row %s from %s: missing %s",
                    total_rows,
                    source_file,
                    ", ".join(missing_fields),
                )
                rejected_rows += 1
                for missing in missing_fields:
                    rejected_by_field[missing] = rejected_by_field.get(missing, 0) + 1
                continue
            lead = _lead_from_apollo_row(
                values,
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

    if rejected_by_field:
        logger.warning(
            "Ingest of %s rejected %s of %s rows; missing-field counts: %s",
            source_file,
            rejected_rows,
            total_rows,
            ", ".join(f"{name}={count}" for name, count in sorted(rejected_by_field.items())),
        )

    return IngestSummary(
        total_rows=total_rows,
        inserted_rows=inserted_rows,
        skipped_duplicates=skipped_duplicates,
        rejected_rows=rejected_rows,
        enqueued_jobs=enqueued_jobs,
        rejected_by_field=rejected_by_field,
    )


def _normalise_header(name: str) -> str:
    """Fold a CSV header to a comparison key.

    "Company Name", "Company_Name", "company-name" and "COMPANY NAME" all
    become "company name".
    """
    return _HEADER_NOISE_RE.sub(" ", name.lower()).strip()


def _canonical_values(row: Mapping[str, object]) -> dict[str, str]:
    """Resolve one CSV row into this worker's canonical field names.

    Returned once and used by both the required-field check and the lead
    mapping, so the two can never disagree about which column a field came
    from.
    """
    lookup: dict[str, str] = {}
    for raw_key, raw_value in row.items():
        if not isinstance(raw_key, str):
            # csv.DictReader collects surplus columns under a None key with a
            # list value. There is no header to alias them to.
            continue
        key = _normalise_header(raw_key)
        value = raw_value.strip() if isinstance(raw_value, str) else ""
        # First non-empty wins, so a duplicated header cannot blank a field.
        if value and not lookup.get(key):
            lookup[key] = value
        lookup.setdefault(key, "")

    values = {
        canonical: next((lookup.get(alias, "") for alias in aliases if lookup.get(alias)), "")
        for canonical, aliases in _FIELD_ALIASES.items()
    }
    values["industry"] = normalise_industry(values["industry"])
    return values


def normalise_industry(raw: str) -> str:
    """Turn a raw Industry cell into plain English, or into an empty string.

    The Australian slice mixes curated labels ("Finance & Accounting") with
    raw OpenStreetMap tags ("amenity=school", which alone appears 2,641
    times, and compound forms like "amenity=doctors; healthcare=doctor").
    That text is passed to the scoring prompt, where a raw tag is noise at
    best and misleading at worst.

    Deliberately shape-driven rather than a lookup table. A hand-written
    dictionary of OSM tags would run to thousands of entries, would be stale
    the day it was written, and would silently drop every tag nobody thought
    of. Only tags are rewritten; a curated label is returned untouched,
    because title-casing everything would turn "PR & Communications" into
    "Pr & Communications".
    """
    value = _WHITESPACE_RE.sub(" ", raw.strip())
    if value.casefold() in _ABSENT_VALUES:
        return ""

    # A compound tag lists the primary classification first.
    value = value.split(";")[0].strip()

    match = _OSM_TAG_RE.match(value)
    if match is None:
        return value

    tag_value = match.group("value").strip().replace("_", " ").replace("-", " ")
    tag_value = _WHITESPACE_RE.sub(" ", tag_value).strip()
    if tag_value.casefold() in _ABSENT_VALUES:
        return ""
    return tag_value.title()


def _missing_required_fields(values: Mapping[str, str]) -> list[str]:
    """Required fields, keyed by the human-facing column name for logs.

    Website and phone are deliberately absent. A blank website is now a
    scoring signal (`no_website`) rather than a rejection, and a lead's phone
    is never used to send anything: it renders into the preview page and
    nowhere else. 54.2% of the Australian list has no phone and 21.3% has no
    website, so requiring either threw away most of the list.
    """
    required_values = {
        "Email": values["email"],
        "Company Name": values["business_name"],
        "State": values["state"],
        "Industry": values["industry"],
    }
    return [name for name, value in required_values.items() if not value.strip()]


def _lead_from_apollo_row(
    values: Mapping[str, str],
    *,
    tenant_id: UUID,
    source_file: str,
    vertical: str,
) -> dict[str, object]:
    return {
        "tenant_id": tenant_id,
        "first_name": values["first_name"],
        "last_name": values["last_name"],
        "email": values["email"].lower(),
        "email_status": values["email_status"] or "unverified",
        "phone": values["phone"],
        "business_name": values["business_name"],
        "city": values["city"],
        "state": values["state"],
        "country": "Australia",
        "website_url": values["website"],
        "industry": values["industry"],
        "keywords": values["keywords"],
        "technologies": values["technologies"],
        "apollo_contact_id": values["apollo_contact_id"],
        "apollo_account_id": values["apollo_account_id"],
        "source_file": source_file,
        "vertical": vertical,
        "status": "imported",
    }

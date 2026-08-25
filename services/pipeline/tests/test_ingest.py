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
from workers.ingest import ingest_csv_file, normalise_industry, parse_ingest_args

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")


@dataclass(frozen=True)
class RecordedLead:
    tenant_id: UUID
    email: str
    status: str
    source_file: str
    vertical: str
    fields: dict[str, object]


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
                fields=dict(lead),
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


# ---------------------------------------------------------------------------
# Column-name aliases
#
# The Apollo export uses spaced headers ("Company Name", "Mobile Phone"). The
# 900k Australian consolidated export uses underscores and different names
# ("Company_Name", "Phone", "Mobile"). Header lookup is normalised so a third
# naming style does not break this a third time.
# ---------------------------------------------------------------------------

UNDERSCORE_FIELDNAMES = [
    "First_Name",
    "Last_Name",
    "Email",
    "Email_Status",
    "Phone",
    "Mobile",
    "Company_Name",
    "Website",
    "City",
    "State",
    "Keywords",
    "Industry",
]


def _underscore_row(index: int, **overrides: str) -> dict[str, str]:
    row: dict[str, str] = {
        "First_Name": f"First{index}",
        "Last_Name": f"Last{index}",
        "Email": f"lead{index}@example.com",
        "Email_Status": "Verified",
        "Phone": f"+61290000{index:03d}",
        "Mobile": f"+61400000{index:03d}",
        "Company_Name": f"Aussie Co {index}",
        "Website": f"https://aussie{index}.example.com",
        "City": "Brisbane",
        "State": "QLD",
        "Keywords": "cafe",
        "Industry": "Hospitality & Food",
    }
    row.update(overrides)
    return row


def _write_csv(
    tmp_path: Path,
    *,
    fieldnames: list[str],
    rows: list[dict[str, str]],
    name: str = "leads.csv",
) -> Path:
    path = tmp_path / name
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    return path


async def _ingest(
    csv_path: Path,
    *,
    repository: FakeLeadRepository | None = None,
    queue: FakeQueue | None = None,
):
    repository = repository or FakeLeadRepository()
    queue = queue or FakeQueue()
    summary = await ingest_csv_file(
        csv_path,
        tenant_id=TENANT_ID,
        source_file="leads.csv",
        vertical="general",
        score_threshold=35,
        lead_repository=repository,
        queue=queue,
    )
    return summary, repository, queue


def test_underscore_headers_are_accepted(tmp_path: Path) -> None:
    """Every row of the 900k Australian export would be rejected against the
    spaced Apollo headers, and the failure would look like bad data."""

    async def scenario() -> None:
        csv_path = _write_csv(
            tmp_path, fieldnames=UNDERSCORE_FIELDNAMES, rows=[_underscore_row(0)]
        )

        summary, repository, queue = await _ingest(csv_path)

        assert summary.rejected_rows == 0
        assert summary.inserted_rows == 1
        assert len(queue.jobs) == 1
        fields = repository.inserted[0].fields
        assert fields["business_name"] == "Aussie Co 0"
        assert fields["first_name"] == "First0"
        assert fields["last_name"] == "Last0"
        assert fields["email"] == "lead0@example.com"
        assert fields["email_status"] == "Verified"
        assert fields["city"] == "Brisbane"
        assert fields["state"] == "QLD"
        assert fields["website_url"] == "https://aussie0.example.com"
        assert fields["keywords"] == "cafe"

    asyncio.run(scenario())


def test_spaced_apollo_headers_still_map_to_the_same_fields(tmp_path: Path) -> None:
    """Regression guard: the alias map must not be a swap to underscores."""

    async def scenario() -> None:
        csv_path = _write_apollo_csv(tmp_path, row_count=1)

        summary, repository, _queue = await _ingest(csv_path)

        assert summary.rejected_rows == 0
        fields = repository.inserted[0].fields
        assert fields["business_name"] == "Trade Co 0"
        assert fields["website_url"] == "https://trade0.example.com"
        assert fields["phone"] == "+61400000000"
        assert fields["technologies"] == "WordPress, Mobile Friendly"
        assert fields["apollo_contact_id"] == "contact-0"
        assert fields["apollo_account_id"] == "account-0"

    asyncio.run(scenario())


def test_header_lookup_ignores_case_and_separator_style(tmp_path: Path) -> None:
    """A third naming variant must not break this again."""

    async def scenario() -> None:
        fieldnames = ["EMAIL", "company-name", "  State  ", "industry", "MOBILE PHONE"]
        rows = [
            {
                "EMAIL": "odd@example.com",
                "company-name": "Odd Caps Co",
                "  State  ": "VIC",
                "industry": "Retail",
                "MOBILE PHONE": "+61400111222",
            }
        ]
        csv_path = _write_csv(tmp_path, fieldnames=fieldnames, rows=rows)

        summary, repository, _queue = await _ingest(csv_path)

        assert summary.rejected_rows == 0
        fields = repository.inserted[0].fields
        assert fields["business_name"] == "Odd Caps Co"
        assert fields["state"] == "VIC"
        assert fields["phone"] == "+61400111222"

    asyncio.run(scenario())


def test_phone_prefers_mobile_over_landline_across_both_naming_styles(
    tmp_path: Path,
) -> None:
    """The old code preferred "Mobile Phone" over "Corporate Phone". The new
    file's equivalents are "Mobile" and "Phone", and the preference is the
    same: a mobile reaches a tradesperson, a landline reaches an office."""

    async def scenario() -> None:
        csv_path = _write_csv(
            tmp_path, fieldnames=UNDERSCORE_FIELDNAMES, rows=[_underscore_row(0)]
        )
        _summary, repository, _queue = await _ingest(csv_path)
        assert repository.inserted[0].fields["phone"] == "+61400000000"

        csv_path = _write_csv(
            tmp_path,
            fieldnames=UNDERSCORE_FIELDNAMES,
            rows=[_underscore_row(0, Mobile="")],
            name="landline.csv",
        )
        _summary, repository, _queue = await _ingest(csv_path)
        assert repository.inserted[0].fields["phone"] == "+61290000000"

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Phone is no longer required
# ---------------------------------------------------------------------------


def test_row_without_any_phone_is_accepted(tmp_path: Path) -> None:
    """54.2% of the Australian list has no phone number of any kind, and a
    lead's phone is never used to send anything."""

    async def scenario() -> None:
        csv_path = _write_csv(
            tmp_path,
            fieldnames=UNDERSCORE_FIELDNAMES,
            rows=[_underscore_row(0, Phone="", Mobile="")],
        )

        summary, repository, queue = await _ingest(csv_path)

        assert summary.rejected_rows == 0
        assert summary.inserted_rows == 1
        assert len(queue.jobs) == 1
        assert repository.inserted[0].fields["phone"] == ""

    asyncio.run(scenario())


def test_apollo_row_without_any_phone_is_accepted(tmp_path: Path) -> None:
    async def scenario() -> None:
        csv_path = _write_apollo_csv(
            tmp_path,
            row_count=1,
            row_overrides={0: {"Mobile Phone": "", "Corporate Phone": ""}},
        )

        summary, _repository, _queue = await _ingest(csv_path)

        assert summary.rejected_rows == 0
        assert summary.inserted_rows == 1

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# A blank website is a signal, not a rejection
# ---------------------------------------------------------------------------


def test_row_without_website_is_accepted_and_stores_an_empty_url(tmp_path: Path) -> None:
    """6,011 Australian rows have no website. The empty string is the exact
    value workers.enrich keys its no-site path on, so the contract between
    ingest and enrich gets its own assertion."""

    async def scenario() -> None:
        csv_path = _write_csv(
            tmp_path, fieldnames=UNDERSCORE_FIELDNAMES, rows=[_underscore_row(0, Website="")]
        )

        summary, repository, queue = await _ingest(csv_path)

        assert summary.rejected_rows == 0
        assert summary.inserted_rows == 1
        assert repository.inserted[0].fields["website_url"] == ""
        assert len(queue.jobs) == 1
        assert queue.jobs[0]["job_type"] == JobType.ENRICH_LEAD.value
        assert queue.jobs[0]["score_threshold"] == 35

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# The stored website URL must be well formed
# ---------------------------------------------------------------------------


def test_bare_domain_is_stored_with_an_https_scheme(tmp_path: Path) -> None:
    """The incident this fix exists for.

    The Australian source CSV spells websites as bare domains with no
    scheme. Every earlier import happened to carry `https://`, so the raw
    passthrough was never exercised. Chromium rejects a schemeless string,
    the audit answered with its unreachable record and an empty weaknesses
    array, and an empty weaknesses array archives the lead on the derived
    gate in workers.qualify, which runs after the paid Haiku call. 252 real
    leads were archived on that fabricated premise.
    """

    async def scenario() -> None:
        csv_path = _write_csv(
            tmp_path,
            fieldnames=UNDERSCORE_FIELDNAMES,
            rows=[_underscore_row(0, Website="cottellandco.com.au")],
        )

        summary, repository, _queue = await _ingest(csv_path)

        assert summary.rejected_rows == 0
        assert repository.inserted[0].fields["website_url"] == "https://cottellandco.com.au"

    asyncio.run(scenario())


def test_stored_website_url_keeps_a_source_supplied_http_scheme(tmp_path: Path) -> None:
    """Ingest must not upgrade http to https. `has_ssl` is measured from the
    scheme that actually loaded, so rewriting the source here would either
    fabricate an SSL result or fail navigation against a host with no TLS."""

    async def scenario() -> None:
        csv_path = _write_csv(
            tmp_path,
            fieldnames=UNDERSCORE_FIELDNAMES,
            rows=[_underscore_row(0, Website="http://example.com.au")],
        )

        _summary, repository, _queue = await _ingest(csv_path)

        assert repository.inserted[0].fields["website_url"] == "http://example.com.au"

    asyncio.run(scenario())


def test_stored_website_url_is_stripped_of_surrounding_whitespace(tmp_path: Path) -> None:
    """A stray space in the export is enough to break navigation, and the
    CSV reader hands the value through verbatim."""

    async def scenario() -> None:
        csv_path = _write_csv(
            tmp_path,
            fieldnames=UNDERSCORE_FIELDNAMES,
            rows=[_underscore_row(0, Website="  www.example.com  ")],
        )

        _summary, repository, _queue = await _ingest(csv_path)

        assert repository.inserted[0].fields["website_url"] == "https://www.example.com"

    asyncio.run(scenario())


def test_a_blank_website_is_never_turned_into_a_bare_scheme(tmp_path: Path) -> None:
    """Regression guard on the normaliser's most damaging failure mode.

    A blank website means the business has no site, and workers.enrich keys
    its truthful `no_website` record on the empty string. Storing `https://`
    for a blank cell would send 6,011 Australian rows down the audit path
    and convert an accurate record into a fabricated unreachable one.
    """

    async def scenario() -> None:
        csv_path = _write_csv(
            tmp_path,
            fieldnames=UNDERSCORE_FIELDNAMES,
            rows=[_underscore_row(0, Website="   ")],
        )

        _summary, repository, _queue = await _ingest(csv_path)

        assert repository.inserted[0].fields["website_url"] == ""

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# A blank state is a gap in the data, not a rejection
# ---------------------------------------------------------------------------


def test_row_without_a_state_is_accepted_and_stores_an_empty_state(tmp_path: Path) -> None:
    """Requiring State threw away 8,511 of the 22,697 importable Australian
    rows, and 2,768 of the 3,397 with no website at all: the exact population
    the no-website campaign exists to reach.

    The column is also not trustworthy. 497,556 records file-wide carry a
    country name in it; "germany" alone appears 105,355 times. A field that
    wrong cannot be a gate.
    """

    async def scenario() -> None:
        csv_path = _write_csv(
            tmp_path, fieldnames=UNDERSCORE_FIELDNAMES, rows=[_underscore_row(0, State="")]
        )

        summary, repository, queue = await _ingest(csv_path)

        assert summary.rejected_rows == 0
        assert summary.inserted_rows == 1
        assert summary.rejected_by_field == {}
        assert repository.inserted[0].fields["state"] == ""
        assert len(queue.jobs) == 1
        assert queue.jobs[0]["job_type"] == JobType.ENRICH_LEAD.value


    asyncio.run(scenario())


def test_row_without_a_state_or_a_city_or_a_website_is_accepted(tmp_path: Path) -> None:
    """The row this change exists for: no website, no state, no city. It has
    to survive all three gaps at once, not one at a time."""

    async def scenario() -> None:
        csv_path = _write_csv(
            tmp_path,
            fieldnames=UNDERSCORE_FIELDNAMES,
            rows=[_underscore_row(0, State="", City="", Website="")],
        )

        summary, repository, queue = await _ingest(csv_path)

        assert summary.rejected_rows == 0
        assert summary.inserted_rows == 1
        fields = repository.inserted[0].fields
        assert fields["state"] == ""
        assert fields["city"] == ""
        assert fields["website_url"] == ""
        assert len(queue.jobs) == 1

    asyncio.run(scenario())


def test_apollo_row_without_a_state_is_accepted(tmp_path: Path) -> None:
    """The spaced-header Apollo path shares the same gate. If only the
    underscore path were proven, half the callers would still reject."""

    async def scenario() -> None:
        csv_path = _write_apollo_csv(
            tmp_path,
            row_count=1,
            row_overrides={0: {"State": ""}},
        )

        summary, _repository, _queue = await _ingest(csv_path)

        assert summary.rejected_rows == 0
        assert summary.inserted_rows == 1

    asyncio.run(scenario())


def test_row_without_email_is_still_rejected(tmp_path: Path) -> None:
    """Loosening two required fields must not loosen the rest. Email is the
    send channel; without it the lead cannot be contacted at all."""

    async def scenario() -> None:
        csv_path = _write_csv(
            tmp_path, fieldnames=UNDERSCORE_FIELDNAMES, rows=[_underscore_row(0, Email="")]
        )

        summary, repository, queue = await _ingest(csv_path)

        assert summary.rejected_rows == 1
        assert summary.inserted_rows == 0
        assert repository.inserted == []
        assert queue.jobs == []

    asyncio.run(scenario())


def test_row_without_company_name_or_industry_is_still_rejected(tmp_path: Path) -> None:
    """The three fields that survive every loosening. Company Name is what
    the preview page is built about, Email is the only send channel, and
    Industry is what the scoring prompt reasons over.

    Each is asserted on its own row so a single field silently becoming
    optional cannot hide behind another still rejecting.
    """

    async def scenario() -> None:
        for field_name in ("Company_Name", "Industry", "Email"):
            csv_path = _write_csv(
                tmp_path,
                fieldnames=UNDERSCORE_FIELDNAMES,
                rows=[_underscore_row(0, **{field_name: ""})],
                name=f"missing-{field_name}.csv",
            )

            summary, repository, queue = await _ingest(csv_path)

            assert summary.rejected_rows == 1, field_name
            assert summary.inserted_rows == 0, field_name
            assert repository.inserted == [], field_name
            assert queue.jobs == [], field_name

    asyncio.run(scenario())


def test_rejection_reasons_are_counted_per_field(tmp_path: Path) -> None:
    """A lump `rejected_rows` count cannot tell an operator whether a column
    is missing from the file or genuinely sparse in the data. On the real
    Australian slice these counts are the difference between "the import
    worked" and "half the list silently vanished"."""

    async def scenario() -> None:
        rows = [
            _underscore_row(0, Email=""),
            _underscore_row(1, State=""),
            _underscore_row(2, State="", Industry=""),
            _underscore_row(3, Company_Name=""),
            _underscore_row(4),
        ]
        csv_path = _write_csv(tmp_path, fieldnames=UNDERSCORE_FIELDNAMES, rows=rows)

        summary, _repository, _queue = await _ingest(csv_path)

        # Row 1 is missing only State, which no longer rejects, so it imports
        # alongside row 4. Row 2 still rejects, but for Industry alone.
        assert summary.rejected_rows == 3
        assert summary.inserted_rows == 2
        assert summary.rejected_by_field == {"Email": 1, "Industry": 1, "Company Name": 1}

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Industry normalisation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # Raw OpenStreetMap tags. "amenity=school" alone appears 2,641 times
        # in the Australian slice and goes straight into the scoring prompt.
        ("amenity=school", "School"),
        ("amenity=place_of_worship", "Place Of Worship"),
        ("amenity=kindergarten", "Kindergarten"),
        ("tourism=hotel", "Hotel"),
        ("shop=hairdresser", "Hairdresser"),
        # Colon-separated form, as used by the Category column.
        ("amenity:restaurant", "Restaurant"),
        ("office:company", "Company"),
        # Namespaced OSM key.
        ("healthcare:speciality=physiotherapist", "Physiotherapist"),
        # Compound tags: the first tag is the primary one.
        ("amenity=doctors; healthcare=doctor", "Doctors"),
        # Curated labels are left exactly as they are. Title-casing these
        # would turn "PR & Communications" into "Pr & Communications".
        ("Finance & Accounting", "Finance & Accounting"),
        ("Construction", "Construction"),
        ("Food, Hospitality & Travel", "Food, Hospitality & Travel"),
        ("PR & Communications", "PR & Communications"),
        # Absent values.
        ("", ""),
        ("   ", ""),
        ("None", ""),
        ("none", ""),
        ("NONE", ""),
        # An OSM tag with an empty value carries no information either.
        ("amenity=", ""),
        # Whitespace around a real value is not information.
        ("  Retail  ", "Retail"),
    ],
)
def test_industry_is_normalised(raw: str, expected: str) -> None:
    assert normalise_industry(raw) == expected


def test_osm_industry_tag_is_normalised_on_the_stored_lead(tmp_path: Path) -> None:
    """The normaliser has to actually be wired into the row mapping, not just
    exist as a tested function nothing calls."""

    async def scenario() -> None:
        csv_path = _write_csv(
            tmp_path,
            fieldnames=UNDERSCORE_FIELDNAMES,
            rows=[_underscore_row(0, Industry="amenity=school")],
        )

        _summary, repository, _queue = await _ingest(csv_path)

        assert repository.inserted[0].fields["industry"] == "School"

    asyncio.run(scenario())


def test_industry_of_literal_none_is_rejected_like_an_empty_industry(
    tmp_path: Path,
) -> None:
    """"None" is a missing value wearing a string costume. Storing "" while
    letting the row through would mean an empty Industry rejects a row and a
    "None" Industry does not, which is two rules for one condition."""

    async def scenario() -> None:
        csv_path = _write_csv(
            tmp_path,
            fieldnames=UNDERSCORE_FIELDNAMES,
            rows=[_underscore_row(0, Industry="None")],
        )

        summary, _repository, _queue = await _ingest(csv_path)

        assert summary.rejected_rows == 1
        assert summary.rejected_by_field == {"Industry": 1}

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

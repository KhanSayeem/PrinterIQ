"""The prompt rewrite invalidates the score threshold. This proves it safely.

QUALIFICATION_SCORE_THRESHOLD is 35 on the VPS. That number was chosen against
qualify-v1, whose rubric rewarded "construction/trades industry" and penalised
"not a tradie business". qualify-v2 scores four different things. A lead
scoring 42 under v1 and a lead scoring 42 under v2 are not the same
measurement; they share a numeral. Carrying 35 forward is not keeping the
setting, it is changing it to an unknown value.

This harness scores a sample with Haiku and writes a CSV. It cannot call
Sonnet, cannot write a qualifications row, cannot change a lead's status, and
cannot enqueue anything, because it is never handed anything that could.
"""

from __future__ import annotations

import asyncio
import csv
import inspect
import json
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from uuid import UUID

import pytest

from db.queries import list_leads_for_shadow_scoring
from workers.shadow_qualify import (
    ShadowLeadStore,
    ShadowQualifyError,
    parse_shadow_qualify_args,
    shadow_qualify,
)

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
HAIKU_MODEL = "claude-haiku-4-5-20251001"
SONNET_MODEL = "claude-sonnet-4-6"


@dataclass(frozen=True)
class ClaudeResponse:
    text: str
    cost_usd: Decimal
    model: str


@dataclass
class FakeClaudeClient:
    responses: list[str] | None = None
    model: str = HAIKU_MODEL
    calls: list[tuple[str, dict[str, str]]] = field(default_factory=list)
    _index: int = field(default=0, init=False)

    async def call(self, prompt_name: str, variables: dict[str, str]) -> ClaudeResponse:
        self.calls.append((prompt_name, variables))
        if self.responses is None:
            text = json.dumps(
                {
                    "score": 61,
                    "rationale": "Opportunity 35, contactability 15, dependence 20, live 10.",
                    "top_weakness": "no mobile layout",
                    "weakness_label": "no_mobile",
                }
            )
        else:
            text = self.responses[min(self._index, len(self.responses) - 1)]
        self._index += 1
        return ClaudeResponse(text=text, cost_usd=Decimal("0.0001"), model=self.model)


@dataclass
class FakeLeadReader:
    rows: list[dict[str, object]]
    calls: list[tuple[UUID, int]] = field(default_factory=list)

    async def list_leads_for_shadow_scoring(
        self, *, tenant_id: UUID, limit: int
    ) -> list[dict[str, object]]:
        self.calls.append((tenant_id, limit))
        return self.rows[:limit]


class RecordingConnection:
    def __init__(self, rows: list[object] | None = None) -> None:
        self.rows = rows or []
        self.queries: list[str] = []
        self.args: list[tuple[object, ...]] = []

    async def fetch(self, query: str, *args: object) -> list[object]:
        self.queries.append(query)
        self.args.append(args)
        return self.rows


def _row(
    lead_id: str = "20000000-0000-0000-0000-000000000001",
    *,
    weaknesses: list[str] | None = None,
    industry: str = "Finance & Accounting",
) -> dict[str, object]:
    return {
        "lead_id": UUID(lead_id),
        "tenant_id": TENANT_ID,
        "business_name": "Sample Co",
        "email": "sample@example.com",
        "email_status": "Verified",
        "phone": "+61400000001",
        "city": "Brisbane",
        "state": "QLD",
        "website_url": "https://sample.example.com",
        "industry": industry,
        "keywords": "accounting",
        "has_site": True,
        "is_reachable": True,
        "weaknesses": ["no_mobile"] if weaknesses is None else weaknesses,
    }


# ---------------------------------------------------------------------------
# The four things this harness must be unable to do
# ---------------------------------------------------------------------------


def test_shadow_qualify_is_not_given_anything_that_can_write_or_send() -> None:
    """The strongest available guarantee is structural, not behavioural.

    A test asserting "the repository was never called" only holds for the
    repository the test passed in. This asserts the function has no parameter
    that could reach a qualifications row, a lead status, or a queue at all.
    """
    parameters = set(inspect.signature(shadow_qualify).parameters)

    for forbidden in ("repo", "repository", "queue", "outreach_queue", "qualification_repo"):
        assert forbidden not in parameters
    assert parameters == {"tenant_id", "lead_reader", "claude_client", "output_path", "limit"}


def test_shadow_qualify_refuses_a_prompt_that_is_not_haiku() -> None:
    """Sonnet is roughly four times the input price and twenty times the
    output price. A shadow run over a few hundred leads must not be able to
    become an outreach-copy bill by way of one edited constant."""
    from workers import shadow_qualify as module

    assert module._SHADOW_PROMPT == "qualify-v2"

    from clients import claude_client

    assert claude_client._MODEL_MAP[module._SHADOW_PROMPT] == HAIKU_MODEL


def test_shadow_qualify_rejects_a_client_that_answered_with_sonnet(tmp_path: Path) -> None:
    """Belt and braces: if the client returns a non-Haiku model the run stops
    rather than quietly billing Sonnet rates for every lead in the sample."""

    async def scenario() -> None:
        client = FakeClaudeClient(model=SONNET_MODEL)

        with pytest.raises(ShadowQualifyError, match="not the Haiku model"):
            await shadow_qualify(
                tenant_id=TENANT_ID,
                lead_reader=FakeLeadReader(rows=[_row()]),
                claude_client=client,
                output_path=tmp_path / "shadow.csv",
            )

        # Stopped on the first response, not after scoring the whole sample.
        assert len(client.calls) == 1

    asyncio.run(scenario())


def test_shadow_qualify_only_ever_calls_the_scoring_prompt(tmp_path: Path) -> None:
    async def scenario() -> None:
        client = FakeClaudeClient()

        await shadow_qualify(
            tenant_id=TENANT_ID,
            lead_reader=FakeLeadReader(rows=[_row(), _row("20000000-0000-0000-0000-000000000002")]),
            claude_client=client,
            output_path=tmp_path / "shadow.csv",
        )

        assert {call[0] for call in client.calls} == {"qualify-v2"}

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# What it produces
# ---------------------------------------------------------------------------


def test_shadow_qualify_writes_a_score_and_rationale_per_lead(tmp_path: Path) -> None:
    async def scenario() -> None:
        output_path = tmp_path / "shadow.csv"

        summary = await shadow_qualify(
            tenant_id=TENANT_ID,
            lead_reader=FakeLeadReader(
                rows=[_row(), _row("20000000-0000-0000-0000-000000000002")]
            ),
            claude_client=FakeClaudeClient(),
            output_path=output_path,
        )

        assert summary.scored == 2
        assert summary.failed == 0

        with output_path.open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))

        assert len(rows) == 2
        assert rows[0]["score"] == "61"
        assert "Opportunity 35" in rows[0]["rationale"]
        assert rows[0]["weakness_label"] == "no_mobile"
        assert rows[0]["prompt_version"] == "qualify-v2"
        assert rows[0]["business_name"] == "Sample Co"
        assert rows[0]["industry"] == "Finance & Accounting"
        assert rows[0]["has_website"] == "True"

    asyncio.run(scenario())


def test_shadow_qualify_marks_no_website_leads_in_the_output(tmp_path: Path) -> None:
    """The whole reason for a stratified sample: the operator needs to see
    whether the no-website cohort lands above or below the threshold."""

    async def scenario() -> None:
        output_path = tmp_path / "shadow.csv"

        await shadow_qualify(
            tenant_id=TENANT_ID,
            lead_reader=FakeLeadReader(
                rows=[
                    {**_row(), "has_site": False, "website_url": "", "weaknesses": ["no_website"]}
                ]
            ),
            claude_client=FakeClaudeClient(),
            output_path=output_path,
        )

        with output_path.open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))

        assert rows[0]["has_website"] == "False"
        assert rows[0]["measured_weaknesses"] == "no_website"

    asyncio.run(scenario())


def test_shadow_qualify_records_an_unparseable_response_instead_of_stopping(
    tmp_path: Path,
) -> None:
    """One bad response must not throw away the rest of the sample, and must
    not silently shrink it either. A run of 300 that quietly scores 240 is the
    exact shape of failure this repo keeps producing."""

    async def scenario() -> None:
        output_path = tmp_path / "shadow.csv"
        good = json.dumps(
            {
                "score": 61,
                "rationale": "fine",
                "top_weakness": "no mobile layout",
                "weakness_label": "no_mobile",
            }
        )

        summary = await shadow_qualify(
            tenant_id=TENANT_ID,
            lead_reader=FakeLeadReader(
                rows=[_row(), _row("20000000-0000-0000-0000-000000000002")]
            ),
            claude_client=FakeClaudeClient(responses=["not json at all", good]),
            output_path=output_path,
        )

        assert summary.scored == 1
        assert summary.failed == 1

        with output_path.open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))

        assert len(rows) == 2
        assert rows[0]["score"] == ""
        assert rows[0]["error"] != ""
        assert rows[1]["score"] == "61"

    asyncio.run(scenario())


def test_shadow_qualify_passes_the_limit_through_to_the_reader(tmp_path: Path) -> None:
    async def scenario() -> None:
        reader = FakeLeadReader(rows=[_row(f"20000000-0000-0000-0000-{i:012d}") for i in range(9)])

        await shadow_qualify(
            tenant_id=TENANT_ID,
            lead_reader=reader,
            claude_client=FakeClaudeClient(),
            output_path=tmp_path / "shadow.csv",
            limit=4,
        )

        assert reader.calls == [(TENANT_ID, 4)]

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# The query
# ---------------------------------------------------------------------------


def test_list_leads_for_shadow_scoring_is_tenant_scoped() -> None:
    async def scenario() -> None:
        connection = RecordingConnection(rows=[])

        await list_leads_for_shadow_scoring(connection, tenant_id=TENANT_ID, limit=300)

        query = connection.queries[0]
        # "l." is load-bearing. A bare "tenant_id = $1" would also be
        # satisfied by filtering only the enrichments side of the join.
        assert "l.tenant_id = $1" in query
        assert "l.tenant_id = e.tenant_id" in query
        assert "is_deleted = FALSE" in query
        assert connection.args[0] == (TENANT_ID, 300)

    asyncio.run(scenario())


def test_list_leads_for_shadow_scoring_reads_only() -> None:
    """A read helper that could write is a read helper that will."""

    async def scenario() -> None:
        connection = RecordingConnection(rows=[])

        await list_leads_for_shadow_scoring(connection, tenant_id=TENANT_ID, limit=10)

        query = connection.queries[0].upper()
        assert query.strip().startswith("SELECT")
        # Substring, not word, so "IS_DELETED" is not mistaken for a DELETE.
        for statement in ("INSERT INTO", "UPDATE ", "DELETE FROM", "TRUNCATE "):
            assert statement not in query

    asyncio.run(scenario())


def test_list_leads_for_shadow_scoring_decodes_the_weaknesses_jsonb() -> None:
    """asyncpg hands jsonb back as str unless a codec is registered, and a
    truthy '["no_h1"]' string reads as a list to every downstream check."""

    async def scenario() -> None:
        connection = RecordingConnection(rows=[{**_row(), "weaknesses": '["no_h1"]'}])

        rows = await list_leads_for_shadow_scoring(connection, tenant_id=TENANT_ID, limit=10)

        assert rows[0]["weaknesses"] == ["no_h1"]

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# The command line the runbook tells the operator to type
# ---------------------------------------------------------------------------


def test_the_module_is_runnable_as_documented() -> None:
    """A documented command that is a no-op is worse than no command.

    parse_shadow_qualify_args existed and nothing called it, so
    `python -m workers.shadow_qualify ...` would have parsed nothing, run
    nothing, and exited 0. That is precisely the shape of failure this repo
    keeps producing: a clean exit that did no work.
    """
    from workers import shadow_qualify as module

    source = Path(module.__file__ or "").read_text(encoding="utf-8")

    assert callable(module.main)
    assert 'if __name__ == "__main__":' in source
    assert "main()" in source.rsplit('if __name__ == "__main__":', 1)[1]


def test_cli_rejects_a_non_positive_limit() -> None:
    """--limit 0 scores nothing and reports success; a negative raises from
    asyncpg partway through. Both are caught before a connection is opened."""
    for bad in ("0", "-5"):
        with pytest.raises(SystemExit):
            parse_shadow_qualify_args(
                ["--tenant-id", str(TENANT_ID), "--limit", bad, "--output", "out.csv"]
            )


def test_cli_rejects_a_limit_above_the_cap() -> None:
    """One Haiku call per row. An unbounded limit turns a calibration run
    into a bill, and pulls the whole tenant into memory to do it."""
    with pytest.raises(SystemExit):
        parse_shadow_qualify_args(
            ["--tenant-id", str(TENANT_ID), "--limit", "100000", "--output", "out.csv"]
        )


def test_cli_accepts_a_sensible_limit() -> None:
    args = parse_shadow_qualify_args(
        ["--tenant-id", str(TENANT_ID), "--limit", "300", "--output", "out.csv"]
    )

    assert args.tenant_id == TENANT_ID
    assert args.limit == 300
    assert args.output == Path("out.csv")


def test_shadow_lead_store_exposes_only_the_read() -> None:
    """The adapter the CLI hands to shadow_qualify is the one place a raw
    SELECT could be inlined into a worker. Keeping it to a single forwarding
    method is what makes that obvious rather than tempting."""
    public = {name for name in vars(ShadowLeadStore) if not name.startswith("_")}

    assert public == {"list_leads_for_shadow_scoring"}


def test_shadow_lead_store_forwards_the_tenant_and_limit() -> None:
    async def scenario() -> None:
        connection = RecordingConnection(rows=[])
        store = ShadowLeadStore(connection)

        await store.list_leads_for_shadow_scoring(tenant_id=TENANT_ID, limit=7)

        assert connection.args[0] == (TENANT_ID, 7)

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# What the sample actually is
# ---------------------------------------------------------------------------


def test_list_leads_for_shadow_scoring_orders_deterministically() -> None:
    """Two runs over unchanged data must return the same rows.

    imported_at alone ties on any bulk import, and Postgres breaks ties
    arbitrarily, so a calibration artifact could differ run to run for no
    reason anybody could see.
    """

    async def scenario() -> None:
        connection = RecordingConnection(rows=[])

        await list_leads_for_shadow_scoring(connection, tenant_id=TENANT_ID, limit=10)

        assert "ORDER BY l.imported_at DESC, l.id DESC" in connection.queries[0]

    asyncio.run(scenario())


def test_shadow_output_records_lead_status_for_filtering(tmp_path: Path) -> None:
    """The sample is the most recently imported leads, not a stratified draw,
    and it deliberately includes leads that already went through the old
    gate, so v1 and v2 can be compared on the same businesses. That only
    works if the operator can tell them apart in the CSV.
    """

    async def scenario() -> None:
        output_path = tmp_path / "shadow.csv"
        rows = [{**_row(), "status": "archived"}]

        await shadow_qualify(
            tenant_id=TENANT_ID,
            lead_reader=FakeLeadReader(rows=rows),
            claude_client=FakeClaudeClient(),
            output_path=output_path,
        )

        with output_path.open(newline="", encoding="utf-8") as handle:
            written = list(csv.DictReader(handle))

        assert written[0]["lead_status"] == "archived"

    asyncio.run(scenario())


def test_list_leads_for_shadow_scoring_selects_lead_status() -> None:
    async def scenario() -> None:
        connection = RecordingConnection(rows=[])

        await list_leads_for_shadow_scoring(connection, tenant_id=TENANT_ID, limit=10)

        assert "l.status" in connection.queries[0]

    asyncio.run(scenario())

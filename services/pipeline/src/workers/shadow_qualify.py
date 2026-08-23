"""Score a sample of leads with the live scoring prompt and write a CSV.

Why this exists. QUALIFICATION_SCORE_THRESHOLD is 35 on the VPS, and that
number was chosen against qualify-v1, whose rubric rewarded
"construction/trades industry" and penalised "not a tradie business".
qualify-v2 scores four different things. A lead scoring 42 under v1 and a lead
scoring 42 under v2 are not the same measurement; they happen to share a
numeral. Carrying 35 forward is not keeping the setting, it is changing the
setting to a value nobody has measured.

What this can and cannot do. It reads leads, calls Haiku once per lead, and
writes a file. It is handed no repository and no queue, so it cannot write a
qualifications row, cannot move a lead's status, and cannot enqueue outreach.
It refuses to run against a prompt that is not mapped to Haiku, and stops if a
response comes back from a different model.

The calibration itself is the operator's judgement, not this file's. Read the
CSV, hand-label a subset with "would I want to sell to this business", and
pick the threshold that gives acceptable precision at the volume the mailboxes
can actually send. A threshold that qualifies 40,000 leads a day is not a
generous threshold, it is an unused one.

Usage:
    python -m workers.shadow_qualify --tenant-id <uuid> --limit 300 \\
        --output shadow-scores.csv
"""

from __future__ import annotations

import asyncio
import csv
import json
import logging
import os
from argparse import ArgumentParser, ArgumentTypeError, Namespace
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Protocol, cast
from uuid import UUID

from clients.claude_client import _MODEL_MAP
from workers.qualify import _HAIKU_PROMPT, _HAIKU_SCHEMA, _parse_and_validate

logger = logging.getLogger(__name__)

# Deliberately the same constant the live worker uses, so a shadow run can
# never measure a prompt other than the one production will run.
_SHADOW_PROMPT = _HAIKU_PROMPT
_HAIKU_MODEL = "claude-haiku-4-5-20251001"
_DEFAULT_LIMIT = 300
# One Haiku call per row, so an unbounded limit is both a bill and the whole
# tenant pulled into memory to produce it.
_MAX_LIMIT = 5_000

_CSV_COLUMNS = [
    "lead_id",
    "business_name",
    "industry",
    "keywords",
    "state",
    # The sample is the most recently imported leads, and it deliberately
    # includes leads that already went through the old gate so v1 and v2 can
    # be compared on the same businesses. That is only useful if the operator
    # can tell an already-archived lead from a fresh one in the CSV.
    "lead_status",
    "email_status",
    "has_phone",
    "has_website",
    "is_reachable",
    "measured_weaknesses",
    "score",
    "weakness_label",
    "top_weakness",
    "rationale",
    "cost_usd",
    "prompt_version",
    "error",
]


class ShadowQualifyError(RuntimeError):
    """Raised when a shadow run must stop rather than produce misleading output."""


@dataclass(frozen=True)
class ClaudeResponse:
    text: str
    cost_usd: Decimal
    model: str


@dataclass(frozen=True)
class ShadowQualifySummary:
    scored: int = 0
    failed: int = 0
    cost_usd: Decimal = Decimal("0")


class ShadowLeadReader(Protocol):
    async def list_leads_for_shadow_scoring(
        self, *, tenant_id: UUID, limit: int
    ) -> list[dict[str, object]]:
        """Return enriched leads for this tenant. Read-only."""


class ClaudeClient(Protocol):
    async def call(self, prompt_name: str, variables: dict[str, str]) -> ClaudeResponse:
        """Call Claude with the named prompt and variables, return response."""


async def shadow_qualify(
    *,
    tenant_id: UUID,
    lead_reader: ShadowLeadReader,
    claude_client: ClaudeClient,
    output_path: Path,
    limit: int = _DEFAULT_LIMIT,
) -> ShadowQualifySummary:
    if _MODEL_MAP.get(_SHADOW_PROMPT) != _HAIKU_MODEL:
        raise ShadowQualifyError(
            f"{_SHADOW_PROMPT} is not mapped to {_HAIKU_MODEL}; refusing to run a shadow "
            "scoring pass against a more expensive model"
        )

    leads = await lead_reader.list_leads_for_shadow_scoring(tenant_id=tenant_id, limit=limit)

    scored = 0
    failed = 0
    total_cost = Decimal("0")
    rows: list[dict[str, str]] = []

    for lead in leads:
        weaknesses = lead.get("weaknesses")
        measured = weaknesses if isinstance(weaknesses, list) else []
        row = {
            "lead_id": str(lead.get("lead_id", "")),
            "business_name": str(lead.get("business_name", "")),
            "industry": str(lead.get("industry", "")),
            "keywords": str(lead.get("keywords", "")),
            "state": str(lead.get("state", "")),
            "lead_status": str(lead.get("status", "")),
            "email_status": str(lead.get("email_status", "")),
            "has_phone": str(bool(str(lead.get("phone") or "").strip())),
            "has_website": str(lead.get("has_site")),
            "is_reachable": str(lead.get("is_reachable")),
            "measured_weaknesses": "|".join(str(item) for item in measured),
            "score": "",
            "weakness_label": "",
            "top_weakness": "",
            "rationale": "",
            "cost_usd": "",
            "prompt_version": _SHADOW_PROMPT,
            "error": "",
        }

        response = await claude_client.call(
            _SHADOW_PROMPT,
            {
                "lead_json": json.dumps(_scoring_view(lead), default=str),
                "enrichment_json": json.dumps(_enrichment_view(lead), default=str),
            },
        )
        if response.model != _HAIKU_MODEL:
            raise ShadowQualifyError(
                f"shadow scoring answered from {response.model}, which is not the Haiku "
                "model; stopping before the rest of the sample is billed at that rate"
            )

        total_cost += response.cost_usd
        row["cost_usd"] = str(response.cost_usd)

        parsed = _parse_and_validate(response.text, _HAIKU_SCHEMA)
        if parsed is None:
            # Recorded rather than dropped. A run of 300 that quietly scores
            # 240 looks exactly like a run of 300 that scored 300.
            failed += 1
            row["error"] = "response was not valid JSON for the scoring schema"
        else:
            scored += 1
            row["score"] = str(int(parsed["score"]))
            row["weakness_label"] = str(parsed["weakness_label"])
            row["top_weakness"] = str(parsed["top_weakness"])
            row["rationale"] = str(parsed["rationale"])

        rows.append(row)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=_CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)

    logger.info(
        "Shadow scored %s leads (%s failed) with %s into %s, cost %s USD",
        scored,
        failed,
        _SHADOW_PROMPT,
        output_path,
        total_cost,
    )
    return ShadowQualifySummary(scored=scored, failed=failed, cost_usd=total_cost)


def _scoring_view(lead: dict[str, object]) -> dict[str, object]:
    return {
        key: lead.get(key)
        for key in (
            "lead_id",
            "business_name",
            "email",
            "email_status",
            "phone",
            "city",
            "state",
            "website_url",
            "industry",
            "keywords",
        )
    }


def _enrichment_view(lead: dict[str, object]) -> dict[str, object]:
    weaknesses = lead.get("weaknesses")
    return {
        "has_site": lead.get("has_site"),
        "is_reachable": lead.get("is_reachable"),
        "weaknesses": weaknesses if isinstance(weaknesses, list) else [],
    }


class ShadowLeadStore:
    """The one adapter between the CLI and db.queries.

    Deliberately a single forwarding method. This is the place a raw SELECT
    would get inlined into a worker the next time somebody needs one more
    column, and a class with exactly one method makes that obvious rather
    than convenient.
    """

    def __init__(self, connection: object) -> None:
        self._connection = connection

    async def list_leads_for_shadow_scoring(
        self, *, tenant_id: UUID, limit: int
    ) -> list[dict[str, object]]:
        from db.queries import DatabaseConnection, list_leads_for_shadow_scoring

        return await list_leads_for_shadow_scoring(
            cast("DatabaseConnection", self._connection), tenant_id=tenant_id, limit=limit
        )


def _positive_limit(raw: str) -> int:
    value = int(raw)
    if value <= 0:
        raise ArgumentTypeError("--limit must be greater than zero")
    if value > _MAX_LIMIT:
        raise ArgumentTypeError(
            f"--limit must be {_MAX_LIMIT} or fewer; this makes one Haiku call per lead"
        )
    return value


def parse_shadow_qualify_args(argv: Sequence[str] | None = None) -> Namespace:
    parser = ArgumentParser(
        description="Score a sample of enriched leads with the live scoring prompt. "
        "Writes a CSV. Sends nothing, writes nothing to the database."
    )
    parser.add_argument("--tenant-id", required=True, type=UUID)
    parser.add_argument("--limit", type=_positive_limit, default=_DEFAULT_LIMIT)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args(argv)


async def _run(args: Namespace) -> ShadowQualifySummary:
    import importlib

    from clients.claude_client import RealClaudeClient
    from env import load_pipeline_env

    load_pipeline_env()
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise ShadowQualifyError("Missing env var: DATABASE_URL")
    anthropic_key = os.getenv("ANTHROPIC_API_KEY")
    if not anthropic_key:
        raise ShadowQualifyError("Missing env var: ANTHROPIC_API_KEY")

    asyncpg = importlib.import_module("asyncpg")
    connection = await asyncpg.connect(database_url)
    try:
        return await shadow_qualify(
            tenant_id=args.tenant_id,
            lead_reader=ShadowLeadStore(connection),
            # RealClaudeClient returns clients.claude_client.ClaudeResponse,
            # which is field-for-field identical to the dataclass declared
            # here but nominally distinct, so mypy will not match it against
            # the local Protocol. Every worker in this package carries the
            # same duplicate declaration and the orchestrator casts for the
            # same reason.
            claude_client=cast(
                "ClaudeClient",
                RealClaudeClient(
                    api_key=anthropic_key,
                    prompts_dir=Path(__file__).resolve().parents[4] / "prompts",
                ),
            ),
            output_path=args.output,
            limit=args.limit,
        )
    finally:
        await connection.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    args = parse_shadow_qualify_args()
    summary = asyncio.run(_run(args))
    print(
        f"scored={summary.scored} failed={summary.failed} "
        f"cost_usd={summary.cost_usd} output={args.output}"
    )


if __name__ == "__main__":
    main()

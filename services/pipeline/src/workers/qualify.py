from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from decimal import Decimal
from typing import Any, Protocol
from uuid import UUID
from zoneinfo import ZoneInfo

from env import load_pipeline_env
from offer import offer_price_display
from pipeline_queue.definitions import JobType

logger = logging.getLogger(__name__)

_HAIKU_PROMPT = "qualify-v1"
_SONNET_PROMPT = "opener-v2"
_PROMPT_VERSION = "opener-v2"
_DEFAULT_CHANNEL = "email"
_SEND_WINDOW_TZ = ZoneInfo("Australia/Sydney")
_SEND_WINDOW_START = time(hour=9)
_SEND_WINDOW_END = time(hour=17)

_HAIKU_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": [
        "score",
        "rationale",
        "top_weakness",
        "weakness_label",
    ],
    "properties": {
        "score": {"type": "integer", "minimum": 0, "maximum": 100},
        "rationale": {"type": "string"},
        "top_weakness": {"type": "string"},
        # Deliberately unconstrained, after an enum here proved to be the
        # wrong tool twice in production.
        #
        # The value feeds exactly one thing: the grounding check below, which
        # tests membership of *this lead's* measured weaknesses array. That is
        # strictly stronger than an enum, because a perfectly valid canonical
        # label like "no_ssl" must still be rejected for a lead whose audit
        # never measured it. So the enum protected nothing the grounding check
        # does not already protect.
        #
        # What it did do was dead-letter clean sites. The prompt asks for a
        # label matching an entry in the weaknesses array; when the audit
        # measured nothing that array is empty, so Haiku answers with whatever
        # it picks for "nothing". One production batch produced "none", "" and
        # "no_weakness_detected" for the same situation. Schema validation
        # runs while parsing, before the archive gates, so each new spelling
        # became a dead-lettered lead. Roughly 60% of real audits measure no
        # weakness, so this failed in bulk.
        #
        # For an empty array the derived gate archives before grounding ever
        # runs, which makes any value here harmless.
        "weakness_label": {"type": "string"},
        # has_actionable_weakness is deliberately absent: it is derived in
        # qualify_lead from the enrichment weaknesses array. With
        # additionalProperties False, a model that supplies it anyway fails
        # validation and takes the retry path rather than overriding a value
        # the code owns.
    },
    "additionalProperties": False,
}

# Em dash (U+2014) and en dash (U+2013) reach customer-facing email copy when
# Claude uses them despite prompt instructions. Normalise rather than reject:
# rejecting on punctuation would dead-letter otherwise-good leads, and this
# text goes straight into a customer-facing email.
# Consume whitespace either side of the dash so both spaced and unspaced forms
# produce a correctly punctuated ", ". Replacing the dash alone yields
# "homepage,hurts" or "seconds , slower".
_DASH_SUBSTITUTES_PATTERN = re.compile(r"\s*[—–]\s*")
_MULTIPLE_SPACES_PATTERN = re.compile(r" {2,}")

_SONNET_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["subject_line", "opener", "followup_1", "followup_2", "weakness_sentence"],
    "properties": {
        "subject_line": {"type": "string"},
        "opener": {"type": "string"},
        "followup_1": {"type": "string"},
        "followup_2": {"type": "string"},
        "weakness_sentence": {"type": "string"},
    },
    "additionalProperties": False,
}


class DeadLetterError(Exception):
    """Raised when a job should be moved to dead-letter queue."""


@dataclass(frozen=True)
class ClaudeResponse:
    text: str
    cost_usd: Decimal
    model: str


class LeadFetcher(Protocol):
    async def get_lead(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        """Return the full lead row for the given tenant + lead."""


class EnrichmentFetcher(Protocol):
    async def get_enrichment(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        """Return the enrichment row for the given tenant + lead."""


class QualificationRepository(Protocol):
    async def insert_qualification(self, q: dict[str, object]) -> UUID:
        """Insert one qualifications row and return its id."""

    async def update_lead_status(
        self, *, tenant_id: UUID, lead_id: UUID, status: str
    ) -> None:
        """Update leads.status for the given tenant + lead."""


class OutreachQueue(Protocol):
    async def enqueue(self, payload: dict[str, object]) -> None:
        """Enqueue one downstream queue payload."""


class ClaudeClient(Protocol):
    async def call(self, prompt_name: str, variables: dict[str, str]) -> ClaudeResponse:
        """Call Claude with the named prompt and variables, return response."""


async def qualify_lead(
    payload: dict[str, object],
    *,
    lead_fetcher: LeadFetcher,
    enrichment_fetcher: EnrichmentFetcher,
    qualification_repo: QualificationRepository,
    outreach_queue: OutreachQueue,
    claude_client: ClaudeClient,
) -> None:
    tenant_id = UUID(str(payload["tenant_id"]))
    lead_id = UUID(str(payload["lead_id"]))

    if "score_threshold" not in payload:
        raise ValueError("score_threshold missing from qualify_lead payload")
    score_threshold = int(str(payload["score_threshold"]))

    lead = await lead_fetcher.get_lead(tenant_id=tenant_id, lead_id=lead_id)
    enrichment = await enrichment_fetcher.get_enrichment(tenant_id=tenant_id, lead_id=lead_id)

    # The website audit already answered "does this lead have a fixable
    # defect?" — every entry in `weaknesses` is something a producer actually
    # measured (see services/pipeline/src/weaknesses.py). Deriving the gate
    # from that array instead of asking Haiku removes a second, redundant
    # severity judgement: the prompt's "worth pitching a rebuild over" wording
    # archived leads whose only measured defect was a missing H1, even though
    # they scored above threshold. Severity is the score threshold's dial;
    # this gate only asks whether anything was measured at all.
    #
    # The isinstance guard is load-bearing, not defensive noise. `weaknesses`
    # is jsonb, and asyncpg hands jsonb back as str unless a codec is
    # registered; db.queries.get_enrichment_by_lead_id decodes it, but any
    # caller that does not would otherwise pass a truthy '["no_h1"]' string
    # straight through this gate, and `"no_h1" in '["no_h1"]'` also passes
    # the grounding check below by substring match. Treat anything that is
    # not a list as nothing measured.
    raw_enrichment_weaknesses = enrichment.get("weaknesses")
    grounded_weaknesses = (
        raw_enrichment_weaknesses if isinstance(raw_enrichment_weaknesses, list) else []
    )
    has_actionable_weakness: bool = bool(grounded_weaknesses)

    lead_json = json.dumps(lead, default=str)
    enrichment_json = json.dumps(enrichment, default=str)

    haiku_resp = await claude_client.call(
        _HAIKU_PROMPT, {"lead_json": lead_json, "enrichment_json": enrichment_json}
    )
    haiku_data = _parse_and_validate(haiku_resp.text, _HAIKU_SCHEMA)
    if haiku_data is None:
        logger.warning("Haiku returned invalid JSON — retrying once")
        haiku_resp = await claude_client.call(
            _HAIKU_PROMPT, {"lead_json": lead_json, "enrichment_json": enrichment_json}
        )
        haiku_data = _parse_and_validate(haiku_resp.text, _HAIKU_SCHEMA)
        if haiku_data is None:
            raise DeadLetterError("Haiku returned invalid JSON twice — dead-lettering")

    score: int = int(haiku_data["score"])
    rationale: str = _normalise_dashes(str(haiku_data["rationale"]))
    top_weakness: str = _normalise_dashes(str(haiku_data["top_weakness"]))
    weakness_label: str = str(haiku_data["weakness_label"])

    if score < score_threshold:
        await _archive_without_outreach(
            qualification_repo,
            tenant_id=tenant_id,
            lead_id=lead_id,
            score=score,
            rationale=rationale,
            top_weakness=top_weakness,
            has_actionable_weakness=has_actionable_weakness,
            haiku_resp=haiku_resp,
        )
        return

    if not has_actionable_weakness:
        await _archive_without_outreach(
            qualification_repo,
            tenant_id=tenant_id,
            lead_id=lead_id,
            score=score,
            rationale=rationale,
            top_weakness=top_weakness,
            has_actionable_weakness=has_actionable_weakness,
            haiku_resp=haiku_resp,
        )
        return

    # Grounding gate: a lead that reaches here is about to have
    # customer-facing copy written about it, so weakness_label must name a
    # weakness this lead's enrichment actually measured — not something
    # Haiku inferred or hallucinated. Deliberately ordered after the score
    # and has_actionable_weakness archive gates above: a lead with an empty
    # weaknesses array archives cleanly on the derived gate instead of
    # dead-lettering here on a grounding check no label could ever pass.
    if weakness_label not in grounded_weaknesses:
        logger.warning(
            "Haiku weakness_label %r not present in enrichment weaknesses %r — retrying once",
            weakness_label,
            grounded_weaknesses,
        )
        haiku_resp = await claude_client.call(
            _HAIKU_PROMPT, {"lead_json": lead_json, "enrichment_json": enrichment_json}
        )
        haiku_data = _parse_and_validate(haiku_resp.text, _HAIKU_SCHEMA)
        if haiku_data is None:
            raise DeadLetterError(
                "Haiku returned invalid JSON on weakness_label grounding retry — dead-lettering"
            )
        weakness_label = str(haiku_data["weakness_label"])
        if weakness_label not in grounded_weaknesses:
            raise DeadLetterError(
                "Haiku weakness_label not grounded in enrichment weaknesses "
                "after retry — dead-lettering"
            )
        score = int(haiku_data["score"])
        rationale = _normalise_dashes(str(haiku_data["rationale"]))
        top_weakness = _normalise_dashes(str(haiku_data["top_weakness"]))

        # The retry replaced score, but the threshold gate above already ran
        # against the superseded response. Re-run it against the retried
        # value, or a retry returning a below-threshold score would reach
        # Sonnet and be emailed - the exact outcome that gate exists to
        # prevent. has_actionable_weakness needs no re-check: it is derived
        # from enrichment, which the retry cannot change.
        if score < score_threshold:
            await _archive_without_outreach(
                qualification_repo,
                tenant_id=tenant_id,
                lead_id=lead_id,
                score=score,
                rationale=rationale,
                top_weakness=top_weakness,
                has_actionable_weakness=has_actionable_weakness,
                haiku_resp=haiku_resp,
            )
            return

    sonnet_resp = await claude_client.call(
        _SONNET_PROMPT,
        {
            "lead_json": lead_json,
            "top_weakness": top_weakness,
            "rationale": rationale,
            "enrichment_json": enrichment_json,
            "price_aud": offer_price_display(),
        },
    )
    sonnet_data = _parse_and_validate(sonnet_resp.text, _SONNET_SCHEMA)
    if sonnet_data is None:
        logger.warning("Sonnet returned invalid JSON — retrying once")
        sonnet_resp = await claude_client.call(
            _SONNET_PROMPT,
            {
                "lead_json": lead_json,
                "top_weakness": top_weakness,
                "rationale": rationale,
                "enrichment_json": enrichment_json,
                "price_aud": offer_price_display(),
            },
        )
        sonnet_data = _parse_and_validate(sonnet_resp.text, _SONNET_SCHEMA)
        if sonnet_data is None:
            raise DeadLetterError("Sonnet returned invalid JSON twice — dead-lettering")

    total_cost = haiku_resp.cost_usd + sonnet_resp.cost_usd
    await qualification_repo.insert_qualification(
        {
            "lead_id": lead_id,
            "tenant_id": tenant_id,
            "score": score,
            "rationale": rationale,
            "top_weakness": top_weakness,
            "has_actionable_weakness": has_actionable_weakness,
            "subject_line": _normalise_dashes(str(sonnet_data["subject_line"])),
            "personalised_opener": _normalise_dashes(str(sonnet_data["opener"])),
            "followup_1": _normalise_dashes(str(sonnet_data["followup_1"])),
            "followup_2": _normalise_dashes(str(sonnet_data["followup_2"])),
            "weakness_sentence": _normalise_dashes(str(sonnet_data["weakness_sentence"])),
            "model_haiku": haiku_resp.model,
            "model_sonnet": sonnet_resp.model,
            "cost_usd": total_cost,
            "prompt_version": _PROMPT_VERSION,
        }
    )
    await qualification_repo.update_lead_status(
        tenant_id=tenant_id, lead_id=lead_id, status="qualified"
    )
    await outreach_queue.enqueue(
        {
            "job_type": JobType.GENERATE_PREVIEW.value,
            "tenant_id": str(tenant_id),
            "lead_id": str(lead_id),
            "campaign_id": _campaign_id(payload),
            "channel": str(payload.get("channel", _DEFAULT_CHANNEL)),
            "send_after": _send_after(payload),
        }
    )


async def _archive_without_outreach(
    qualification_repo: QualificationRepository,
    *,
    tenant_id: UUID,
    lead_id: UUID,
    score: int,
    rationale: str,
    top_weakness: str,
    has_actionable_weakness: bool,
    haiku_resp: ClaudeResponse,
) -> None:
    """Archive a lead on Haiku output alone: no Sonnet call, no preview, no outreach.

    Used both when the score misses threshold and when the lead's enrichment
    measured no weakness at all. Note the second condition is presence, not
    severity: "worth pitching a rebuild over" was the prompt wording that
    caused leads with real measured defects to archive, and it is gone.
    """
    await qualification_repo.insert_qualification(
        {
            "lead_id": lead_id,
            "tenant_id": tenant_id,
            "score": score,
            "rationale": rationale,
            "top_weakness": top_weakness,
            "has_actionable_weakness": has_actionable_weakness,
            "subject_line": None,
            "personalised_opener": None,
            "followup_1": None,
            "followup_2": None,
            "weakness_sentence": None,
            "model_haiku": haiku_resp.model,
            "model_sonnet": None,
            "cost_usd": haiku_resp.cost_usd,
            "prompt_version": _PROMPT_VERSION,
        }
    )
    await qualification_repo.update_lead_status(
        tenant_id=tenant_id, lead_id=lead_id, status="archived"
    )


def _normalise_dashes(value: str) -> str:
    """Replace em/en dashes with a comma and collapse resulting double spaces.

    Model output occasionally uses em dashes (U+2014) or en dashes (U+2013)
    despite prompt instructions banning them, and this text is persisted
    straight into customer-facing email copy. Normalise rather than reject:
    rejecting on punctuation would throw away an otherwise-good lead.
    """
    replaced = _DASH_SUBSTITUTES_PATTERN.sub(", ", value)
    collapsed = _MULTIPLE_SPACES_PATTERN.sub(" ", replaced)
    return collapsed.strip(" ,")


def _parse_and_validate(text: str, schema: dict[str, Any]) -> dict[str, Any] | None:
    """Parse a model response, returning None if it is unusable.

    Both failure modes return None so callers can share one retry path, but
    they are logged distinctly. A schema violation and malformed JSON need
    completely different diagnoses, and the caller's "invalid JSON" wording
    would send an operator to the parser when the real cause is a changed
    model output contract.
    """
    import jsonschema

    try:
        raw = json.loads(_strip_json_code_fence(text))
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Model response was not decodable JSON: %s", exc)
        return None
    if not isinstance(raw, dict):
        logger.warning("Model response decoded to %s, expected a JSON object", type(raw).__name__)
        return None
    try:
        jsonschema.validate(instance=raw, schema=schema)
    except jsonschema.ValidationError as exc:
        logger.warning("Model response failed schema validation: %s", exc.message)
        return None
    return raw


def _strip_json_code_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped

    lines = stripped.splitlines()
    if len(lines) >= 3 and lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return stripped


def _campaign_id(payload: dict[str, object]) -> str:
    raw_campaign_id = payload.get("campaign_id")
    if raw_campaign_id is not None and str(raw_campaign_id).strip():
        return str(raw_campaign_id)

    load_pipeline_env()
    env_campaign_id = os.getenv("INSTANTLY_CAMPAIGN_ID")
    if env_campaign_id:
        return env_campaign_id
    raise ValueError("campaign_id missing from qualify_lead payload")


def _next_send_after(now: datetime | None = None) -> datetime:
    current = now.astimezone(_SEND_WINDOW_TZ) if now else datetime.now(_SEND_WINDOW_TZ)
    if _is_send_window(current):
        return current

    candidate = current
    if candidate.time() >= _SEND_WINDOW_END:
        candidate += timedelta(days=1)
    candidate = candidate.replace(
        hour=_SEND_WINDOW_START.hour,
        minute=0,
        second=0,
        microsecond=0,
    )
    while candidate.weekday() >= 5:
        candidate += timedelta(days=1)
    return candidate


def _is_send_window(value: datetime) -> bool:
    return value.weekday() < 5 and _SEND_WINDOW_START <= value.time() < _SEND_WINDOW_END


def _send_after(payload: dict[str, object]) -> str:
    raw_send_after = payload.get("send_after")
    if raw_send_after is None:
        return _next_send_after().isoformat()
    parsed = datetime.fromisoformat(str(raw_send_after))
    if parsed.tzinfo is None:
        raise ValueError("send_after must include timezone")
    return str(raw_send_after)

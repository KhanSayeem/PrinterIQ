from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from decimal import Decimal
from typing import Any, Protocol
from uuid import UUID
from zoneinfo import ZoneInfo

from env import load_pipeline_env
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
        "score", "rationale", "top_weakness",
        "subject_line", "opener", "followup_1", "followup_2",
    ],
    "properties": {
        "score": {"type": "integer", "minimum": 0, "maximum": 100},
        "rationale": {"type": "string"},
        "top_weakness": {"type": "string"},
        "subject_line": {"type": "string"},
        "opener": {"type": "string"},
        "followup_1": {"type": "string"},
        "followup_2": {"type": "string"},
    },
    "additionalProperties": False,
}

_SONNET_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["subject_line", "opener", "followup_1", "followup_2"],
    "properties": {
        "subject_line": {"type": "string"},
        "opener": {"type": "string"},
        "followup_1": {"type": "string"},
        "followup_2": {"type": "string"},
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
    rationale: str = str(haiku_data["rationale"])
    top_weakness: str = str(haiku_data["top_weakness"])

    if score < score_threshold:
        await qualification_repo.insert_qualification(
            {
                "lead_id": lead_id,
                "tenant_id": tenant_id,
                "score": score,
                "rationale": rationale,
                "top_weakness": top_weakness,
                "subject_line": None,
                "personalised_opener": None,
                "followup_1": None,
                "followup_2": None,
                "model_haiku": haiku_resp.model,
                "model_sonnet": None,
                "cost_usd": haiku_resp.cost_usd,
                "prompt_version": _PROMPT_VERSION,
            }
        )
        await qualification_repo.update_lead_status(
            tenant_id=tenant_id, lead_id=lead_id, status="archived"
        )
        return

    sonnet_resp = await claude_client.call(
        _SONNET_PROMPT,
        {"lead_json": lead_json, "top_weakness": top_weakness, "rationale": rationale},
    )
    sonnet_data = _parse_and_validate(sonnet_resp.text, _SONNET_SCHEMA)
    if sonnet_data is None:
        logger.warning("Sonnet returned invalid JSON — retrying once")
        sonnet_resp = await claude_client.call(
            _SONNET_PROMPT,
            {"lead_json": lead_json, "top_weakness": top_weakness, "rationale": rationale},
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
            "subject_line": str(sonnet_data["subject_line"]),
            "personalised_opener": str(sonnet_data["opener"]),
            "followup_1": str(sonnet_data["followup_1"]),
            "followup_2": str(sonnet_data["followup_2"]),
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


def _parse_and_validate(text: str, schema: dict[str, Any]) -> dict[str, Any] | None:
    import jsonschema

    try:
        raw = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    try:
        jsonschema.validate(instance=raw, schema=schema)
    except jsonschema.ValidationError:
        return None
    return raw


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

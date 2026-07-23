from __future__ import annotations

import json
import secrets
from contextlib import suppress
from dataclasses import dataclass
from decimal import Decimal
from html import escape
from pathlib import Path
from typing import Any, Protocol
from uuid import UUID

import jsonschema

from pipeline_queue.definitions import JobType

_PROMPT_VERSION = "preview-personalise-v1"
_PREVIEW_BASE_URL = "https://preview.presciaiq.com"
_TEMPLATE_DIR = Path(__file__).resolve().parents[1] / "templates" / "previews"
_DEFAULT_OUTPUT_DIR = Path("/var/www/previews")

TRADE_KEYWORDS: dict[str, list[str]] = {
    "plumbing": ["plumber", "plumbing", "hot water", "pipes", "drainage", "blocked drains"],
    "electrical": ["electrician", "electrical", "solar", "switchboard", "wiring", "lighting"],
    "hvac": ["air conditioning", "hvac", "heating", "cooling", "refrigeration", "split system"],
    "concreting": ["concreting", "concrete", "driveways", "paths", "slabs", "footings"],
    "landscaping": ["landscaping", "lawn", "gardens", "turf", "retaining walls", "mowing"],
}

_PERSONALISATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["about_blurb", "founder_name", "year_founded", "services"],
    "properties": {
        "about_blurb": {"type": "string", "minLength": 1},
        "founder_name": {"type": "string", "minLength": 1},
        "year_founded": {"type": "integer", "minimum": 1995, "maximum": 2018},
        "services": {
            "type": "array",
            "minItems": 6,
            "maxItems": 6,
            "items": {
                "type": "object",
                "required": ["title", "description"],
                "properties": {
                    "title": {"type": "string", "minLength": 1},
                    "description": {"type": "string", "minLength": 1},
                },
                "additionalProperties": False,
            },
        },
    },
    "additionalProperties": False,
}


class DeadLetterError(Exception):
    """Raised when preview generation should move to dead-letter handling."""


@dataclass(frozen=True)
class ClaudeResponse:
    text: str
    cost_usd: Decimal
    model: str


class LeadFetcher(Protocol):
    async def get_lead(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        """Return the lead row for the given tenant and lead."""


class WebsitePreviewRepository(Protocol):
    async def get_website_preview(
        self, *, tenant_id: UUID, lead_id: UUID
    ) -> dict[str, object] | None:
        """Return existing preview metadata for the tenant lead when present."""

    async def insert_website_preview(self, preview: dict[str, object]) -> UUID:
        """Insert website preview metadata and return the row id."""


class ScheduleQueue(Protocol):
    async def enqueue(self, payload: dict[str, object]) -> None:
        """Enqueue one downstream schedule_outreach payload."""


class ClaudeClient(Protocol):
    async def call(self, prompt_name: str, variables: dict[str, str]) -> ClaudeResponse:
        """Call Claude with the named prompt and variables."""


async def generate_preview(
    payload: dict[str, object],
    *,
    lead_fetcher: LeadFetcher,
    preview_repo: WebsitePreviewRepository,
    schedule_queue: ScheduleQueue,
    claude_client: ClaudeClient,
    template_dir: Path = _TEMPLATE_DIR,
    output_dir: Path = _DEFAULT_OUTPUT_DIR,
    preview_base_url: str = _PREVIEW_BASE_URL,
) -> None:
    tenant_id = UUID(str(payload["tenant_id"]))
    lead_id = UUID(str(payload["lead_id"]))

    existing_preview = await preview_repo.get_website_preview(
        tenant_id=tenant_id, lead_id=lead_id
    )
    preview_slug = _preview_slug(existing_preview) or _new_preview_slug()
    preview_url = _preview_url(preview_base_url, preview_slug=preview_slug)
    output_path = _output_path(output_dir, preview_slug=preview_slug)
    if (
        existing_preview is not None
        and str(existing_preview["preview_url"]) == preview_url
        and output_path.exists()
    ):
        await _enqueue_schedule(
            schedule_queue,
            payload=payload,
            tenant_id=tenant_id,
            lead_id=lead_id,
            preview_url=preview_url,
        )
        return

    lead = await lead_fetcher.get_lead(tenant_id=tenant_id, lead_id=lead_id)
    template_key = select_template_key(lead)
    claude_resp = await _call_claude_for_personalisation(claude_client, lead)
    try:
        personalisation = parse_personalisation_json(claude_resp.text)
    except DeadLetterError:
        claude_resp = await _call_claude_for_personalisation(claude_client, lead)
        personalisation = parse_personalisation_json(claude_resp.text)

    template_source = (template_dir / f"{template_key}.html").read_text(encoding="utf-8")
    rendered_html = render_preview_html(template_source, lead=lead, personalisation=personalisation)
    pending_path = _pending_output_path(output_dir, preview_slug=preview_slug)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    pending_path.parent.mkdir(parents=True, exist_ok=True)
    pending_path.write_text(rendered_html, encoding="utf-8")

    try:
        await preview_repo.insert_website_preview(
            {
                "tenant_id": tenant_id,
                "lead_id": lead_id,
                "template_used": template_key,
                "preview_slug": preview_slug,
                "preview_url": preview_url,
                "personalisation_data": personalisation,
                "prompt_version": _PROMPT_VERSION,
                "cost_usd": claude_resp.cost_usd,
            }
        )
        pending_path.replace(output_path)
    except Exception:
        with suppress(FileNotFoundError):
            pending_path.unlink()
        raise
    await _enqueue_schedule(
        schedule_queue,
        payload=payload,
        tenant_id=tenant_id,
        lead_id=lead_id,
        preview_url=preview_url,
    )


async def _enqueue_schedule(
    schedule_queue: ScheduleQueue,
    *,
    payload: dict[str, object],
    tenant_id: UUID,
    lead_id: UUID,
    preview_url: str,
) -> None:
    await schedule_queue.enqueue(
        {
            "job_type": JobType.SCHEDULE_OUTREACH.value,
            "tenant_id": str(tenant_id),
            "lead_id": str(lead_id),
            "campaign_id": str(payload["campaign_id"]),
            "channel": str(payload.get("channel", "email")),
            "send_after": str(payload["send_after"]),
            "preview_url": preview_url,
        }
    )


def _preview_slug(existing_preview: dict[str, object] | None) -> str | None:
    if existing_preview is None:
        return None
    raw_slug = existing_preview.get("preview_slug")
    if not isinstance(raw_slug, str) or not raw_slug.strip():
        return None
    return raw_slug.strip()


def _new_preview_slug() -> str:
    return secrets.token_urlsafe(24)


def _preview_url(preview_base_url: str, *, preview_slug: str) -> str:
    return f"{preview_base_url.rstrip('/')}/p/{preview_slug}/"


def _output_path(output_dir: Path, *, preview_slug: str) -> Path:
    return output_dir / "p" / preview_slug / "index.html"


def _pending_output_path(output_dir: Path, *, preview_slug: str) -> Path:
    return (
        output_dir.parent
        / f".{output_dir.name}-pending"
        / "p"
        / preview_slug
        / "index.html"
    )


def select_template_key(lead: dict[str, object]) -> str:
    for field_name in ("industry", "vertical", "keywords"):
        haystack = str(lead.get(field_name) or "").lower()
        for template_key, keywords in TRADE_KEYWORDS.items():
            if any(keyword in haystack for keyword in keywords):
                return template_key
    return "general"


def parse_personalisation_json(text: str) -> dict[str, object]:
    try:
        raw = json.loads(_strip_json_code_fence(text))
    except (json.JSONDecodeError, ValueError) as exc:
        raise DeadLetterError("invalid preview personalisation JSON") from exc
    if not isinstance(raw, dict):
        raise DeadLetterError("invalid preview personalisation object")
    services = raw.get("services")
    if not isinstance(services, list) or len(services) != 6:
        raise DeadLetterError("invalid preview personalisation: services must contain exactly 6")
    try:
        jsonschema.validate(instance=raw, schema=_PERSONALISATION_SCHEMA)
    except jsonschema.ValidationError as exc:
        raise DeadLetterError("invalid preview personalisation schema") from exc
    _reject_dash_substitutes(raw)
    return raw


def _strip_json_code_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped

    lines = stripped.splitlines()
    if len(lines) >= 3 and lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return stripped


def render_preview_html(
    template_source: str,
    *,
    lead: dict[str, object],
    personalisation: dict[str, object],
) -> str:
    services = personalisation["services"]
    if not isinstance(services, list) or len(services) != 6:
        raise DeadLetterError("invalid preview personalisation: services must contain exactly 6")

    token_map = {
        "{{BUSINESS_NAME}}": _escape_token(_string_value(lead, "business_name")),
        "{{CITY}}": _escape_token(_string_value(lead, "city")),
        "{{STATE}}": _escape_token(_string_value(lead, "state")),
        "{{PHONE}}": _escape_token(_string_value(lead, "phone")),
        "{{EMAIL}}": _escape_token(_string_value(lead, "email")),
        "{{ABOUT_BLURB}}": _escape_token(str(personalisation["about_blurb"])),
        "{{YEAR_FOUNDED}}": _escape_token(str(personalisation["year_founded"])),
        "{{FOUNDER_NAME}}": _escape_token(str(personalisation["founder_name"])),
    }
    for index, service in enumerate(services, start=1):
        if not isinstance(service, dict):
            raise DeadLetterError("invalid preview personalisation service")
        token_map[f"{{{{SERVICE_{index}_TITLE}}}}"] = _escape_token(str(service["title"]))
        token_map[f"{{{{SERVICE_{index}_DESC}}}}"] = _escape_token(
            str(service["description"])
        )

    rendered = template_source
    for token, value in token_map.items():
        rendered = rendered.replace(token, value)
    return rendered


async def _call_claude_for_personalisation(
    claude_client: ClaudeClient,
    lead: dict[str, object],
) -> ClaudeResponse:
    return await claude_client.call(
        _PROMPT_VERSION,
        {
            "business_name": _string_value(lead, "business_name"),
            "city": _string_value(lead, "city"),
            "state": _string_value(lead, "state"),
            "industry": _string_value(lead, "industry"),
            "keywords": _string_value(lead, "keywords"),
        },
    )


def _string_value(row: dict[str, object], field_name: str) -> str:
    value = row.get(field_name)
    return "" if value is None else str(value)


def _escape_token(value: str) -> str:
    return escape(value, quote=True)


def _reject_dash_substitutes(value: object) -> None:
    if isinstance(value, str):
        if "\u2014" in value or "--" in value:
            raise DeadLetterError("invalid preview personalisation dash")
        return
    if isinstance(value, dict):
        for nested in value.values():
            _reject_dash_substitutes(nested)
        return
    if isinstance(value, list):
        for nested in value:
            _reject_dash_substitutes(nested)

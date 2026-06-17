from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import Protocol
from uuid import UUID

from env import load_pipeline_env

_PREVIEW_BASE_URL = "https://preview.presciaiq.com"


class SendWindowNotReachedError(RuntimeError):
    """Raised when outreach should be retried after the configured send time."""


class OutreachSendLockedError(RuntimeError):
    """Raised when another worker already holds the same outreach send lock."""


class LeadFetcher(Protocol):
    async def get_lead(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        """Return the lead row for the given tenant and lead."""


class QualificationFetcher(Protocol):
    async def get_qualification(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        """Return the qualification row for the given tenant and lead."""


class OutreachRepository(Protocol):
    async def get_outreach_send(
        self,
        *,
        tenant_id: UUID,
        lead_id: UUID,
        instantly_campaign_id: str,
        channel: str,
    ) -> dict[str, object] | None:
        """Return an existing outreach_sends row for this campaign send, if any."""

    async def get_website_preview(
        self, *, tenant_id: UUID, lead_id: UUID
    ) -> dict[str, object] | None:
        """Return existing preview metadata for this tenant lead when present."""

    async def insert_outreach_send(self, send: dict[str, object]) -> UUID:
        """Insert one outreach_sends row."""

    async def reserve_outreach_send(self, send: dict[str, object]) -> UUID:
        """Reserve one outreach_sends row before the external Instantly call."""

    async def complete_outreach_send(self, send: dict[str, object]) -> UUID:
        """Attach the Instantly id to a reserved outreach_sends row."""

    async def abandon_outreach_send_reservation(self, send: dict[str, object]) -> None:
        """Remove a pending reservation when no external send was created."""

    async def mark_lead_contacted(self, *, tenant_id: UUID, lead_id: UUID) -> bool:
        """Advance a qualified lead to contacted and report whether a row changed."""

    async def acquire_outreach_send_lock(
        self,
        *,
        tenant_id: UUID,
        lead_id: UUID,
        instantly_campaign_id: str,
        channel: str,
    ) -> bool:
        """Acquire a per-send lock before making the external Instantly call."""

    async def release_outreach_send_lock(
        self,
        *,
        tenant_id: UUID,
        lead_id: UUID,
        instantly_campaign_id: str,
        channel: str,
    ) -> None:
        """Release the per-send lock after the external call path finishes."""


class InstantlyClient(Protocol):
    async def add_lead_to_campaign(self, payload: dict[str, object]) -> dict[str, object]:
        """Add one lead to an Instantly campaign."""


async def schedule_outreach(
    payload: dict[str, object],
    *,
    lead_fetcher: LeadFetcher,
    qualification_fetcher: QualificationFetcher,
    outreach_repo: OutreachRepository,
    instantly_client: InstantlyClient,
) -> None:
    tenant_id = UUID(str(payload["tenant_id"]))
    lead_id = UUID(str(payload["lead_id"]))
    campaign_id = _campaign_id(payload)
    channel = str(payload.get("channel", "email"))
    _ensure_send_after_due(payload)
    preview_url = await _preview_url(
        payload,
        tenant_id=tenant_id,
        lead_id=lead_id,
        preview_fetcher=outreach_repo,
    )

    lead = await lead_fetcher.get_lead(tenant_id=tenant_id, lead_id=lead_id)
    existing_send = await outreach_repo.get_outreach_send(
        tenant_id=tenant_id,
        lead_id=lead_id,
        instantly_campaign_id=campaign_id,
        channel=channel,
    )
    if existing_send is not None:
        if not existing_send.get("instantly_lead_id"):
            raise RuntimeError("outreach send is reserved but not completed")
        if lead.get("status") == "qualified":
            await outreach_repo.mark_lead_contacted(tenant_id=tenant_id, lead_id=lead_id)
        if lead.get("status") in {"qualified", "contacted"}:
            return
        raise ValueError("schedule_outreach cannot reuse send for non-active lead")

    if lead.get("status") != "qualified":
        raise ValueError("schedule_outreach requires a qualified lead")

    lock_acquired = await outreach_repo.acquire_outreach_send_lock(
        tenant_id=tenant_id,
        lead_id=lead_id,
        instantly_campaign_id=campaign_id,
        channel=channel,
    )
    if not lock_acquired:
        raise OutreachSendLockedError("outreach send is already locked")

    try:
        await outreach_repo.reserve_outreach_send(
            {
                "tenant_id": tenant_id,
                "lead_id": lead_id,
                "instantly_campaign_id": campaign_id,
                "channel": channel,
            }
        )
        qualification = await qualification_fetcher.get_qualification(
            tenant_id=tenant_id,
            lead_id=lead_id,
        )
        opener = _required_text(qualification, "personalised_opener")

        instantly_payload = _instantly_payload(
            campaign_id=campaign_id,
            lead=lead,
            qualification=qualification,
            opener=opener,
            lead_id=lead_id,
            preview_url=preview_url,
        )
        try:
            result = await instantly_client.add_lead_to_campaign(instantly_payload)
        except Exception:
            await outreach_repo.abandon_outreach_send_reservation(
                {
                    "tenant_id": tenant_id,
                    "lead_id": lead_id,
                    "instantly_campaign_id": campaign_id,
                    "channel": channel,
                }
            )
            raise
        instantly_lead_id = _instantly_lead_id(result)

        await outreach_repo.complete_outreach_send(
            {
                "tenant_id": tenant_id,
                "lead_id": lead_id,
                "instantly_campaign_id": campaign_id,
                "instantly_lead_id": instantly_lead_id,
                "channel": channel,
            }
        )
        if not await outreach_repo.mark_lead_contacted(tenant_id=tenant_id, lead_id=lead_id):
            raise RuntimeError("Lead was not qualified when marking contacted")
    finally:
        await outreach_repo.release_outreach_send_lock(
            tenant_id=tenant_id,
            lead_id=lead_id,
            instantly_campaign_id=campaign_id,
            channel=channel,
        )


def _campaign_id(payload: dict[str, object]) -> str:
    raw_campaign_id = payload.get("campaign_id")
    if raw_campaign_id is not None and str(raw_campaign_id).strip():
        return str(raw_campaign_id)

    load_pipeline_env()
    env_campaign_id = os.getenv("INSTANTLY_CAMPAIGN_ID")
    if env_campaign_id:
        return env_campaign_id
    raise ValueError("campaign_id missing from schedule_outreach payload")


def _ensure_send_after_due(payload: dict[str, object]) -> None:
    raw_send_after = payload.get("send_after")
    if raw_send_after is None:
        raise ValueError("send_after missing from schedule_outreach payload")
    send_after = _parse_send_after(str(raw_send_after))
    if send_after > datetime.now(UTC):
        raise SendWindowNotReachedError("send_after is in the future")


def _parse_send_after(raw_value: str) -> datetime:
    try:
        value = datetime.fromisoformat(raw_value)
    except ValueError as exc:
        raise ValueError("send_after must be an ISO datetime") from exc
    if value.tzinfo is None:
        raise ValueError("send_after must include timezone")
    return value.astimezone(UTC)


def _required_text(row: dict[str, object], field_name: str) -> str:
    value = row.get(field_name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} missing from qualification")
    return value


async def _preview_url(
    payload: dict[str, object],
    *,
    tenant_id: UUID,
    lead_id: UUID,
    preview_fetcher: OutreachRepository,
) -> str | None:
    raw_preview_url = payload.get("preview_url")
    if raw_preview_url is None:
        return None
    preview_url = str(raw_preview_url).strip()
    if not preview_url:
        raise ValueError("preview_url cannot be blank")
    preview = await preview_fetcher.get_website_preview(
        tenant_id=tenant_id,
        lead_id=lead_id,
    )
    expected_preview_url = None if preview is None else preview.get("preview_url")
    if preview_url != str(expected_preview_url or "").strip():
        raise ValueError("preview_url does not match tenant preview")
    return preview_url


def _instantly_payload(
    *,
    campaign_id: str,
    lead: dict[str, object],
    qualification: dict[str, object],
    opener: str,
    lead_id: UUID,
    preview_url: str | None,
) -> dict[str, object]:
    custom_variables = {
        "opener": opener,
        "weakness": str(qualification.get("top_weakness", "")),
        "followup_1": str(qualification.get("followup_1", "")),
        "followup_2": str(qualification.get("followup_2", "")),
        "lead_id": str(lead_id),
        "website_preview_url": preview_url or "",
    }
    if preview_url is not None:
        custom_variables["preview_url"] = preview_url

    return {
        "campaign_id": campaign_id,
        "leads": [
            {
                "email": str(lead["email"]),
                "personalization": opener,
                "website": str(lead.get("website_url", "")),
                "first_name": str(lead.get("first_name", "")),
                "last_name": str(lead.get("last_name", "")),
                "company_name": str(lead.get("business_name", "")),
                "phone": str(lead.get("phone", "")),
                "custom_variables": custom_variables,
            }
        ],
    }


def _instantly_lead_id(result: dict[str, object]) -> str:
    created_leads = result.get("created_leads")
    if isinstance(created_leads, list) and created_leads:
        first = created_leads[0]
        if isinstance(first, dict):
            instantly_lead_id = first.get("id")
            if isinstance(instantly_lead_id, str) and instantly_lead_id:
                return instantly_lead_id
    raise ValueError("Instantly response did not include id")

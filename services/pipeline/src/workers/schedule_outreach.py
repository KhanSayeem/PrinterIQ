from __future__ import annotations

import os
from typing import Protocol
from uuid import UUID

from env import load_pipeline_env


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

    async def insert_outreach_send(self, send: dict[str, object]) -> UUID:
        """Insert one outreach_sends row."""

    async def mark_lead_contacted(self, *, tenant_id: UUID, lead_id: UUID) -> bool:
        """Advance a qualified lead to contacted and report whether a row changed."""


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

    lead = await lead_fetcher.get_lead(tenant_id=tenant_id, lead_id=lead_id)
    existing_send = await outreach_repo.get_outreach_send(
        tenant_id=tenant_id,
        lead_id=lead_id,
        instantly_campaign_id=campaign_id,
        channel=channel,
    )
    if existing_send is not None:
        if lead.get("status") == "qualified":
            await outreach_repo.mark_lead_contacted(tenant_id=tenant_id, lead_id=lead_id)
        if lead.get("status") in {"qualified", "contacted"}:
            return
        raise ValueError("schedule_outreach cannot reuse send for non-active lead")

    if lead.get("status") != "qualified":
        raise ValueError("schedule_outreach requires a qualified lead")

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
    )
    result = await instantly_client.add_lead_to_campaign(instantly_payload)
    instantly_lead_id = _instantly_lead_id(result)

    await outreach_repo.insert_outreach_send(
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


def _campaign_id(payload: dict[str, object]) -> str:
    raw_campaign_id = payload.get("campaign_id")
    if raw_campaign_id is not None and str(raw_campaign_id).strip():
        return str(raw_campaign_id)

    load_pipeline_env()
    env_campaign_id = os.getenv("INSTANTLY_CAMPAIGN_ID")
    if env_campaign_id:
        return env_campaign_id
    raise ValueError("campaign_id missing from schedule_outreach payload")


def _required_text(row: dict[str, object], field_name: str) -> str:
    value = row.get(field_name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} missing from qualification")
    return value


def _instantly_payload(
    *,
    campaign_id: str,
    lead: dict[str, object],
    qualification: dict[str, object],
    opener: str,
    lead_id: UUID,
) -> dict[str, object]:
    return {
        "campaign": campaign_id,
        "email": str(lead["email"]),
        "personalization": opener,
        "website": str(lead.get("website_url", "")),
        "first_name": str(lead.get("first_name", "")),
        "last_name": str(lead.get("last_name", "")),
        "company_name": str(lead.get("business_name", "")),
        "phone": str(lead.get("phone", "")),
        "custom_variables": {
            "opener": opener,
            "weakness": str(qualification.get("top_weakness", "")),
            "followup_1": str(qualification.get("followup_1", "")),
            "followup_2": str(qualification.get("followup_2", "")),
            "lead_id": str(lead_id),
        },
    }


def _instantly_lead_id(result: dict[str, object]) -> str:
    instantly_lead_id = result.get("id")
    if not isinstance(instantly_lead_id, str) or not instantly_lead_id:
        raise ValueError("Instantly response did not include id")
    return instantly_lead_id

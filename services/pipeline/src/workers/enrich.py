from __future__ import annotations

import logging
from typing import Protocol
from uuid import UUID

from pipeline_queue.definitions import JobType

logger = logging.getLogger(__name__)


class LeadFetcher(Protocol):
    async def get_lead(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        """Return the full lead row for the given tenant + lead."""


class EnrichmentRepository(Protocol):
    async def insert_enrichment(self, enrichment: dict[str, object]) -> UUID:
        """Insert one enrichment row and return its id."""

    async def update_lead_status(
        self, *, tenant_id: UUID, lead_id: UUID, status: str
    ) -> None:
        """Update leads.status for the given tenant + lead."""


class QualifyQueue(Protocol):
    async def enqueue(self, payload: dict[str, object]) -> None:
        """Enqueue one downstream queue payload."""


class WebsiteAuditor(Protocol):
    async def audit(self, url: str) -> dict[str, object]:
        """Run a browser audit and return a structured result dict."""


async def enrich_lead(
    payload: dict[str, object],
    *,
    lead_fetcher: LeadFetcher,
    enrichment_repo: EnrichmentRepository,
    qualify_queue: QualifyQueue,
    auditor: WebsiteAuditor,
) -> None:
    tenant_id = UUID(str(payload["tenant_id"]))
    lead_id = UUID(str(payload["lead_id"]))
    score_threshold = int(str(payload["score_threshold"]))

    lead = await lead_fetcher.get_lead(tenant_id=tenant_id, lead_id=lead_id)
    technologies = str(lead.get("technologies", "")).strip()

    if technologies:
        enrichment = _enrich_from_apollo(technologies, tenant_id=tenant_id, lead_id=lead_id)
    else:
        website_url = str(lead.get("website_url", ""))
        audit = await auditor.audit(website_url)
        enrichment = _enrich_from_playwright(audit, tenant_id=tenant_id, lead_id=lead_id)

    await enrichment_repo.insert_enrichment(enrichment)
    await enrichment_repo.update_lead_status(
        tenant_id=tenant_id, lead_id=lead_id, status="enriched"
    )
    await qualify_queue.enqueue(
        {
            "job_type": JobType.QUALIFY_LEAD.value,
            "tenant_id": str(tenant_id),
            "lead_id": str(lead_id),
            "score_threshold": score_threshold,
        }
    )


def _enrich_from_apollo(
    technologies: str,
    *,
    tenant_id: UUID,
    lead_id: UUID,
) -> dict[str, object]:
    tech_lower = technologies.lower()
    is_mobile_friendly = "mobile friendly" in tech_lower
    has_ssl = "ssl" in tech_lower or "https" in tech_lower
    cms = _detect_cms(tech_lower)
    weaknesses: list[str] = []
    if not is_mobile_friendly:
        weaknesses.append("no_mobile")
    if not has_ssl:
        weaknesses.append("no_ssl")
    return {
        "tenant_id": tenant_id,
        "lead_id": lead_id,
        "has_site": True,
        "is_reachable": True,
        "is_mobile_friendly": is_mobile_friendly,
        "has_ssl": has_ssl,
        "has_meta_title": None,
        "has_meta_description": None,
        "has_h1": None,
        "load_ms": None,
        "lighthouse_mobile_score": None,
        "cms_detected": cms,
        "tech_source": "apollo",
        "weaknesses": weaknesses,
        "raw_audit": None,
    }


def _enrich_from_playwright(
    audit: dict[str, object],
    *,
    tenant_id: UUID,
    lead_id: UUID,
) -> dict[str, object]:
    return {
        "tenant_id": tenant_id,
        "lead_id": lead_id,
        "has_site": audit.get("has_site"),
        "is_reachable": audit.get("is_reachable"),
        "is_mobile_friendly": audit.get("is_mobile_friendly"),
        "has_ssl": audit.get("has_ssl"),
        "has_meta_title": audit.get("has_meta_title"),
        "has_meta_description": audit.get("has_meta_description"),
        "has_h1": audit.get("has_h1"),
        "load_ms": audit.get("load_ms"),
        "lighthouse_mobile_score": audit.get("lighthouse_mobile_score"),
        "cms_detected": audit.get("cms_detected"),
        "tech_source": "playwright",
        "weaknesses": audit.get("weaknesses", []),
        "raw_audit": audit.get("raw_audit"),
    }


def _detect_cms(tech_lower: str) -> str | None:
    for cms in ("wordpress", "wix", "squarespace", "shopify", "joomla", "drupal"):
        if cms in tech_lower:
            return cms.capitalize()
    return None

from __future__ import annotations

import logging
from typing import Protocol
from uuid import UUID

from pipeline_queue.definitions import JobType
from weaknesses import WEAKNESS_LABELS, Weakness

logger = logging.getLogger(__name__)

# The one weakness this worker measures itself rather than reading off an
# audit result. See the Weakness docstring for why the producer differs.
NO_SITE_WEAKNESSES: list[str] = [Weakness.NO_WEBSITE.value]


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
    website_url = str(lead.get("website_url") or "")

    if not website_url.strip():
        # A business with no website is not a business whose website failed
        # to load. Auditing an empty URL produced the second record: page.goto
        # ("") raises, the navigation handler returns _unreachable(), and that
        # asserts has_site True with an empty weaknesses array, which archives
        # the lead in qualify.py. Skipping the audit is also what stops 6,011
        # Australian rows each launching a Chromium that can only fail.
        enrichment = _enrich_without_a_site(
            technologies=technologies, tenant_id=tenant_id, lead_id=lead_id
        )
    else:
        # Deliberate behaviour change: the Playwright audit now runs for every
        # lead, Apollo `technologies` or not — one page load per enrichment.
        # Previously, a lead with Apollo tech data skipped Playwright entirely
        # and had has_h1/load_ms/has_meta_* hardcoded to None, so whether a
        # lead's H1/load-time/meta tags were ever checked depended on whether
        # the CSV happened to carry Apollo data, not on the site itself. Apollo
        # data may still inform cms_detected/tech_source below, but it never
        # substitutes for a measured signal again.
        audit = await auditor.audit(website_url)
        enrichment = _enrich_from_playwright(
            audit, technologies=technologies, tenant_id=tenant_id, lead_id=lead_id
        )

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


def _enrich_without_a_site(
    *,
    technologies: str,
    tenant_id: UUID,
    lead_id: UUID,
) -> dict[str, object]:
    """Build the enrichment row for a lead with no website URL at all.

    Every measured signal stays None on purpose. False would read as "we
    looked and it was bad"; None is the honest "nothing was measured, because
    there was nothing to measure". The single weakness recorded, `no_website`,
    is measured here and nowhere else: it comes from the lead row, which the
    auditor never sees.

    `tech_source` is NOT NULL in the schema, so it names this path explicitly
    rather than borrowing "playwright", which never ran.
    """
    return {
        "tenant_id": tenant_id,
        "lead_id": lead_id,
        "has_site": False,
        "is_reachable": False,
        "is_mobile_friendly": None,
        "has_ssl": None,
        "has_meta_title": None,
        "has_meta_description": None,
        "has_h1": None,
        "load_ms": None,
        "lighthouse_mobile_score": None,
        # No site means no CMS to detect. An Apollo `technologies` hint here
        # would be an unmeasured claim about a website that does not exist.
        "cms_detected": None,
        "tech_source": "no_site+apollo" if technologies else "no_site",
        "weaknesses": list(NO_SITE_WEAKNESSES),
        "raw_audit": {},
    }


def _enrich_from_playwright(
    audit: dict[str, object],
    *,
    technologies: str,
    tenant_id: UUID,
    lead_id: UUID,
) -> dict[str, object]:
    """Build an enrichment row from a Playwright audit, always the source of
    truth for measured signals (has_h1, load_ms, has_meta_*, is_mobile_friendly,
    has_ssl, weaknesses). Apollo `technologies` may only ever inform
    cms_detected (as a fallback when the audit found no CMS markers) and
    tech_source — never a measured signal.
    """
    apollo_cms = _detect_cms(technologies.lower()) if technologies else None
    measured_cms = audit.get("cms_detected")
    cms_detected = measured_cms if measured_cms else apollo_cms
    tech_source = "playwright+apollo" if technologies else "playwright"

    raw_weaknesses = audit.get("weaknesses", [])
    weaknesses = (
        [w for w in raw_weaknesses if w in WEAKNESS_LABELS]
        if isinstance(raw_weaknesses, list)
        else []
    )

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
        "cms_detected": cms_detected,
        "tech_source": tech_source,
        "weaknesses": weaknesses,
        "raw_audit": audit.get("raw_audit"),
    }


def _detect_cms(tech_lower: str) -> str | None:
    for cms in ("wordpress", "wix", "squarespace", "shopify", "joomla", "drupal"):
        if cms in tech_lower:
            return cms.capitalize()
    return None

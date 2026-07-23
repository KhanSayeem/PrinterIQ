from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol
from uuid import UUID

from prospects.normalization import ProspectInput, normalize_domain
from prospects.website_scoring import ASSESSMENT_VERSION, assess_website_health


class AssessProspectsError(RuntimeError):
    """Raised when a discovery run cannot safely enter Route B assessment."""


class ProspectAssessmentStore(Protocol):
    async def get_discovery_run(
        self, *, tenant_id: UUID, discovery_run_id: UUID
    ) -> Mapping[str, object] | None: ...

    async def list_discovered_prospects(
        self, *, tenant_id: UUID, discovery_run_id: UUID
    ) -> list[Mapping[str, object]]: ...

    async def apply_prospect_assessment_result(
        self, **values: object
    ) -> Mapping[str, object]: ...

    async def refresh_discovery_run_aggregates(
        self, tenant_id: UUID, discovery_run_id: UUID
    ) -> Mapping[str, object]: ...


class ProspectQueue(Protocol):
    async def enqueue(
        self,
        payload: dict[str, object],
        *,
        delay_until: object = None,
    ) -> None: ...


class WebsiteAuditor(Protocol):
    async def audit(self, url: str) -> Mapping[str, object]: ...


@dataclass(frozen=True)
class AssessProspectsResult:
    assessed_count: int


async def assess_prospects(
    payload: dict[str, object],
    *,
    store: ProspectAssessmentStore,
    queue: ProspectQueue,
    website_auditor: WebsiteAuditor,
    lead_repository: object | None = None,
    preview_queue: object | None = None,
    outreach_queue: object | None = None,
    instantly_client: object | None = None,
    claude_client: object | None = None,
) -> AssessProspectsResult:
    del lead_repository, preview_queue, outreach_queue, instantly_client, claude_client
    tenant_id = UUID(str(payload["tenant_id"]))
    run_id = UUID(str(payload["discovery_run_id"]))
    run = await store.get_discovery_run(tenant_id=tenant_id, discovery_run_id=run_id)
    if run is None:
        raise AssessProspectsError("Discovery run not found for tenant")
    status = str(run.get("status"))
    if status in {"review_ready", "completed", "failed"}:
        return AssessProspectsResult(assessed_count=0)
    if status != "processing":
        raise AssessProspectsError("Discovery run is not ready for assessment")

    rows = await store.list_discovered_prospects(
        tenant_id=tenant_id,
        discovery_run_id=run_id,
    )
    assessed_count = 0
    for row in rows:
        if not _is_assessable_owned_site(row):
            continue
        prospect = _to_input(row)
        audit = await website_auditor.audit(_audit_url(row, prospect))
        assessment = assess_website_health(prospect, audit)
        await store.apply_prospect_assessment_result(
            tenant_id=tenant_id,
            discovery_run_id=run_id,
            prospect_id=prospect.id,
            route=assessment.route,
            status="assessed",
            outcome_reason=assessment.outcome_reason,
            website_ownership=assessment.website_ownership,
            normalized_domain=normalize_domain(
                _optional_str(audit.get("final_url"))
                or _optional_str(audit.get("resolved_website_url"))
                or prospect.source_website_url
            ),
            source_payload={**dict(prospect.source_payload), "website_audit": dict(audit)},
            assessment_version=ASSESSMENT_VERSION,
            eligible=True,
            computed_route=assessment.route,
            total_score=assessment.total_score,
            category_scores=assessment.category_scores,
            rule_evidence=assessment.rule_evidence,
            forced_route_reason=assessment.forced_route_reason,
        )
        assessed_count += 1

    await store.refresh_discovery_run_aggregates(tenant_id, run_id)
    await queue.enqueue(
        {
            "job_type": "enrich_prospect_contacts",
            "tenant_id": str(tenant_id),
            "discovery_run_id": str(run_id),
        }
    )
    return AssessProspectsResult(assessed_count=assessed_count)


def _is_assessable_owned_site(row: Mapping[str, object]) -> bool:
    return (
        str(row.get("status")) == "normalized"
        and row.get("website_ownership") == "owned"
        and row.get("route") is None
        and bool(
            _optional_str(row.get("source_website_url"))
            or _optional_str(row.get("normalized_domain"))
        )
    )


def _audit_url(row: Mapping[str, object], prospect: ProspectInput) -> str:
    payload = prospect.source_payload
    return (
        _optional_str(payload.get("resolved_website_url"))
        or _optional_str(payload.get("website_final_url"))
        or prospect.source_website_url
        or f"https://{row['normalized_domain']}"
    )


def _to_input(row: Mapping[str, object]) -> ProspectInput:
    return ProspectInput(
        id=_uuid(row["id"]),
        discovery_run_id=_uuid(row["discovery_run_id"]),
        source_business_id=str(row["source_business_id"]),
        business_name=str(row["business_name"]),
        primary_category=_optional_str(row.get("primary_category")),
        additional_categories=_string_sequence(row.get("additional_categories")),
        phone=_optional_str(row.get("phone")),
        full_address=_optional_str(row.get("full_address")),
        locality=_optional_str(row.get("locality")),
        state=_optional_str(row.get("state")),
        postcode=_optional_str(row.get("postcode")),
        business_status=_optional_str(row.get("business_status")),
        rating=_decimal_or_none(row.get("rating")),
        review_count=_int_or_none(row.get("review_count")),
        source_website_url=_optional_str(row.get("source_website_url")),
        source_payload=_mapping_or_empty(row.get("source_payload")),
    )


def _uuid(value: object) -> UUID:
    return value if isinstance(value, UUID) else UUID(str(value))


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _string_sequence(value: object) -> tuple[str, ...]:
    if isinstance(value, (list, tuple)):
        return tuple(str(item) for item in value if isinstance(item, str))
    return ()


def _mapping_or_empty(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def _decimal_or_none(value: object) -> Decimal | None:
    if value is None:
        return None
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _int_or_none(value: object) -> int | None:
    if value is None:
        return None
    return int(str(value))

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol
from uuid import UUID

from clients.prospect_website_resolver import merge_website_evidence
from prospects.normalization import (
    NormalizationDecision,
    ProspectInput,
    classify_prospect,
    classify_website_ownership,
    is_owned_domain,
    normalize_domain,
    normalize_name,
    normalize_phone,
)

ASSESSMENT_VERSION = "route-a-normalization-v1"


class NormalizeProspectsError(RuntimeError):
    """Raised when a discovery run cannot safely enter normalization."""


class ProspectNormalizationStore(Protocol):
    async def get_discovery_run(
        self, *, tenant_id: UUID, discovery_run_id: UUID
    ) -> Mapping[str, object] | None: ...

    async def list_discovered_prospects(
        self, *, tenant_id: UUID, discovery_run_id: UUID
    ) -> list[Mapping[str, object]]: ...

    async def apply_prospect_normalization_with_assessment(
        self, **values: object
    ) -> Mapping[str, object]: ...

    async def refresh_discovery_run_aggregates(
        self, tenant_id: UUID, discovery_run_id: UUID
    ) -> Mapping[str, object]: ...

    async def transition_discovery_run(self, **values: object) -> Mapping[str, object] | None: ...


class ProspectQueue(Protocol):
    async def enqueue(
        self,
        payload: dict[str, object],
        *,
        delay_until: object = None,
    ) -> None: ...


class WebsiteResolver(Protocol):
    async def resolve(self, url: str) -> Mapping[str, object]: ...


@dataclass(frozen=True)
class DuplicateContext:
    matched_location_count: int
    ambiguous_duplicate: bool
    evidence: dict[str, list[str]]


async def normalize_prospects(
    payload: dict[str, object],
    *,
    store: ProspectNormalizationStore,
    queue: ProspectQueue,
    lead_repository: object | None = None,
    preview_queue: object | None = None,
    outreach_queue: object | None = None,
    instantly_client: object | None = None,
    website_resolver: WebsiteResolver | None = None,
) -> None:
    del lead_repository, preview_queue, outreach_queue, instantly_client
    tenant_id = UUID(str(payload["tenant_id"]))
    run_id = UUID(str(payload["discovery_run_id"]))
    run = await store.get_discovery_run(tenant_id=tenant_id, discovery_run_id=run_id)
    if run is None:
        raise NormalizeProspectsError("Discovery run not found for tenant")
    status = str(run.get("status"))
    if status in {"review_ready", "completed", "failed"}:
        return
    if status not in {"persisted", "processing"}:
        raise NormalizeProspectsError("Discovery run is not ready for normalization")
    if status == "persisted":
        await store.transition_discovery_run(
            tenant_id=tenant_id,
            discovery_run_id=run_id,
            to_status="processing",
        )

    rows = await store.list_discovered_prospects(
        tenant_id=tenant_id,
        discovery_run_id=run_id,
    )
    prospect_rows = [
        (row, await _resolved_input(row, _to_input(row), website_resolver)) for row in rows
    ]
    prospects = [prospect for _, prospect in prospect_rows]
    duplicate_context = _duplicate_context(prospects)
    processed_any = False
    for row, prospect in prospect_rows:
        if str(row.get("status")) != "discovered":
            continue
        context = duplicate_context[prospect.id]
        decision = classify_prospect(
            prospect,
            matched_location_count=context.matched_location_count,
            ambiguous_duplicate=context.ambiguous_duplicate,
        )
        normalized_domain = _final_domain(prospect)
        evidence = _rule_evidence(
            prospect=prospect,
            decision=decision,
            duplicate_context=context,
            normalized_domain=normalized_domain,
        )
        await store.apply_prospect_normalization_with_assessment(
            tenant_id=tenant_id,
            discovery_run_id=run_id,
            prospect_id=prospect.id,
            normalized_name=normalize_name(prospect.business_name),
            normalized_phone=normalize_phone(prospect.phone),
            normalized_domain=normalized_domain,
            website_ownership=decision.website_ownership,
            duplicate_evidence=context.evidence,
            is_franchise=decision.reason == "franchise",
            matched_location_count=context.matched_location_count,
            route=decision.route,
            status=decision.status,
            outcome_reason=decision.reason,
            source_payload=prospect.source_payload,
            assessment_version=ASSESSMENT_VERSION,
            eligible=decision.status not in {"held", "rejected"},
            computed_route=decision.route,
            rule_evidence=evidence,
            forced_route_reason=decision.reason if decision.route == "A" else None,
        )
        processed_any = True
    should_finalize = processed_any or (
        status == "processing"
        and bool(rows)
        and all(str(row.get("status")) != "discovered" for row in rows)
    )
    if should_finalize:
        await store.refresh_discovery_run_aggregates(tenant_id, run_id)
        await queue.enqueue(
            {
                "job_type": "assess_prospects",
                "tenant_id": str(tenant_id),
                "discovery_run_id": str(run_id),
            }
        )


async def _resolved_input(
    row: Mapping[str, object],
    prospect: ProspectInput,
    website_resolver: WebsiteResolver | None,
) -> ProspectInput:
    if str(row.get("status")) == "discovered":
        return await _with_website_evidence(prospect, website_resolver)
    normalized_domain = _optional_str(row.get("normalized_domain"))
    if not normalized_domain:
        return prospect
    payload = dict(prospect.source_payload)
    payload.setdefault("resolved_website_url", f"https://{normalized_domain}")
    return _replace_source_payload(prospect, payload)


async def _with_website_evidence(
    prospect: ProspectInput,
    website_resolver: WebsiteResolver | None,
) -> ProspectInput:
    if website_resolver is None or not prospect.source_website_url:
        return prospect
    if classify_website_ownership(prospect) != "owned":
        return prospect
    try:
        evidence = await website_resolver.resolve(prospect.source_website_url)
    except Exception as error:
        evidence = {
            "resolved_website_url": prospect.source_website_url,
            "website_fetch_failures": 1,
            "website_error": error.__class__.__name__,
        }
    payload = merge_website_evidence(prospect.source_payload, evidence)
    return _replace_source_payload(prospect, payload)


def _replace_source_payload(
    prospect: ProspectInput,
    payload: Mapping[str, object],
) -> ProspectInput:
    return ProspectInput(
        id=prospect.id,
        discovery_run_id=prospect.discovery_run_id,
        source_business_id=prospect.source_business_id,
        business_name=prospect.business_name,
        primary_category=prospect.primary_category,
        additional_categories=prospect.additional_categories,
        phone=prospect.phone,
        full_address=prospect.full_address,
        locality=prospect.locality,
        state=prospect.state,
        postcode=prospect.postcode,
        business_status=prospect.business_status,
        rating=prospect.rating,
        review_count=prospect.review_count,
        source_website_url=prospect.source_website_url,
        source_payload=payload,
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


def _duplicate_context(prospects: list[ProspectInput]) -> dict[UUID, DuplicateContext]:
    groups: dict[str, dict[str, list[ProspectInput]]] = {
        "phone": defaultdict(list),
        "domain": defaultdict(list),
        "name_address": defaultdict(list),
    }
    for prospect in prospects:
        phone = normalize_phone(prospect.phone)
        domain = _owned_duplicate_domain(prospect)
        name_address = _name_address_key(prospect)
        if phone:
            groups["phone"][phone].append(prospect)
        if domain:
            groups["domain"][domain].append(prospect)
        if name_address:
            groups["name_address"][name_address].append(prospect)

    result: dict[UUID, DuplicateContext] = {}
    for prospect in prospects:
        evidence: dict[str, list[str]] = {}
        matched_counts = [1]
        for group_name, values in groups.items():
            key = {
                "phone": normalize_phone(prospect.phone),
                "domain": _owned_duplicate_domain(prospect),
                "name_address": _name_address_key(prospect),
            }[group_name]
            if not key:
                continue
            siblings = values[key]
            if len(siblings) <= 1:
                continue
            matched_counts.append(len(siblings))
            evidence[group_name] = [
                sibling.source_business_id
                for sibling in siblings
                if sibling.id != prospect.id
            ]
        matched_location_count = max(matched_counts)
        ambiguous_duplicate = bool(evidence) and matched_location_count <= 3
        result[prospect.id] = DuplicateContext(
            matched_location_count=matched_location_count,
            ambiguous_duplicate=ambiguous_duplicate,
            evidence=evidence,
        )
    return result


def _rule_evidence(
    *,
    prospect: ProspectInput,
    decision: NormalizationDecision,
    duplicate_context: DuplicateContext,
    normalized_domain: str | None,
) -> dict[str, object]:
    return {
        "eligibility": {
            "status": decision.status,
            "reason": decision.reason,
            "matched_location_count": duplicate_context.matched_location_count,
            "duplicate_evidence": duplicate_context.evidence,
        },
        "website": {
            "source_url": prospect.source_website_url,
            "final_url": _resolved_url(prospect),
            "normalized_domain": normalized_domain,
            "ownership": decision.website_ownership,
            "reason": decision.reason,
        },
    }


def _final_domain(prospect: ProspectInput) -> str | None:
    return normalize_domain(_resolved_url(prospect))


def _owned_duplicate_domain(prospect: ProspectInput) -> str | None:
    resolved_url = _resolved_url(prospect)
    return normalize_domain(resolved_url) if is_owned_domain(resolved_url) else None


def _resolved_url(prospect: ProspectInput) -> str | None:
    return (
        _optional_str(prospect.source_payload.get("resolved_website_url"))
        or _optional_str(prospect.source_payload.get("website_final_url"))
        or prospect.source_website_url
    )


def _name_address_key(prospect: ProspectInput) -> str | None:
    name = normalize_name(prospect.business_name)
    address = normalize_name(prospect.full_address)
    if not name or not address:
        return None
    return f"{name}:{address}"


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

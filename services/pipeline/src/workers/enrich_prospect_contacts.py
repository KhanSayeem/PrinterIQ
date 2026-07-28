from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, Protocol
from uuid import UUID

from clients.apollo_client import (
    ApolloAPIError,
    ApolloMasterKeyRequiredError,
    ApolloNoMatch,
    ApolloRetryableError,
    ApolloVerifiedContact,
    MissingApolloAPIKeyError,
)

APOLLO_STRATEGY_VERSION = "apollo-owner-verified-v2"
ContactStatus = Literal["verified", "unverified", "no_match", "suppressed", "failed"]


class EnrichProspectContactsError(RuntimeError):
    """Raised when a discovery run cannot safely enter contact enrichment."""


class ProspectContactStore(Protocol):
    async def get_discovery_run(
        self, *, tenant_id: UUID, discovery_run_id: UUID
    ) -> Mapping[str, object] | None: ...

    async def list_discovered_prospects(
        self, *, tenant_id: UUID, discovery_run_id: UUID
    ) -> list[Mapping[str, object]]: ...

    async def get_existing_prospect_contact(
        self,
        *,
        tenant_id: UUID,
        prospect_id: UUID,
        provider: str,
        input_fingerprint: str,
    ) -> Mapping[str, object] | None: ...

    async def is_email_suppressed(self, *, tenant_id: UUID, email: str) -> bool: ...

    async def apply_prospect_contact_result(self, **values: object) -> Mapping[str, object]: ...

    async def refresh_discovery_run_aggregates(
        self, tenant_id: UUID, discovery_run_id: UUID
    ) -> Mapping[str, object]: ...


class ApolloOwnerResolver(Protocol):
    async def resolve_verified_owner(
        self,
        *,
        route: Literal["A", "B"],
        business_name: str,
        normalized_domain: str | None,
        locality: str | None,
    ) -> ApolloVerifiedContact | ApolloNoMatch | None: ...


class ProspectQueue(Protocol):
    async def enqueue(
        self,
        payload: dict[str, object],
        *,
        delay_until: object = None,
    ) -> None: ...


@dataclass(frozen=True)
class EnrichProspectContactsResult:
    enriched_count: int


async def enrich_prospect_contacts(
    payload: dict[str, object],
    *,
    store: ProspectContactStore,
    apollo_client: ApolloOwnerResolver | None,
    queue: ProspectQueue | None = None,
    lead_repository: object | None = None,
    preview_queue: object | None = None,
    outreach_queue: object | None = None,
    instantly_client: object | None = None,
    claude_client: object | None = None,
) -> EnrichProspectContactsResult:
    del lead_repository, preview_queue, outreach_queue, instantly_client, claude_client
    tenant_id = UUID(str(payload["tenant_id"]))
    run_id = UUID(str(payload["discovery_run_id"]))
    run = await store.get_discovery_run(tenant_id=tenant_id, discovery_run_id=run_id)
    if run is None:
        raise EnrichProspectContactsError("Discovery run not found for tenant")
    status = str(run.get("status"))
    if status in {"review_ready", "completed", "failed"}:
        return EnrichProspectContactsResult(enriched_count=0)
    if status != "processing":
        raise EnrichProspectContactsError("Discovery run is not ready for contact enrichment")

    rows = await store.list_discovered_prospects(
        tenant_id=tenant_id,
        discovery_run_id=run_id,
    )
    enriched_count = 0
    for row in rows:
        if not _is_contact_candidate(row):
            continue
        prospect_id = _uuid(row["id"])
        route = _route(row)
        fingerprint = input_fingerprint(row)
        existing = await store.get_existing_prospect_contact(
            tenant_id=tenant_id,
            prospect_id=prospect_id,
            provider="apollo",
            input_fingerprint=fingerprint,
        )
        if existing is not None:
            continue
        if apollo_client is None:
            await _write_failure(
                store,
                tenant_id=tenant_id,
                run_id=run_id,
                prospect_id=prospect_id,
                fingerprint=fingerprint,
                failure_code="apollo_api_key_missing",
                retry_after_seconds=None,
            )
            enriched_count += 1
            continue
        try:
            resolution = await apollo_client.resolve_verified_owner(
                route=route,
                business_name=str(row["business_name"]),
                normalized_domain=_optional_str(row.get("normalized_domain")),
                locality=_optional_str(row.get("locality")),
            )
        except ApolloMasterKeyRequiredError:
            await _write_failure(
                store,
                tenant_id=tenant_id,
                run_id=run_id,
                prospect_id=prospect_id,
                fingerprint=fingerprint,
                failure_code="apollo_master_key_required",
                retry_after_seconds=None,
            )
            enriched_count += 1
            continue
        except MissingApolloAPIKeyError:
            await _write_failure(
                store,
                tenant_id=tenant_id,
                run_id=run_id,
                prospect_id=prospect_id,
                fingerprint=fingerprint,
                failure_code="apollo_api_key_missing",
                retry_after_seconds=None,
            )
            enriched_count += 1
            continue
        except ApolloRetryableError as error:
            raise EnrichProspectContactsError(
                "Apollo contact enrichment hit a retryable provider failure"
            ) from error
        except ApolloAPIError:
            await _write_failure(
                store,
                tenant_id=tenant_id,
                run_id=run_id,
                prospect_id=prospect_id,
                fingerprint=fingerprint,
                failure_code="apollo_provider_error",
                retry_after_seconds=None,
            )
            enriched_count += 1
            continue

        if resolution is None:
            await _write_contact(
                store,
                tenant_id=tenant_id,
                run_id=run_id,
                prospect_id=prospect_id,
                fingerprint=fingerprint,
                status="no_match",
                match_evidence={
                    "strategy": APOLLO_STRATEGY_VERSION,
                    "outcome": "no_verified_owner",
                },
            )
            enriched_count += 1
            continue
        if isinstance(resolution, ApolloNoMatch):
            match_evidence = {
                **resolution.evidence,
                "provider_usage": resolution.provider_usage,
            }
            await _write_contact(
                store,
                tenant_id=tenant_id,
                run_id=run_id,
                prospect_id=prospect_id,
                fingerprint=fingerprint,
                status="no_match",
                provider_organization_id=resolution.organization_id,
                credits_consumed=_credits_consumed(resolution.provider_usage),
                match_evidence=match_evidence,
            )
            enriched_count += 1
            continue
        contact = resolution
        status_value: ContactStatus = "verified"
        match_evidence = {
            **contact.evidence,
            "provider_usage": contact.provider_usage,
        }
        if await store.is_email_suppressed(tenant_id=tenant_id, email=contact.email):
            status_value = "suppressed"
            match_evidence["suppression"] = "existing_or_inactive_contact"
        await _write_contact(
            store,
            tenant_id=tenant_id,
            run_id=run_id,
            prospect_id=prospect_id,
            fingerprint=fingerprint,
            status=status_value,
            provider_organization_id=contact.organization_id,
            provider_person_id=contact.person_id,
            person_name=contact.person_name,
            person_title=contact.person_title,
            email=contact.email,
            provider_email_status=contact.email_status,
            credits_consumed=_credits_consumed(contact.provider_usage),
            match_evidence=match_evidence,
        )
        enriched_count += 1

    await store.refresh_discovery_run_aggregates(tenant_id, run_id)
    if queue is not None:
        await queue.enqueue(
            {
                "job_type": "prepare_shadow_review",
                "tenant_id": str(tenant_id),
                "discovery_run_id": str(run_id),
            }
        )
    return EnrichProspectContactsResult(enriched_count=enriched_count)


def input_fingerprint(row: Mapping[str, object]) -> str:
    payload = {
        "strategy": APOLLO_STRATEGY_VERSION,
        "route": row.get("route"),
        "business_name": _clean(row.get("business_name")),
        "normalized_domain": _clean(row.get("normalized_domain")),
        "locality": _clean(row.get("locality")),
        "source_business_id": _clean(row.get("source_business_id")),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


async def _write_failure(
    store: ProspectContactStore,
    *,
    tenant_id: UUID,
    run_id: UUID,
    prospect_id: UUID,
    fingerprint: str,
    failure_code: str,
    retry_after_seconds: int | None,
) -> None:
    evidence: dict[str, object] = {
        "strategy": APOLLO_STRATEGY_VERSION,
        "failure_code": failure_code,
        "failure_detail": "Apollo contact enrichment could not complete; provider body omitted.",
    }
    if retry_after_seconds is not None:
        evidence["retry_after_seconds"] = retry_after_seconds
    await _write_contact(
        store,
        tenant_id=tenant_id,
        run_id=run_id,
        prospect_id=prospect_id,
        fingerprint=fingerprint,
        status="failed",
        match_evidence=evidence,
    )


async def _write_contact(
    store: ProspectContactStore,
    *,
    tenant_id: UUID,
    run_id: UUID,
    prospect_id: UUID,
    fingerprint: str,
    status: ContactStatus,
    match_evidence: Mapping[str, object],
    provider_organization_id: str | None = None,
    provider_person_id: str | None = None,
    person_name: str | None = None,
    person_title: str | None = None,
    email: str | None = None,
    provider_email_status: str | None = None,
    credits_consumed: int | None = None,
) -> None:
    await store.apply_prospect_contact_result(
        tenant_id=tenant_id,
        discovery_run_id=run_id,
        prospect_id=prospect_id,
        provider="apollo",
        input_fingerprint=fingerprint,
        provider_request_id=None,
        provider_organization_id=provider_organization_id,
        provider_person_id=provider_person_id,
        person_name=person_name,
        person_title=person_title,
        email=email,
        provider_email_status=provider_email_status,
        credits_consumed=credits_consumed,
        status=status,
        match_evidence=dict(match_evidence),
        provider_payload=None,
    )


def _is_contact_candidate(row: Mapping[str, object]) -> bool:
    return str(row.get("status")) == "assessed" and row.get("route") in {"A", "B"}


def _route(row: Mapping[str, object]) -> Literal["A", "B"]:
    route = row.get("route")
    if route == "A":
        return "A"
    if route == "B":
        return "B"
    raise EnrichProspectContactsError("Prospect route is not eligible for contact enrichment")


def _uuid(value: object) -> UUID:
    return value if isinstance(value, UUID) else UUID(str(value))


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _clean(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.casefold().split())
    return normalized or None


def _credits_consumed(provider_usage: Mapping[str, object]) -> int | None:
    value = provider_usage.get("credits")
    if value is None:
        return None
    try:
        credits = int(str(value))
    except (TypeError, ValueError):
        return None
    return max(0, credits)

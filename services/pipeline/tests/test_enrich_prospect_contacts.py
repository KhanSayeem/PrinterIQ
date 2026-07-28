from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from decimal import Decimal
from uuid import UUID

import pytest

from clients.apollo_client import (
    ApolloMasterKeyRequiredError,
    ApolloNoMatch,
    ApolloRetryableError,
    ApolloVerifiedContact,
)
from workers.enrich_prospect_contacts import APOLLO_STRATEGY_VERSION, enrich_prospect_contacts

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
RUN_ID = UUID("20000000-0000-0000-0000-000000000001")
PROSPECT_ID = UUID("30000000-0000-0000-0000-000000000001")


def prospect(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "id": PROSPECT_ID,
        "tenant_id": TENANT_ID,
        "discovery_run_id": RUN_ID,
        "source_business_id": "place-1",
        "business_name": "Northside Plumbing",
        "primary_category": "Plumber",
        "additional_categories": ["Drainage service"],
        "phone": "+61 7 3000 0000",
        "full_address": "100 Creek Street, Brisbane QLD 4000",
        "locality": "Brisbane",
        "state": "Queensland",
        "postcode": "4000",
        "business_status": "OPERATIONAL",
        "rating": Decimal("4.6"),
        "review_count": 42,
        "source_website_url": "https://northside.example",
        "normalized_domain": "northside.example",
        "website_ownership": "owned",
        "route": "B",
        "source_payload": {"resolved_website_url": "https://northside.example"},
        "status": "assessed",
    }
    values.update(overrides)
    return values


@dataclass
class Store:
    run: dict[str, object] = field(default_factory=lambda: {"status": "processing"})
    prospects: list[dict[str, object]] = field(default_factory=list)
    existing_contacts: dict[tuple[UUID, str], dict[str, object]] = field(default_factory=dict)
    suppressed_emails: set[str] = field(default_factory=set)
    writes: list[dict[str, object]] = field(default_factory=list)
    refreshed: list[tuple[UUID, UUID]] = field(default_factory=list)

    async def get_discovery_run(self, *, tenant_id: UUID, discovery_run_id: UUID):
        assert tenant_id == TENANT_ID
        assert discovery_run_id == RUN_ID
        return self.run

    async def list_discovered_prospects(self, *, tenant_id: UUID, discovery_run_id: UUID):
        assert tenant_id == TENANT_ID
        assert discovery_run_id == RUN_ID
        return self.prospects

    async def get_existing_prospect_contact(
        self,
        *,
        tenant_id: UUID,
        prospect_id: UUID,
        provider: str,
        input_fingerprint: str,
    ):
        assert tenant_id == TENANT_ID
        assert provider == "apollo"
        return self.existing_contacts.get((prospect_id, input_fingerprint))

    async def is_email_suppressed(self, *, tenant_id: UUID, email: str):
        assert tenant_id == TENANT_ID
        return email.lower() in self.suppressed_emails

    async def apply_prospect_contact_result(self, **values: object):
        assert values["tenant_id"] == TENANT_ID
        assert values["discovery_run_id"] == RUN_ID
        self.writes.append(values)
        for row in self.prospects:
            if row["id"] == values["prospect_id"]:
                row["status"] = "contact_enriched"
        return values

    async def refresh_discovery_run_aggregates(self, tenant_id: UUID, discovery_run_id: UUID):
        self.refreshed.append((tenant_id, discovery_run_id))
        return {}


@dataclass
class Apollo:
    result: ApolloVerifiedContact | ApolloNoMatch | None = None
    error: Exception | None = None
    calls: list[dict[str, object]] = field(default_factory=list)

    async def resolve_verified_owner(self, **values: object):
        self.calls.append(values)
        if self.error is not None:
            raise self.error
        return self.result


@dataclass
class Queue:
    payloads: list[dict[str, object]] = field(default_factory=list)

    async def enqueue(self, payload: dict[str, object], *, delay_until: object = None) -> None:
        del delay_until
        self.payloads.append(payload)


def verified_contact(**overrides: object) -> ApolloVerifiedContact:
    values = {
        "organization_id": "org-1",
        "person_id": "person-1",
        "person_name": "Alex Owner",
        "person_title": "Owner",
        "email": "alex@northside.example",
        "email_status": "verified",
        "evidence": {
            "organization_match": "single",
            "person_seniority": "owner",
            "strategy": APOLLO_STRATEGY_VERSION,
        },
        "provider_usage": {"requests": 3, "credits": None},
    }
    values.update(overrides)
    return ApolloVerifiedContact(**values)


def apollo_no_match(**overrides: object) -> ApolloNoMatch:
    values = {
        "organization_id": "org-rejected",
        "evidence": {
            "strategy": APOLLO_STRATEGY_VERSION,
            "outcome": "no_verified_owner",
            "rejection_reason": "rejected_organization_identity",
            "organization_match": "single_rejected_identity",
            "organization_identity": {
                "apollo_organization_name": "Breakthrough Energy",
                "apollo_organization_domain": "breakthroughenergy.org",
                "domain_match": False,
                "name_match": False,
            },
        },
        "provider_usage": {"request_count": 1, "credits": None},
    }
    values.update(overrides)
    return ApolloNoMatch(**values)


def test_verified_route_b_contact_is_stored_and_aggregates_refresh() -> None:
    async def scenario() -> None:
        store = Store(prospects=[prospect()])
        apollo = Apollo(result=verified_contact())

        result = await enrich_prospect_contacts(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            apollo_client=apollo,
        )

        assert result.enriched_count == 1
        assert apollo.calls == [
            {
                "route": "B",
                "business_name": "Northside Plumbing",
                "normalized_domain": "northside.example",
                "locality": "Brisbane",
            }
        ]
        write = store.writes[0]
        assert write["provider"] == "apollo"
        assert write["provider_organization_id"] == "org-1"
        assert write["provider_person_id"] == "person-1"
        assert write["email"] == "alex@northside.example"
        assert write["provider_email_status"] == "verified"
        assert write["status"] == "verified"
        assert write["match_evidence"]["strategy"] == APOLLO_STRATEGY_VERSION
        assert len(str(write["input_fingerprint"])) == 64
        assert store.refreshed == [(TENANT_ID, RUN_ID)]

    asyncio.run(scenario())


def test_contact_enrichment_enqueues_shadow_review_without_lead_activation() -> None:
    async def scenario() -> None:
        store = Store(prospects=[prospect()])
        queue = Queue()

        await enrich_prospect_contacts(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            apollo_client=Apollo(result=None),
            queue=queue,
            lead_repository=object(),
            preview_queue=object(),
            outreach_queue=object(),
            instantly_client=object(),
        )

        assert queue.payloads == [
            {
                "job_type": "prepare_shadow_review",
                "tenant_id": str(TENANT_ID),
                "discovery_run_id": str(RUN_ID),
            }
        ]

    asyncio.run(scenario())


def test_route_a_uses_name_and_location_without_domain() -> None:
    async def scenario() -> None:
        store = Store(prospects=[prospect(route="A", normalized_domain=None)])
        apollo = Apollo(result=None)

        await enrich_prospect_contacts(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            apollo_client=apollo,
        )

        assert apollo.calls[0]["route"] == "A"
        assert apollo.calls[0]["normalized_domain"] is None
        assert apollo.calls[0]["locality"] == "Brisbane"
        assert store.writes[0]["status"] == "no_match"
        assert store.writes[0]["provider_person_id"] is None

    asyncio.run(scenario())


def test_structured_apollo_no_match_evidence_is_stored_for_review() -> None:
    async def scenario() -> None:
        store = Store(prospects=[prospect()])

        await enrich_prospect_contacts(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            apollo_client=Apollo(result=apollo_no_match()),
        )

        write = store.writes[0]
        assert write["status"] == "no_match"
        assert write["provider_organization_id"] == "org-rejected"
        assert write["provider_person_id"] is None
        assert write["match_evidence"]["rejection_reason"] == "rejected_organization_identity"
        assert write["match_evidence"]["provider_usage"] == {"request_count": 1, "credits": None}
        assert write["match_evidence"]["organization_identity"]["apollo_organization_name"] == (
            "Breakthrough Energy"
        )

    asyncio.run(scenario())


def test_replay_uses_existing_fingerprint_without_provider_call() -> None:
    async def scenario() -> None:
        store = Store(prospects=[prospect()])
        apollo = Apollo(result=verified_contact())
        first = await enrich_prospect_contacts(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            apollo_client=apollo,
        )
        fingerprint = str(store.writes[0]["input_fingerprint"])
        store.existing_contacts[(PROSPECT_ID, fingerprint)] = store.writes[0]
        store.writes.clear()
        apollo.calls.clear()

        second = await enrich_prospect_contacts(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            apollo_client=apollo,
        )

        assert first.enriched_count == 1
        assert second.enriched_count == 0
        assert apollo.calls == []
        assert store.writes == []

    asyncio.run(scenario())


def test_suppressed_existing_email_is_not_marked_verified() -> None:
    async def scenario() -> None:
        store = Store(
            prospects=[prospect()],
            suppressed_emails={"alex@northside.example"},
        )

        await enrich_prospect_contacts(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            apollo_client=Apollo(result=verified_contact()),
        )

        assert store.writes[0]["status"] == "suppressed"
        assert store.writes[0]["match_evidence"]["suppression"] == "existing_or_inactive_contact"

    asyncio.run(scenario())


def test_capability_failure_is_actionable_failed_contact_not_no_match() -> None:
    async def scenario() -> None:
        store = Store(prospects=[prospect()])

        await enrich_prospect_contacts(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            apollo_client=Apollo(error=ApolloMasterKeyRequiredError("apollo_master_key_required")),
        )

        assert store.writes[0]["status"] == "failed"
        assert store.writes[0]["match_evidence"]["failure_code"] == "apollo_master_key_required"
        assert "secret" not in store.writes[0]["match_evidence"].get("failure_detail", "")

    asyncio.run(scenario())


def test_retryable_provider_failure_raises_for_queue_retry_without_terminal_contact() -> None:
    async def scenario() -> None:
        store = Store(prospects=[prospect()])

        with pytest.raises(
            RuntimeError,
            match="retryable provider failure",
        ):
            await enrich_prospect_contacts(
                {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
                store=store,
                apollo_client=Apollo(
                    error=ApolloRetryableError("Apollo API failed", retry_after_seconds=60)
                ),
            )

        assert store.writes == []

    asyncio.run(scenario())


def test_worker_only_resolves_route_a_and_route_b_assessed_prospects() -> None:
    async def scenario() -> None:
        store = Store(
            prospects=[
                prospect(id=UUID("30000000-0000-0000-0000-000000000001"), route="B"),
                prospect(id=UUID("30000000-0000-0000-0000-000000000002"), route="manual_review"),
                prospect(
                    id=UUID("30000000-0000-0000-0000-000000000003"),
                    status="held",
                    route=None,
                ),
            ]
        )
        apollo = Apollo(result=None)

        await enrich_prospect_contacts(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            apollo_client=apollo,
        )

        assert len(apollo.calls) == 1
        assert len(store.writes) == 1

    asyncio.run(scenario())

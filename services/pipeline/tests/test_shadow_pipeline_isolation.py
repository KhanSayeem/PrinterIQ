from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from unittest.mock import Mock
from uuid import UUID

from clients.apollo_client import ApolloVerifiedContact
from clients.outscraper_client import OutscraperRequest
from db.queries import SourceProspectUpsert
from prospects.sampling import ValidationSampleMember
from workers.assess_prospects import assess_prospects
from workers.discover_prospects import start_discovery
from workers.enrich_prospect_contacts import enrich_prospect_contacts
from workers.normalize_prospects import normalize_prospects
from workers.prepare_shadow_review import prepare_shadow_review

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
RUN_ID = UUID("20000000-0000-0000-0000-000000000001")


@dataclass
class Queue:
    enqueued: list[dict[str, object]] = field(default_factory=list)

    async def enqueue(self, payload: dict[str, object], *, delay_until: object = None) -> None:
        del delay_until
        self.enqueued.append(payload)


@dataclass
class ShadowStore:
    run: dict[str, object] = field(
        default_factory=lambda: {
            "tenant_id": TENANT_ID,
            "id": RUN_ID,
            "status": "created",
            "source_request_id": None,
        }
    )
    prospects: list[dict[str, object]] = field(default_factory=list)
    assessments: list[dict[str, object]] = field(default_factory=list)
    contacts: list[dict[str, object]] = field(default_factory=list)
    validation_members: tuple[ValidationSampleMember, ...] = ()
    refreshed: list[tuple[UUID, UUID]] = field(default_factory=list)
    leads: list[dict[str, object]] = field(default_factory=list)
    website_previews: list[dict[str, object]] = field(default_factory=list)
    outreach_sends: list[dict[str, object]] = field(default_factory=list)

    async def get_discovery_run(self, *, tenant_id: UUID, discovery_run_id: UUID):
        assert tenant_id == TENANT_ID
        assert discovery_run_id == RUN_ID
        return self.run

    async def transition_discovery_run(self, **values: object):
        assert values["tenant_id"] == TENANT_ID
        assert values["discovery_run_id"] == RUN_ID
        self.run["status"] = values["to_status"]
        if values.get("source_request_id") is not None:
            self.run["source_request_id"] = values["source_request_id"]
        if values.get("failure_code") is not None:
            self.run["failure_code"] = values["failure_code"]
        if values.get("failure_detail") is not None:
            self.run["failure_detail"] = values["failure_detail"]
        return values

    async def upsert_source_prospect(self, snapshot: SourceProspectUpsert):
        row = {
            "id": UUID(f"30000000-0000-0000-0000-{len(self.prospects) + 1:012d}"),
            "tenant_id": snapshot.tenant_id,
            "discovery_run_id": snapshot.discovery_run_id,
            "source": snapshot.source,
            "source_business_id": snapshot.source_business_id,
            "business_name": snapshot.business_name,
            "normalized_name": snapshot.normalized_name,
            "primary_category": snapshot.primary_category,
            "additional_categories": list(snapshot.additional_categories),
            "phone": snapshot.phone,
            "full_address": snapshot.full_address,
            "locality": snapshot.locality,
            "state": snapshot.state,
            "postcode": snapshot.postcode,
            "business_status": snapshot.business_status,
            "rating": snapshot.rating,
            "review_count": snapshot.review_count,
            "source_website_url": snapshot.source_website_url,
            "source_payload": dict(snapshot.source_payload),
            "status": snapshot.status,
            "route": None,
            "lead_id": None,
            "outcome_reason": snapshot.outcome_reason,
        }
        self.prospects.append(row)
        return row

    async def list_discovered_prospects(self, *, tenant_id: UUID, discovery_run_id: UUID):
        assert tenant_id == TENANT_ID
        assert discovery_run_id == RUN_ID
        return self.prospects

    async def apply_prospect_normalization_with_assessment(self, **values: object):
        row = self._prospect(values["prospect_id"])
        row.update(
            {
                "normalized_name": values["normalized_name"],
                "normalized_phone": values.get("normalized_phone"),
                "normalized_domain": values.get("normalized_domain"),
                "website_ownership": values.get("website_ownership"),
                "duplicate_evidence": values["duplicate_evidence"],
                "is_franchise": values["is_franchise"],
                "matched_location_count": values["matched_location_count"],
                "route": values.get("route"),
                "status": values["status"],
                "outcome_reason": values["outcome_reason"],
                "source_payload": values["source_payload"],
            }
        )
        self.assessments.append(values)
        return values

    async def apply_prospect_assessment_result(self, **values: object):
        row = self._prospect(values["prospect_id"])
        row.update(
            {
                "route": values["route"],
                "status": values["status"],
                "outcome_reason": values["outcome_reason"],
                "website_ownership": values["website_ownership"],
                "normalized_domain": values["normalized_domain"],
                "source_payload": values["source_payload"],
            }
        )
        self.assessments.append(values)
        return values

    async def get_existing_prospect_contact(self, **_: object):
        return None

    async def is_email_suppressed(self, *, tenant_id: UUID, email: str) -> bool:
        assert tenant_id == TENANT_ID
        del email
        return False

    async def apply_prospect_contact_result(self, **values: object):
        row = self._prospect(values["prospect_id"])
        row["status"] = "contact_enriched"
        self.contacts.append(values)
        return values

    async def list_prospects_for_shadow_review(self, *, tenant_id: UUID, discovery_run_id: UUID):
        assert tenant_id == TENANT_ID
        assert discovery_run_id == RUN_ID
        return self.prospects

    async def apply_validation_sample(self, **values: object):
        self.validation_members = values["members"]
        for member in self.validation_members:
            row = self._prospect(member.prospect_id)
            row["validation_sample"] = True
            row["validation_cohort"] = member.cohort
        return {"selected_count": len(self.validation_members)}

    async def refresh_discovery_run_aggregates(self, tenant_id: UUID, discovery_run_id: UUID):
        self.refreshed.append((tenant_id, discovery_run_id))
        return {}

    def _prospect(self, prospect_id: object) -> dict[str, object]:
        prospect_uuid = prospect_id if isinstance(prospect_id, UUID) else UUID(str(prospect_id))
        for row in self.prospects:
            if row["id"] == prospect_uuid:
                return row
        raise AssertionError(f"Unknown prospect {prospect_uuid}")


class Outscraper:
    async def submit_google_maps_search(
        self, queries: list[str], total_limit: int
    ) -> OutscraperRequest:
        assert queries
        assert total_limit == 500
        return OutscraperRequest(request_id="request-1", status="Success", data=_records())


class Resolver:
    async def resolve(self, url: str) -> dict[str, object]:
        return {
            "resolved_website_url": url,
            "website_fetch_failures": 0,
            "website_title": "Emergency plumber",
            "website_text": "Brisbane plumbing service",
        }


class Auditor:
    async def audit(self, url: str) -> dict[str, object]:
        base = {
            "final_url": url,
            "status_code": 200,
            "fetch_failures": 0,
            "title": "Emergency plumber Brisbane",
            "h1": "Emergency plumber Brisbane",
            "has_mobile_viewport": True,
            "has_horizontal_overflow": False,
            "dom_content_ms": 1200,
            "has_visible_tel_link": True,
            "has_mobile_primary_cta": True,
            "has_contact_form": True,
            "has_mailto_link": False,
            "has_emergency_or_hours_text": True,
            "displayed_phone": "07 3000 0000",
            "mentions_greater_brisbane": False,
            "named_suburbs": [],
            "has_service_area_page": False,
            "has_nap_consistency": False,
            "has_local_business_schema": False,
            "has_credentials_or_identity": False,
            "has_testimonials_or_reviews": False,
            "has_project_photos": False,
            "has_about_or_team": False,
            "has_privacy_and_contact_details": False,
            "has_service_pages_or_sections": False,
            "plumbing_services": ["blocked drain", "hot water", "gas fitting"],
            "has_meaningful_service_copy": True,
            "has_faq_or_guidance": True,
        }
        if "healthy" in url:
            base.update(
                {
                    "mentions_greater_brisbane": True,
                    "named_suburbs": ["Brisbane", "Logan", "Ipswich"],
                    "has_nap_consistency": True,
                    "has_local_business_schema": True,
                    "has_credentials_or_identity": True,
                    "has_testimonials_or_reviews": True,
                    "has_project_photos": True,
                    "has_about_or_team": True,
                    "has_privacy_and_contact_details": True,
                    "has_service_pages_or_sections": True,
                }
            )
        return base


class Apollo:
    calls: list[dict[str, object]]

    def __init__(self) -> None:
        self.calls = []

    async def resolve_verified_owner(self, **values: object):
        self.calls.append(values)
        return ApolloVerifiedContact(
            organization_id="org-1",
            person_id="person-1",
            person_name="Alex Owner",
            person_title="Owner",
            email=f"owner-{len(self.calls)}@example.com",
            email_status="verified",
            evidence={"strategy": "fixture"},
            provider_usage={"requests": 1, "credits": None},
        )


def test_full_shadow_fixture_reaches_review_ready_without_live_pipeline_activation() -> None:
    async def scenario() -> None:
        store = ShadowStore()
        queue = Queue()
        apollo = Apollo()
        forbidden = {
            "lead_repository": Mock(),
            "preview_queue": Mock(),
            "outreach_queue": Mock(),
            "instantly_client": Mock(),
            "claude_client": Mock(),
        }
        forbidden_without_claude = {
            key: value for key, value in forbidden.items() if key != "claude_client"
        }
        payload = {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)}

        await start_discovery(
            payload,
            store=store,
            queue=queue,
            outscraper_client=Outscraper(),
            now=lambda: datetime(2026, 7, 23, 12, 0, tzinfo=UTC),
        )
        await normalize_prospects(
            queue.enqueued.pop(0),
            store=store,
            queue=queue,
            website_resolver=Resolver(),
            **forbidden_without_claude,
        )
        await assess_prospects(
            queue.enqueued.pop(0),
            store=store,
            queue=queue,
            website_auditor=Auditor(),
            **forbidden,
        )
        await enrich_prospect_contacts(
            queue.enqueued.pop(0),
            store=store,
            apollo_client=apollo,
            queue=queue,
            **forbidden,
        )
        result = await prepare_shadow_review(
            queue.enqueued.pop(0),
            store=store,
            **forbidden,
        )

        assert store.run["status"] == "review_ready"
        assert result.selected_count == 3
        assert {row["route"] for row in store.prospects} == {"A", "B", "healthy"}
        assert {member.cohort for member in store.validation_members} == {
            "A",
            "B",
            "healthy_rejected",
        }
        assert len(apollo.calls) == 2
        assert store.leads == []
        assert store.website_previews == []
        assert store.outreach_sends == []
        for dependency in forbidden.values():
            dependency.assert_not_called()

    asyncio.run(scenario())


def _records() -> list[dict[str, object]]:
    return [
        {
            "place_id": "place-route-a",
            "name": "Route A Plumbing",
            "category": "Plumber",
            "subtypes": ["Drainage service"],
            "phone": "+61 7 3000 0001",
            "full_address": "1 Creek Street, Brisbane QLD 4000",
            "city": "Brisbane",
            "state": "Queensland",
            "postal_code": "4000",
            "rating": Decimal("4.8"),
            "reviews": 25,
            "business_status": "OPERATIONAL",
        },
        {
            "place_id": "place-route-b",
            "name": "Route B Plumbing",
            "category": "Plumber",
            "subtypes": ["Drainage service"],
            "phone": "+61 7 3000 0002",
            "full_address": "2 Creek Street, Brisbane QLD 4000",
            "city": "Brisbane",
            "state": "Queensland",
            "postal_code": "4000",
            "rating": Decimal("4.7"),
            "reviews": 30,
            "business_status": "OPERATIONAL",
            "site": "https://weak.example",
        },
        {
            "place_id": "place-healthy",
            "name": "Healthy Plumbing",
            "category": "Plumber",
            "subtypes": ["Drainage service"],
            "phone": "+61 7 3000 0003",
            "full_address": "3 Creek Street, Brisbane QLD 4000",
            "city": "Brisbane",
            "state": "Queensland",
            "postal_code": "4000",
            "rating": Decimal("4.9"),
            "reviews": 40,
            "business_status": "OPERATIONAL",
            "site": "https://healthy.example",
        },
    ]

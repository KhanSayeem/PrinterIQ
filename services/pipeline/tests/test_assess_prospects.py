from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from decimal import Decimal
from uuid import UUID

from workers.assess_prospects import ASSESSMENT_VERSION, assess_prospects

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
        "route": None,
        "source_payload": {"resolved_website_url": "https://northside.example"},
        "status": "normalized",
    }
    values.update(overrides)
    return values


def audit(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "final_url": "https://northside.example",
        "status_code": 200,
        "fetch_failures": 0,
        "title": "Northside Plumbing",
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
    values.update(overrides)
    return values


@dataclass
class Store:
    run: dict[str, object] = field(default_factory=lambda: {"status": "processing"})
    prospects: list[dict[str, object]] = field(default_factory=list)
    updates: list[dict[str, object]] = field(default_factory=list)
    refreshed: list[tuple[UUID, UUID]] = field(default_factory=list)

    async def get_discovery_run(self, *, tenant_id: UUID, discovery_run_id: UUID):
        assert tenant_id == TENANT_ID
        assert discovery_run_id == RUN_ID
        return self.run

    async def list_discovered_prospects(self, *, tenant_id: UUID, discovery_run_id: UUID):
        assert tenant_id == TENANT_ID
        assert discovery_run_id == RUN_ID
        return self.prospects

    async def apply_prospect_assessment_result(self, **values: object):
        assert values["tenant_id"] == TENANT_ID
        assert values["discovery_run_id"] == RUN_ID
        self.updates.append(values)
        for row in self.prospects:
            if row["id"] == values["prospect_id"]:
                row["status"] = values["status"]
                row["route"] = values["route"]
        return values

    async def refresh_discovery_run_aggregates(self, tenant_id: UUID, discovery_run_id: UUID):
        self.refreshed.append((tenant_id, discovery_run_id))
        return {}


@dataclass
class Auditor:
    response: dict[str, object]
    urls: list[str] = field(default_factory=list)

    async def audit(self, url: str):
        self.urls.append(url)
        return self.response


@dataclass
class Queue:
    enqueued: list[dict[str, object]] = field(default_factory=list)

    async def enqueue(self, payload: dict[str, object], *, delay_until: object = None) -> None:
        assert delay_until is None
        self.enqueued.append(payload)


def test_assesses_normalized_owned_sites_to_route_b_and_enqueues_contact_enrichment() -> None:
    async def scenario() -> None:
        store = Store(prospects=[prospect()])
        queue = Queue()

        result = await assess_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=queue,
            website_auditor=Auditor(audit()),
        )

        assert result.assessed_count == 1
        assert store.updates[0]["assessment_version"] == ASSESSMENT_VERSION
        assert store.updates[0]["route"] == "B"
        assert store.updates[0]["total_score"] == 59
        assert store.updates[0]["computed_route"] == "B"
        category_scores = store.updates[0]["rule_evidence"]["scoring"]["category_scores"]
        assert category_scores["technical_mobile"] == 25
        assert store.refreshed == [(TENANT_ID, RUN_ID)]
        assert queue.enqueued == [
            {
                "job_type": "enrich_prospect_contacts",
                "tenant_id": str(TENANT_ID),
                "discovery_run_id": str(RUN_ID),
            }
        ]

    asyncio.run(scenario())


def test_non_owned_audit_destination_is_assessed_as_route_a_handback() -> None:
    async def scenario() -> None:
        store = Store(prospects=[prospect()])

        await assess_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=Queue(),
            website_auditor=Auditor(audit(final_url="https://facebook.com/northside")),
        )

        assert store.updates[0]["route"] == "A"
        assert store.updates[0]["website_ownership"] == "social"
        assert store.updates[0]["total_score"] is None

    asyncio.run(scenario())


def test_worker_persists_route_b_manual_and_healthy_threshold_boundaries() -> None:
    async def scenario() -> None:
        fixtures = [
            (
                "30000000-0000-0000-0000-000000000059",
                audit(),
                59,
                "B",
            ),
            (
                "30000000-0000-0000-0000-000000000060",
                audit(
                    has_service_pages_or_sections=True,
                    has_meaningful_service_copy=False,
                    has_faq_or_guidance=False,
                ),
                60,
                "manual_review",
            ),
            (
                "30000000-0000-0000-0000-000000000069",
                audit(
                    mentions_greater_brisbane=True,
                    has_local_business_schema=True,
                ),
                69,
                "manual_review",
            ),
            (
                "30000000-0000-0000-0000-000000000070",
                audit(
                    mentions_greater_brisbane=True,
                    has_project_photos=True,
                    has_about_or_team=True,
                ),
                70,
                "healthy",
            ),
        ]
        for prospect_id, audit_response, expected_score, expected_route in fixtures:
            store = Store(prospects=[prospect(id=UUID(prospect_id))])
            await assess_prospects(
                {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
                store=store,
                queue=Queue(),
                website_auditor=Auditor(audit_response),
            )

            assert store.updates[0]["total_score"] == expected_score
            assert store.updates[0]["route"] == expected_route

    asyncio.run(scenario())


def test_replay_skips_already_assessed_prospects_without_spending_audit_calls() -> None:
    async def scenario() -> None:
        auditor = Auditor(audit())
        store = Store(prospects=[prospect(status="assessed", route="B")])

        result = await assess_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=Queue(),
            website_auditor=auditor,
        )

        assert result.assessed_count == 0
        assert auditor.urls == []
        assert store.updates == []

    asyncio.run(scenario())


def test_assessment_refuses_live_pipeline_dependencies() -> None:
    async def scenario() -> None:
        store = Store(prospects=[prospect()])

        await assess_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=Queue(),
            website_auditor=Auditor(audit()),
            lead_repository=object(),
            preview_queue=object(),
            outreach_queue=object(),
            instantly_client=object(),
            claude_client=object(),
        )

        assert store.updates[0]["assessment_version"] == ASSESSMENT_VERSION

    asyncio.run(scenario())

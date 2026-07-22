from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from decimal import Decimal
from uuid import UUID

from workers.normalize_prospects import normalize_prospects

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
RUN_ID = UUID("20000000-0000-0000-0000-000000000001")


def prospect(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "id": UUID("30000000-0000-0000-0000-000000000001"),
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
        "source_website_url": None,
        "source_payload": {},
    }
    values.update(overrides)
    return values


@dataclass
class Store:
    run: dict[str, object] = field(
        default_factory=lambda: {"status": "persisted", "source_request_id": "request-123"}
    )
    prospects: list[dict[str, object]] = field(default_factory=list)
    updates: list[dict[str, object]] = field(default_factory=list)
    assessments: list[dict[str, object]] = field(default_factory=list)
    transitions: list[dict[str, object]] = field(default_factory=list)
    refreshed: list[tuple[UUID, UUID]] = field(default_factory=list)

    async def get_discovery_run(self, *, tenant_id: UUID, discovery_run_id: UUID):
        assert tenant_id == TENANT_ID
        assert discovery_run_id == RUN_ID
        return self.run

    async def list_discovered_prospects(self, *, tenant_id: UUID, discovery_run_id: UUID):
        assert tenant_id == TENANT_ID
        assert discovery_run_id == RUN_ID
        return self.prospects

    async def apply_prospect_normalization(self, **values: object):
        assert values["tenant_id"] == TENANT_ID
        assert values["discovery_run_id"] == RUN_ID
        self.updates.append(values)
        return values

    async def upsert_prospect_assessment(self, **values: object):
        assert values["tenant_id"] == TENANT_ID
        assert values["discovery_run_id"] == RUN_ID
        self.assessments.append(values)
        return values

    async def refresh_discovery_run_aggregates(self, tenant_id: UUID, discovery_run_id: UUID):
        self.refreshed.append((tenant_id, discovery_run_id))
        return {}

    async def transition_discovery_run(self, **values: object):
        self.transitions.append(values)
        self.run["status"] = values["to_status"]
        return values


@dataclass
class Queue:
    enqueued: list[dict[str, object]] = field(default_factory=list)

    async def enqueue(self, payload: dict[str, object], *, delay_until: object = None) -> None:
        assert delay_until is None
        self.enqueued.append(payload)


def test_social_only_record_is_assessed_route_a_and_shadow_pipeline_stops() -> None:
    async def scenario() -> None:
        store = Store(
            prospects=[
                prospect(
                    source_website_url="https://facebook.com/northsideplumbing",
                    source_payload={"place_id": "place-1", "name": "Northside Plumbing"},
                )
            ]
        )
        queue = Queue()

        await normalize_prospects(
            {
                "tenant_id": str(TENANT_ID),
                "discovery_run_id": str(RUN_ID),
            },
            store=store,
            queue=queue,
        )

        assert store.updates[0]["status"] == "assessed"
        assert store.updates[0]["route"] == "A"
        assert store.updates[0]["website_ownership"] == "social"
        assert store.updates[0]["outcome_reason"] == "no_owned_website"
        assert store.assessments[0]["computed_route"] == "A"
        assert store.assessments[0]["rule_evidence"]["website"]["ownership"] == "social"
        assert queue.enqueued == [
            {
                "job_type": "assess_prospects",
                "tenant_id": str(TENANT_ID),
                "discovery_run_id": str(RUN_ID),
            }
        ]

    asyncio.run(scenario())


def test_batch_holds_ambiguous_secondary_matches_instead_of_merging() -> None:
    async def scenario() -> None:
        first = prospect(
            id=UUID("30000000-0000-0000-0000-000000000001"),
            source_business_id="place-1",
            business_name="Northside Plumbing",
            phone="+61 7 3000 0000",
            source_website_url="https://northside.example",
        )
        second = prospect(
            id=UUID("30000000-0000-0000-0000-000000000002"),
            source_business_id="place-2",
            business_name="Northside Plumbing Co",
            phone="+61 7 3000 0000",
            full_address="200 Creek Street, Brisbane QLD 4000",
            source_website_url="https://northside-alt.example",
        )
        store = Store(prospects=[first, second])

        await normalize_prospects(
            {
                "tenant_id": str(TENANT_ID),
                "discovery_run_id": str(RUN_ID),
            },
            store=store,
            queue=Queue(),
        )

        assert [update["status"] for update in store.updates] == ["held", "held"]
        assert [update["outcome_reason"] for update in store.updates] == [
            "ambiguous_duplicate",
            "ambiguous_duplicate",
        ]
        assert all("phone" in update["duplicate_evidence"] for update in store.updates)

    asyncio.run(scenario())


def test_four_matched_locations_are_held_with_stable_location_count() -> None:
    async def scenario() -> None:
        rows = [
            prospect(
                id=UUID(f"30000000-0000-0000-0000-{index:012d}"),
                source_business_id=f"place-{index}",
                business_name="Same Domain Plumbing",
                phone=f"+61 7 3000 000{index}",
                source_website_url="https://samedomain.example",
                full_address=f"{index} Creek Street, Brisbane QLD 4000",
            )
            for index in range(1, 5)
        ]
        store = Store(prospects=rows)

        await normalize_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=Queue(),
        )

        assert {update["outcome_reason"] for update in store.updates} == {"too_many_locations"}
        assert {update["matched_location_count"] for update in store.updates} == {4}

    asyncio.run(scenario())


def test_normalization_refuses_to_call_lead_preview_outreach_or_instantly_dependencies() -> None:
    async def scenario() -> None:
        store = Store(prospects=[prospect(source_website_url=None)])

        await normalize_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=Queue(),
            lead_repository=object(),
            preview_queue=object(),
            outreach_queue=object(),
            instantly_client=object(),
        )

        assert store.updates[0]["route"] == "A"

    asyncio.run(scenario())

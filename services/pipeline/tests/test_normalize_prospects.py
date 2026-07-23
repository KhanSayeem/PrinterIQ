from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from math import ceil
from pathlib import Path
from uuid import UUID

from clients.prospect_website_resolver import (
    DEFAULT_RETRY_DELAY_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
)
from workers.discover_prospects import DISCOVERY_TOTAL_LIMIT, _source_snapshot
from workers.normalize_prospects import (
    MAX_WEBSITE_RESOLUTION_CONCURRENCY,
    normalize_prospects,
)

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
RUN_ID = UUID("20000000-0000-0000-0000-000000000001")
SOCIAL_PROVIDER_FIXTURE = (
    Path(__file__).parent / "fixtures" / "route_a_social_provider_record.json"
)


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
        "status": "discovered",
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

    async def apply_prospect_normalization_with_assessment(self, **values: object):
        assert values["tenant_id"] == TENANT_ID
        assert values["discovery_run_id"] == RUN_ID
        self.updates.append(values)
        self.assessments.append(values)
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


def test_persisted_provider_social_fixture_normalizes_to_visible_route_a_evidence() -> None:
    async def scenario() -> None:
        record = json.loads(SOCIAL_PROVIDER_FIXTURE.read_text(encoding="utf-8"))
        snapshot = _source_snapshot(
            record,
            tenant_id=TENANT_ID,
            run_id=RUN_ID,
            now=datetime(2026, 7, 23, 0, 0, tzinfo=UTC),
            raw_retention_days=30,
        )
        store = Store(
            prospects=[
                prospect(
                    source_business_id=snapshot.source_business_id,
                    business_name=snapshot.business_name,
                    primary_category=snapshot.primary_category,
                    additional_categories=snapshot.additional_categories,
                    phone=snapshot.phone,
                    full_address=snapshot.full_address,
                    locality=snapshot.locality,
                    state=snapshot.state,
                    postcode=snapshot.postcode,
                    business_status=snapshot.business_status,
                    rating=snapshot.rating,
                    review_count=snapshot.review_count,
                    source_website_url=snapshot.source_website_url,
                    source_payload=snapshot.source_payload,
                )
            ]
        )

        await normalize_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=Queue(),
        )

        dashboard_view = {
            "businessName": store.updates[0]["normalized_name"],
            "route": store.updates[0]["route"],
            "status": store.updates[0]["status"],
            "websiteOwnership": store.updates[0]["website_ownership"],
            "outcomeReason": store.updates[0]["outcome_reason"],
            "sourceWebsiteUrl": snapshot.source_website_url,
            "normalizedDomain": store.updates[0]["normalized_domain"],
            "matchedLocationCount": store.updates[0]["matched_location_count"],
            "duplicateEvidence": store.updates[0]["duplicate_evidence"],
            "ruleEvidence": store.assessments[0]["rule_evidence"],
        }

        assert dashboard_view["route"] == "A"
        assert dashboard_view["status"] == "assessed"
        assert dashboard_view["websiteOwnership"] == "social"
        assert dashboard_view["outcomeReason"] == "no_owned_website"
        assert dashboard_view["sourceWebsiteUrl"] == record["site"]
        assert dashboard_view["ruleEvidence"]["website"]["final_url"] == record["site"]

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


def test_shared_social_hosts_do_not_create_duplicate_holds() -> None:
    async def scenario() -> None:
        rows = [
            prospect(
                id=UUID(f"30000000-0000-0000-0000-{index:012d}"),
                source_business_id=f"place-{index}",
                business_name=f"Independent Plumbing {index}",
                phone=f"+61 7 3000 00{index:02d}",
                full_address=f"{index} Creek Street, Brisbane QLD 4000",
                source_website_url=f"https://facebook.com/independentplumbing{index}",
            )
            for index in range(1, 5)
        ]
        store = Store(prospects=rows)

        await normalize_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=Queue(),
        )

        assert {update["outcome_reason"] for update in store.updates} == {"no_owned_website"}
        assert {update["matched_location_count"] for update in store.updates} == {1}
        assert all("domain" not in update["duplicate_evidence"] for update in store.updates)

    asyncio.run(scenario())


def test_redirect_resolved_owned_domains_participate_in_duplicate_context() -> None:
    class Resolver:
        async def resolve(self, url: str) -> dict[str, object]:
            return {
                "resolved_website_url": {
                    "https://booking-one.example": "https://northsideplumbing.com.au",
                    "https://booking-two.example": "https://northsideplumbing.com.au/contact",
                }[url],
                "website_fetch_failures": 0,
                "website_title": "Northside Plumbing",
                "website_text": "Emergency plumber",
            }

    async def scenario() -> None:
        store = Store(
            prospects=[
                prospect(
                    id=UUID("30000000-0000-0000-0000-000000000001"),
                    source_business_id="place-1",
                    source_website_url="https://booking-one.example",
                    phone="+61 7 3000 0001",
                ),
                prospect(
                    id=UUID("30000000-0000-0000-0000-000000000002"),
                    source_business_id="place-2",
                    source_website_url="https://booking-two.example",
                    phone="+61 7 3000 0002",
                ),
            ]
        )

        await normalize_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=Queue(),
            website_resolver=Resolver(),
        )

        assert [update["status"] for update in store.updates] == ["held", "held"]
        assert {update["outcome_reason"] for update in store.updates} == {
            "ambiguous_duplicate"
        }
        assert all(
            update["normalized_domain"] == "northsideplumbing.com.au"
            for update in store.updates
        )
        assert all("domain" in update["duplicate_evidence"] for update in store.updates)

    asyncio.run(scenario())


def test_name_address_only_duplicates_are_held_for_review() -> None:
    async def scenario() -> None:
        rows = [
            prospect(
                id=UUID("30000000-0000-0000-0000-000000000001"),
                source_business_id="place-1",
                phone=None,
                source_website_url=None,
                business_name="Northside Plumbing Pty Ltd",
                full_address="100 Creek Street, Brisbane QLD 4000",
            ),
            prospect(
                id=UUID("30000000-0000-0000-0000-000000000002"),
                source_business_id="place-2",
                phone=None,
                source_website_url=None,
                business_name="Northside Plumbing Pty. Ltd.",
                full_address="100 Creek Street, Brisbane QLD 4000",
            ),
        ]
        store = Store(prospects=rows)

        await normalize_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=Queue(),
        )

        assert [update["status"] for update in store.updates] == ["held", "held"]
        assert all(update["outcome_reason"] == "ambiguous_duplicate" for update in store.updates)
        assert all("name_address" in update["duplicate_evidence"] for update in store.updates)

    asyncio.run(scenario())


def test_unexpected_resolver_exception_becomes_held_resolver_error_evidence() -> None:
    class BrokenResolver:
        async def resolve(self, url: str) -> dict[str, object]:
            assert url == "https://northside.example"
            raise RuntimeError("unexpected parser failure")

    async def scenario() -> None:
        store = Store(prospects=[prospect(source_website_url="https://northside.example")])

        await normalize_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=Queue(),
            website_resolver=BrokenResolver(),
        )

        assert store.updates[0]["status"] == "held"
        assert store.updates[0]["route"] is None
        assert store.updates[0]["outcome_reason"] == "resolver_error"
        assert store.updates[0]["source_payload"]["website_fetch_failures"] == 1
        assert store.updates[0]["source_payload"]["website_error"] == "resolver_exception"
        assert store.assessments[0]["eligible"] is False

    asyncio.run(scenario())


def test_website_resolution_is_concurrent_before_duplicate_context() -> None:
    class ConcurrentResolver:
        def __init__(self) -> None:
            self.active = 0
            self.max_active = 0

        async def resolve(self, url: str) -> dict[str, object]:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            await asyncio.sleep(0.01)
            self.active -= 1
            return {
                "resolved_website_url": url,
                "website_fetch_failures": 0,
                "website_title": "Owned website",
                "website_text": "Emergency plumber",
            }

    async def scenario() -> None:
        resolver = ConcurrentResolver()
        store = Store(
            prospects=[
                prospect(
                    id=UUID(f"30000000-0000-0000-0000-{index:012d}"),
                    source_business_id=f"place-{index}",
                    phone=f"+61 7 3000 {index:04d}",
                    source_website_url=f"https://owned-{index}.example",
                )
                for index in range(30)
            ]
        )

        await normalize_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=Queue(),
            website_resolver=resolver,
        )

        assert resolver.max_active > 1
        assert len(store.updates) == 30

    asyncio.run(scenario())


def test_resolution_concurrency_keeps_full_batch_under_stale_lease_budget() -> None:
    stale_lease_seconds = 10 * 60
    worst_case_attempt_window = (
        2 * (DEFAULT_TIMEOUT_SECONDS + DEFAULT_TIMEOUT_SECONDS)
        + DEFAULT_RETRY_DELAY_SECONDS
    )
    worst_case_full_batch_seconds = (
        ceil(DISCOVERY_TOTAL_LIMIT / MAX_WEBSITE_RESOLUTION_CONCURRENCY)
        * worst_case_attempt_window
    )

    assert worst_case_full_batch_seconds < stale_lease_seconds


def test_partial_batch_replay_keeps_duplicate_decisions_and_does_not_reenqueue_twice() -> None:
    @dataclass
    class ReplayStore(Store):
        fail_after_updates: int | None = 1

        async def list_discovered_prospects(self, *, tenant_id: UUID, discovery_run_id: UUID):
            assert tenant_id == TENANT_ID
            assert discovery_run_id == RUN_ID
            return self.prospects

        async def apply_prospect_normalization_with_assessment(self, **values: object):
            await super().apply_prospect_normalization_with_assessment(**values)
            for row in self.prospects:
                if row["id"] == values["prospect_id"]:
                    row["status"] = values["status"]
                    row["outcome_reason"] = values["outcome_reason"]
                    row["matched_location_count"] = values["matched_location_count"]
                    row["duplicate_evidence"] = values["duplicate_evidence"]
                    break
            if self.fail_after_updates is not None and len(self.updates) >= self.fail_after_updates:
                self.fail_after_updates = None
                raise RuntimeError("simulated crash after partial batch")
            return values

    async def scenario() -> None:
        first = prospect(
            id=UUID("30000000-0000-0000-0000-000000000001"),
            source_business_id="place-1",
            phone="+61 7 3000 0000",
            source_website_url="https://northside.example",
        )
        second = prospect(
            id=UUID("30000000-0000-0000-0000-000000000002"),
            source_business_id="place-2",
            phone="+61 7 3000 0000",
            source_website_url="https://northside-alt.example",
        )
        store = ReplayStore(prospects=[first, second])
        queue = Queue()

        try:
            await normalize_prospects(
                {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
                store=store,
                queue=queue,
            )
        except RuntimeError as error:
            assert str(error) == "simulated crash after partial batch"

        await normalize_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=queue,
        )

        outcomes = {row["source_business_id"]: row["outcome_reason"] for row in store.prospects}
        assert outcomes == {
            "place-1": "ambiguous_duplicate",
            "place-2": "ambiguous_duplicate",
        }
        assert queue.enqueued == [
            {
                "job_type": "assess_prospects",
                "tenant_id": str(TENANT_ID),
                "discovery_run_id": str(RUN_ID),
            }
        ]

    asyncio.run(scenario())


def test_atomic_normalization_crash_persists_assessment_before_replay_skip() -> None:
    @dataclass
    class CrashAfterAtomicWriteStore(Store):
        async def apply_prospect_normalization_with_assessment(self, **values: object):
            await super().apply_prospect_normalization_with_assessment(**values)
            for row in self.prospects:
                if row["id"] == values["prospect_id"]:
                    row["status"] = values["status"]
                    row["outcome_reason"] = values["outcome_reason"]
                    break
            raise RuntimeError("simulated crash after atomic normalization")

    async def scenario() -> None:
        store = CrashAfterAtomicWriteStore(prospects=[prospect(source_website_url=None)])

        try:
            await normalize_prospects(
                {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
                store=store,
                queue=Queue(),
            )
        except RuntimeError as error:
            assert str(error) == "simulated crash after atomic normalization"

        assert store.prospects[0]["status"] == "assessed"
        assert store.assessments[0]["assessment_version"] == "route-a-normalization-v1"
        assert store.assessments[0]["computed_route"] == "A"

    asyncio.run(scenario())


def test_processing_replay_with_no_discovered_rows_refreshes_and_enqueues_assessment() -> None:
    async def scenario() -> None:
        store = Store(
            run={"status": "processing", "source_request_id": "request-123"},
            prospects=[
                prospect(
                    status="assessed",
                    outcome_reason="no_owned_website",
                    source_website_url=None,
                )
            ],
        )
        queue = Queue()

        await normalize_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=queue,
        )

        assert store.updates == []
        assert store.assessments == []
        assert store.refreshed == [(TENANT_ID, RUN_ID)]
        assert queue.enqueued == [
            {
                "job_type": "assess_prospects",
                "tenant_id": str(TENANT_ID),
                "discovery_run_id": str(RUN_ID),
            }
        ]

    asyncio.run(scenario())


def test_normalization_produces_redirect_placeholder_and_inaccessible_website_evidence() -> None:
    class Resolver:
        async def resolve(self, url: str) -> dict[str, object]:
            assert url == "https://northside.example"
            return {
                "resolved_website_url": "https://facebook.com/northsideplumbing",
                "website_fetch_failures": 0,
                "website_title": "Northside Plumbing on Facebook",
                "website_text": "Northside Plumbing",
            }

    async def scenario() -> None:
        store = Store(prospects=[prospect(source_website_url="https://northside.example")])

        await normalize_prospects(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
            queue=Queue(),
            website_resolver=Resolver(),
        )

        assert store.updates[0]["status"] == "assessed"
        assert store.updates[0]["website_ownership"] == "social"
        assert store.assessments[0]["rule_evidence"]["website"]["final_url"] == (
            "https://facebook.com/northsideplumbing"
        )

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

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import cast
from uuid import UUID

import pytest

from prospects.sampling import ValidationSampleMember
from workers.prepare_shadow_review import prepare_shadow_review

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
RUN_ID = UUID("20000000-0000-0000-0000-000000000001")


def prospect(index: int, *, route: str | None, status: str = "assessed") -> dict[str, object]:
    return {
        "id": UUID(f"30000000-0000-0000-0000-{index:012d}"),
        "route": route,
        "status": status,
    }


@dataclass
class Store:
    run: dict[str, object] = field(default_factory=lambda: {"status": "processing"})
    prospects: list[dict[str, object]] = field(default_factory=list)
    applied_members: tuple[ValidationSampleMember, ...] = ()
    transitions: list[dict[str, object]] = field(default_factory=list)
    refreshed: list[tuple[UUID, UUID]] = field(default_factory=list)

    async def get_discovery_run(self, *, tenant_id: UUID, discovery_run_id: UUID):
        assert tenant_id == TENANT_ID
        assert discovery_run_id == RUN_ID
        return self.run

    async def list_prospects_for_shadow_review(self, *, tenant_id: UUID, discovery_run_id: UUID):
        assert tenant_id == TENANT_ID
        assert discovery_run_id == RUN_ID
        return self.prospects

    async def apply_validation_sample(self, **values: object):
        assert values["tenant_id"] == TENANT_ID
        assert values["discovery_run_id"] == RUN_ID
        self.applied_members = cast(tuple[ValidationSampleMember, ...], values["members"])
        return {"selected_count": len(self.applied_members)}

    async def refresh_discovery_run_aggregates(self, tenant_id: UUID, discovery_run_id: UUID):
        self.refreshed.append((tenant_id, discovery_run_id))
        return {}

    async def transition_discovery_run(self, **values: object):
        self.transitions.append(values)
        return values


def test_prepare_shadow_review_persists_sixty_member_sample_and_marks_run_ready() -> None:
    async def scenario() -> None:
        store = Store(
            prospects=[
                *[prospect(index, route="A") for index in range(1, 25)],
                *[prospect(index, route="B") for index in range(31, 55)],
                *[prospect(index, route="healthy") for index in range(61, 85)],
            ]
        )

        result = await prepare_shadow_review(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
        )

        assert result.selected_count == 60
        assert result.insufficient_sample is False
        assert store.refreshed == [(TENANT_ID, RUN_ID)]
        assert store.transitions[0]["to_status"] == "review_ready"
        assert store.transitions[0]["failure_code"] is None
        assert sum(1 for member in store.applied_members if member.cohort == "A") == 20
        assert sum(1 for member in store.applied_members if member.cohort == "B") == 20
        assert (
            sum(1 for member in store.applied_members if member.cohort == "healthy_rejected")
            == 20
        )

    asyncio.run(scenario())


def test_prepare_shadow_review_keeps_undersized_run_reviewable_but_insufficient() -> None:
    async def scenario() -> None:
        store = Store(
            prospects=[
                *[prospect(index, route="A") for index in range(1, 5)],
                *[prospect(index, route="B") for index in range(31, 55)],
                *[prospect(index, route=None, status="rejected") for index in range(61, 85)],
            ]
        )

        result = await prepare_shadow_review(
            {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
            store=store,
        )

        assert result.selected_count == 44
        assert result.insufficient_sample is True
        assert store.transitions[0]["to_status"] == "review_ready"
        assert store.transitions[0]["failure_code"] == "insufficient_sample"
        assert "A=4" in str(store.transitions[0]["failure_detail"])

    asyncio.run(scenario())


def test_prepare_shadow_review_rejects_unexpected_run_state() -> None:
    async def scenario() -> None:
        store = Store(run={"status": "persisted"})

        with pytest.raises(RuntimeError, match="not ready"):
            await prepare_shadow_review(
                {"tenant_id": str(TENANT_ID), "discovery_run_id": str(RUN_ID)},
                store=store,
            )

    asyncio.run(scenario())

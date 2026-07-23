from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from prospects.sampling import (
    VALIDATION_COHORTS,
    ValidationSampleMember,
    ValidationSampleSelection,
    select_validation_sample,
)


class PrepareShadowReviewError(RuntimeError):
    """Raised when a discovery run cannot safely enter shadow review."""


class ShadowReviewStore(Protocol):
    async def get_discovery_run(
        self, *, tenant_id: UUID, discovery_run_id: UUID
    ) -> Mapping[str, object] | None: ...

    async def list_prospects_for_shadow_review(
        self, *, tenant_id: UUID, discovery_run_id: UUID
    ) -> list[Mapping[str, object]]: ...

    async def apply_validation_sample(
        self,
        *,
        tenant_id: UUID,
        discovery_run_id: UUID,
        members: tuple[ValidationSampleMember, ...],
    ) -> Mapping[str, object]: ...

    async def refresh_discovery_run_aggregates(
        self, tenant_id: UUID, discovery_run_id: UUID
    ) -> Mapping[str, object]: ...

    async def transition_discovery_run(self, **values: object) -> Mapping[str, object] | None: ...


@dataclass(frozen=True)
class PrepareShadowReviewResult:
    selected_count: int
    insufficient_sample: bool


async def prepare_shadow_review(
    payload: dict[str, object],
    *,
    store: ShadowReviewStore,
    lead_repository: object | None = None,
    preview_queue: object | None = None,
    outreach_queue: object | None = None,
    instantly_client: object | None = None,
    claude_client: object | None = None,
) -> PrepareShadowReviewResult:
    del lead_repository, preview_queue, outreach_queue, instantly_client, claude_client
    tenant_id = UUID(str(payload["tenant_id"]))
    run_id = UUID(str(payload["discovery_run_id"]))
    run = await store.get_discovery_run(tenant_id=tenant_id, discovery_run_id=run_id)
    if run is None:
        raise PrepareShadowReviewError("Discovery run not found for tenant")
    status = str(run.get("status"))
    if status in {"review_ready", "completed", "failed"}:
        return PrepareShadowReviewResult(selected_count=0, insufficient_sample=False)
    if status != "processing":
        raise PrepareShadowReviewError("Discovery run is not ready for shadow review")

    rows = await store.list_prospects_for_shadow_review(
        tenant_id=tenant_id,
        discovery_run_id=run_id,
    )
    selection = select_validation_sample(rows, run_id=run_id)
    await store.apply_validation_sample(
        tenant_id=tenant_id,
        discovery_run_id=run_id,
        members=selection.members,
    )
    await store.refresh_discovery_run_aggregates(tenant_id, run_id)
    await store.transition_discovery_run(
        tenant_id=tenant_id,
        discovery_run_id=run_id,
        to_status="review_ready",
        failure_code="insufficient_sample" if selection.insufficient_cohorts else None,
        failure_detail=_insufficient_detail(selection),
    )
    return PrepareShadowReviewResult(
        selected_count=len(selection.members),
        insufficient_sample=bool(selection.insufficient_cohorts),
    )


def _insufficient_detail(selection: ValidationSampleSelection) -> str | None:
    if not selection.insufficient_cohorts:
        return None
    parts = [
        f"{cohort}={selection.cohort_sizes[cohort]}"
        for cohort in VALIDATION_COHORTS
    ]
    return "Validation sample insufficient for passing gates: " + ", ".join(parts)

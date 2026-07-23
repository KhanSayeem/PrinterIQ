from __future__ import annotations

import hashlib
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

ValidationCohort = Literal["A", "B", "healthy_rejected"]
SAMPLE_SIZE_PER_COHORT = 20
VALIDATION_COHORTS: tuple[ValidationCohort, ...] = ("A", "B", "healthy_rejected")


@dataclass(frozen=True)
class ValidationSampleMember:
    prospect_id: UUID
    cohort: ValidationCohort
    key: str


@dataclass(frozen=True)
class ValidationSampleSelection:
    members: tuple[ValidationSampleMember, ...]
    cohort_sizes: dict[ValidationCohort, int]
    insufficient_cohorts: tuple[ValidationCohort, ...]


def sample_key(run_id: UUID, prospect_id: UUID, cohort: str) -> str:
    return hashlib.sha256(f"{run_id}:{prospect_id}:{cohort}".encode()).hexdigest()


def select_validation_sample(
    prospects: Sequence[Mapping[str, object]],
    *,
    run_id: UUID,
    size_per_cohort: int = SAMPLE_SIZE_PER_COHORT,
) -> ValidationSampleSelection:
    cohorts: dict[ValidationCohort, list[ValidationSampleMember]] = defaultdict(list)
    for row in prospects:
        prospect_id = _uuid(row["id"])
        cohort_value = validation_cohort(row)
        if cohort_value is None:
            continue
        cohort = cohort_value
        cohorts[cohort].append(
            ValidationSampleMember(
                prospect_id=prospect_id,
                cohort=cohort,
                key=sample_key(run_id, prospect_id, cohort),
            )
        )

    selected: list[ValidationSampleMember] = []
    cohort_sizes: dict[ValidationCohort, int] = {
        "A": len(cohorts["A"]),
        "B": len(cohorts["B"]),
        "healthy_rejected": len(cohorts["healthy_rejected"]),
    }
    insufficient: list[ValidationCohort] = []
    for cohort in VALIDATION_COHORTS:
        members = sorted(cohorts[cohort], key=lambda member: member.key)
        if len(members) < size_per_cohort:
            insufficient.append(cohort)
        selected.extend(members[:size_per_cohort])

    return ValidationSampleSelection(
        members=tuple(selected),
        cohort_sizes=cohort_sizes,
        insufficient_cohorts=tuple(insufficient),
    )


def validation_cohort(row: Mapping[str, object]) -> ValidationCohort | None:
    route = row.get("route")
    if route == "A":
        return "A"
    if route == "B":
        return "B"
    if route == "healthy" or row.get("status") == "rejected":
        return "healthy_rejected"
    return None


def _uuid(value: object) -> UUID:
    return value if isinstance(value, UUID) else UUID(str(value))

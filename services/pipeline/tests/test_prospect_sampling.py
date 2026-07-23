from uuid import UUID

from prospects.sampling import sample_key, select_validation_sample, validation_cohort

RUN_ID = UUID("20000000-0000-0000-0000-000000000001")


def prospect(index: int, *, route: str | None, status: str = "assessed") -> dict[str, object]:
    return {
        "id": UUID(f"30000000-0000-0000-0000-{index:012d}"),
        "route": route,
        "status": status,
    }


def test_sample_key_matches_the_reproducible_run_prospect_cohort_contract() -> None:
    prospect_id = UUID("30000000-0000-0000-0000-000000000001")

    assert sample_key(RUN_ID, prospect_id, "A") == (
        "08606f3f3286b8971f8716fa7eefb030e4c42c8526349c93ea12e2cbc72688e1"
    )


def test_validation_cohort_uses_routes_and_rejected_records_only() -> None:
    assert validation_cohort(prospect(1, route="A")) == "A"
    assert validation_cohort(prospect(2, route="B")) == "B"
    assert validation_cohort(prospect(3, route="healthy")) == "healthy_rejected"
    assert validation_cohort(prospect(4, route=None, status="rejected")) == "healthy_rejected"
    assert validation_cohort(prospect(5, route="manual_review")) is None


def test_select_validation_sample_picks_twenty_per_large_enough_cohort_deterministically() -> None:
    rows = [
        *[prospect(index, route="A") for index in range(1, 31)],
        *[prospect(index, route="B") for index in range(31, 61)],
        *[prospect(index, route="healthy") for index in range(61, 91)],
    ]

    first = select_validation_sample(rows, run_id=RUN_ID)
    second = select_validation_sample(list(reversed(rows)), run_id=RUN_ID)

    assert first == second
    assert len(first.members) == 60
    assert first.insufficient_cohorts == ()
    assert sum(1 for member in first.members if member.cohort == "A") == 20
    assert sum(1 for member in first.members if member.cohort == "B") == 20
    assert sum(1 for member in first.members if member.cohort == "healthy_rejected") == 20


def test_small_cohort_selects_all_and_marks_selection_insufficient() -> None:
    rows = [
        *[prospect(index, route="A") for index in range(1, 4)],
        *[prospect(index, route="B") for index in range(31, 53)],
        *[prospect(index, route=None, status="rejected") for index in range(61, 83)],
    ]

    selection = select_validation_sample(rows, run_id=RUN_ID)

    assert len(selection.members) == 43
    assert selection.cohort_sizes == {"A": 3, "B": 22, "healthy_rejected": 22}
    assert selection.insufficient_cohorts == ("A",)

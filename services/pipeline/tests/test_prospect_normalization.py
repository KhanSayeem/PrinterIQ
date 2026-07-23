from __future__ import annotations

from decimal import Decimal
from uuid import UUID

import pytest

from prospects.normalization import (
    NormalizationDecision,
    ProspectInput,
    classify_prospect,
    normalize_domain,
    normalize_name,
    normalize_phone,
)

RUN_ID = UUID("20000000-0000-0000-0000-000000000001")


def prospect(**overrides: object) -> ProspectInput:
    values: dict[str, object] = {
        "id": UUID("30000000-0000-0000-0000-000000000001"),
        "discovery_run_id": RUN_ID,
        "source_business_id": "place-1",
        "business_name": "Northside Plumbing",
        "primary_category": "Plumber",
        "additional_categories": ("Drainage service",),
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
    return ProspectInput(**values)


def test_normalizers_create_stable_replay_identities() -> None:
    assert normalize_name("  North-Side Plumbing Pty. Ltd. ") == "north side plumbing pty ltd"
    assert normalize_phone("+61 (0)7 3000 0000") == "61730000000"
    assert normalize_phone("07 3000 0000") == "61730000000"
    assert normalize_domain("https://www.Example.com.au:443/path?q=1#x") == "example.com.au"


@pytest.mark.parametrize(
    ("input_prospect", "expected"),
    [
        (
            prospect(),
            NormalizationDecision(
                status="assessed",
                route="A",
                website_ownership="none",
                reason="no_owned_website",
            ),
        ),
        (
            prospect(business_status="PERMANENTLY_CLOSED"),
            NormalizationDecision(
                status="rejected",
                route=None,
                website_ownership=None,
                reason="permanently_closed",
            ),
        ),
        (
            prospect(business_status="closed_permanently"),
            NormalizationDecision(
                status="rejected",
                route=None,
                website_ownership=None,
                reason="permanently_closed",
            ),
        ),
        (
            prospect(primary_category="Building materials supplier"),
            NormalizationDecision(
                status="rejected",
                route=None,
                website_ownership=None,
                reason="wrong_category",
            ),
        ),
        (
            prospect(primary_category="Plumbing Training School"),
            NormalizationDecision(
                status="rejected",
                route=None,
                website_ownership=None,
                reason="wrong_category",
            ),
        ),
        (
            prospect(primary_category="Plumbing Directory"),
            NormalizationDecision(
                status="rejected",
                route=None,
                website_ownership=None,
                reason="wrong_category",
            ),
        ),
        (
            prospect(locality="Gold Coast", postcode="4217"),
            NormalizationDecision(
                status="rejected",
                route=None,
                website_ownership=None,
                reason="outside_region",
            ),
        ),
        (
            prospect(
                locality="Upper Coomera",
                postcode="4209",
                full_address="Upper Coomera QLD 4209",
            ),
            NormalizationDecision(
                status="rejected",
                route=None,
                website_ownership=None,
                reason="outside_region",
            ),
        ),
        (
            prospect(
                locality="Ormeau",
                postcode="4208",
                full_address="Ormeau QLD 4208",
            ),
            NormalizationDecision(
                status="rejected",
                route=None,
                website_ownership=None,
                reason="outside_region",
            ),
        ),
        (
            prospect(
                locality="Gatton",
                postcode="4343",
                full_address="Gatton QLD 4343",
            ),
            NormalizationDecision(
                status="rejected",
                route=None,
                website_ownership=None,
                reason="outside_region",
            ),
        ),
        (
            prospect(
                locality="Brisbane",
                state="California",
                postcode="94005",
                full_address="Brisbane, California 94005",
            ),
            NormalizationDecision(
                status="rejected",
                route=None,
                website_ownership=None,
                reason="outside_region",
            ),
        ),
        (
            prospect(
                locality="Fortitude Valley",
                state="QLD",
                postcode="4006",
                full_address="100 Wickham Street, Fortitude Valley QLD 4006",
            ),
            NormalizationDecision(
                status="assessed",
                route="A",
                website_ownership="none",
                reason="no_owned_website",
            ),
        ),
        (
            prospect(source_website_url="https://facebook.com/northsideplumbing"),
            NormalizationDecision(
                status="assessed",
                route="A",
                website_ownership="social",
                reason="no_owned_website",
            ),
        ),
        (
            prospect(source_website_url="https://www.yellowpages.com.au/qld/brisbane/northside-plumbing"),
            NormalizationDecision(
                status="assessed",
                route="A",
                website_ownership="directory",
                reason="no_owned_website",
            ),
        ),
        (
            prospect(source_website_url="https://hipages.com.au/connect/northsideplumbing"),
            NormalizationDecision(
                status="assessed",
                route="A",
                website_ownership="marketplace",
                reason="no_owned_website",
            ),
        ),
        (
            prospect(source_website_url="https://northside.sedoparking.com"),
            NormalizationDecision(
                status="assessed",
                route="A",
                website_ownership="placeholder",
                reason="no_owned_website",
            ),
        ),
        (
            prospect(
                source_website_url="https://northside.example",
                source_payload={"website_fetch_failures": 2},
            ),
            NormalizationDecision(
                status="assessed",
                route="A",
                website_ownership="inaccessible",
                reason="no_owned_website",
            ),
        ),
        (
            prospect(
                source_website_url="https://northside.example",
                source_payload={"website_title": "Coming soon"},
            ),
            NormalizationDecision(
                status="assessed",
                route="A",
                website_ownership="placeholder",
                reason="no_owned_website",
            ),
        ),
        (
            prospect(source_website_url="https://northside.example"),
            NormalizationDecision(
                status="normalized",
                route=None,
                website_ownership="owned",
                reason="owned_website",
            ),
        ),
    ],
)
def test_eligibility_and_route_a_website_boundaries(
    input_prospect: ProspectInput, expected: NormalizationDecision
) -> None:
    decision = classify_prospect(input_prospect, matched_location_count=1)

    assert decision == expected


def test_redirect_destination_is_classified_before_original_domain() -> None:
    decision = classify_prospect(
        prospect(
            source_website_url="https://northside-plumbing.example",
            source_payload={"resolved_website_url": "https://facebook.com/northsideplumbing"},
        ),
        matched_location_count=1,
    )

    assert decision.website_ownership == "social"
    assert decision.route == "A"


@pytest.mark.parametrize(
    ("locality", "postcode"),
    [
        ("Brisbane", "4000"),
        ("Logan", "4114"),
        ("Ipswich", "4305"),
        ("Moreton Bay", "4500"),
        ("Redlands", "4163"),
    ],
)
def test_approved_greater_brisbane_regions_are_accepted(locality: str, postcode: str) -> None:
    decision = classify_prospect(
        prospect(
            locality=locality,
            postcode=postcode,
            full_address=f"{locality} QLD {postcode}",
        ),
        matched_location_count=1,
    )

    assert decision.reason == "no_owned_website"
    assert decision.route == "A"


def test_low_rating_holds_only_when_review_count_is_meaningful() -> None:
    small_sample = classify_prospect(
        prospect(rating=Decimal("3.2"), review_count=9),
        matched_location_count=1,
    )
    meaningful_sample = classify_prospect(
        prospect(rating=Decimal("3.2"), review_count=10),
        matched_location_count=1,
    )

    assert small_sample.status == "assessed"
    assert meaningful_sample == NormalizationDecision(
        status="held",
        route=None,
        website_ownership=None,
        reason="reputation_risk",
    )


@pytest.mark.parametrize(
    ("input_prospect", "matched_location_count", "reason"),
    [
        (prospect(business_name="Jim's Plumbing Brisbane"), 1, "franchise"),
        (
            prospect(source_website_url="https://www.metropolitanplumbing.com.au/brisbane"),
            1,
            "franchise",
        ),
        (prospect(), 4, "too_many_locations"),
        (prospect(), 2, "ambiguous_duplicate"),
    ],
)
def test_hold_boundaries_for_franchise_location_count_and_ambiguous_duplicates(
    input_prospect: ProspectInput, matched_location_count: int, reason: str
) -> None:
    decision = classify_prospect(
        input_prospect,
        matched_location_count=matched_location_count,
        ambiguous_duplicate=reason == "ambiguous_duplicate",
    )

    assert decision == NormalizationDecision(
        status="held",
        route=None,
        website_ownership=None,
        reason=reason,
    )

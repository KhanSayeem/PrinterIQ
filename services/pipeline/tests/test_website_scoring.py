from __future__ import annotations

from decimal import Decimal
from uuid import UUID

from prospects.normalization import ProspectInput
from prospects.website_scoring import ASSESSMENT_VERSION, assess_website_health

PROSPECT_ID = UUID("30000000-0000-0000-0000-000000000001")
RUN_ID = UUID("20000000-0000-0000-0000-000000000001")


def prospect(**overrides: object) -> ProspectInput:
    values: dict[str, object] = {
        "id": PROSPECT_ID,
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
        "source_website_url": "https://northside.example",
        "source_payload": {},
    }
    values.update(overrides)
    return ProspectInput(**values)  # type: ignore[arg-type]


def full_audit(**overrides: object) -> dict[str, object]:
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
        "mentions_greater_brisbane": True,
        "named_suburbs": ["Brisbane", "Logan", "Ipswich"],
        "has_service_area_page": False,
        "has_nap_consistency": True,
        "has_local_business_schema": True,
        "has_credentials_or_identity": True,
        "has_testimonials_or_reviews": True,
        "has_project_photos": True,
        "has_about_or_team": True,
        "has_privacy_and_contact_details": True,
        "has_service_pages_or_sections": True,
        "plumbing_services": ["blocked drain", "hot water", "gas fitting"],
        "has_meaningful_service_copy": True,
        "has_faq_or_guidance": True,
    }
    values.update(overrides)
    return values


def test_website_health_v1_allocates_exactly_100_points() -> None:
    result = assess_website_health(prospect(), full_audit())

    assert result.total_score == 100
    assert result.route == "healthy"
    assert sum(result.category_scores.values()) == 100
    assert result.category_scores == {
        "technical_mobile": 25,
        "conversion_path": 25,
        "local_relevance": 20,
        "trust_credibility": 15,
        "service_completeness": 15,
    }
    assert result.rule_evidence["scoring"]["version"] == ASSESSMENT_VERSION  # type: ignore[index]


def test_threshold_boundaries_route_59_60_69_and_70() -> None:
    route_b = assess_website_health(
        prospect(),
        full_audit(
            mentions_greater_brisbane=False,
            named_suburbs=[],
            has_service_area_page=False,
            has_nap_consistency=False,
            has_local_business_schema=False,
            has_credentials_or_identity=False,
            has_testimonials_or_reviews=False,
            has_project_photos=False,
            has_about_or_team=False,
            has_privacy_and_contact_details=False,
            has_service_pages_or_sections=False,
        ),
    )
    manual_low = assess_website_health(
        prospect(),
        full_audit(
            mentions_greater_brisbane=False,
            named_suburbs=[],
            has_service_area_page=False,
            has_nap_consistency=False,
            has_local_business_schema=False,
            has_credentials_or_identity=False,
            has_testimonials_or_reviews=False,
            has_project_photos=False,
            has_about_or_team=False,
            has_privacy_and_contact_details=False,
            has_meaningful_service_copy=False,
            has_faq_or_guidance=False,
        ),
    )
    manual_high = assess_website_health(
        prospect(),
        full_audit(
            has_nap_consistency=False,
            has_local_business_schema=False,
            has_credentials_or_identity=False,
            has_testimonials_or_reviews=False,
            has_project_photos=False,
            has_about_or_team=False,
            has_privacy_and_contact_details=False,
            has_service_pages_or_sections=False,
            has_faq_or_guidance=False,
        ),
    )
    healthy = assess_website_health(
        prospect(),
        full_audit(
            has_local_business_schema=False,
            has_credentials_or_identity=False,
            has_testimonials_or_reviews=False,
            has_project_photos=False,
            has_about_or_team=False,
            has_privacy_and_contact_details=False,
            has_service_pages_or_sections=False,
            has_meaningful_service_copy=False,
            has_faq_or_guidance=False,
        ),
    )

    assert (route_b.total_score, route_b.route) == (59, "B")
    assert (manual_low.total_score, manual_low.route) == (60, "manual_review")
    assert (manual_high.total_score, manual_high.route) == (69, "manual_review")
    assert (healthy.total_score, healthy.route) == (70, "healthy")


def test_no_usable_contact_path_forces_route_b() -> None:
    result = assess_website_health(
        prospect(),
        full_audit(
            has_visible_tel_link=False,
            has_contact_form=False,
            has_mailto_link=False,
            displayed_phone=None,
        ),
    )

    assert result.total_score == 85
    assert result.route == "B"
    assert result.forced_route_reason == "no_usable_contact_path"
    assert result.outcome_reason == "no_usable_contact_path"


def test_non_owned_audit_destinations_hand_back_to_route_a() -> None:
    result = assess_website_health(
        prospect(),
        full_audit(
            final_url="https://facebook.com/northsideplumbing",
            title="Northside Plumbing on Facebook",
        ),
    )

    assert result.route == "A"
    assert result.total_score is None
    assert result.website_ownership == "social"
    assert result.outcome_reason == "no_owned_website"
    assert result.rule_evidence["scoring"]["status"] == "not_scored"  # type: ignore[index]

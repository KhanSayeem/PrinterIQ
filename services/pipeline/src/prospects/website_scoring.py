from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from prospects.normalization import ProspectInput, classify_website_ownership, normalize_phone

ASSESSMENT_VERSION = "website-health-v1"

Route = Literal["A", "B", "manual_review", "healthy"]


@dataclass(frozen=True)
class WebsiteHealthAssessment:
    route: Route
    total_score: int | None
    category_scores: dict[str, int]
    rule_evidence: dict[str, object]
    forced_route_reason: str | None
    website_ownership: str
    outcome_reason: str


def assess_website_health(
    prospect: ProspectInput,
    audit: Mapping[str, object],
) -> WebsiteHealthAssessment:
    ownership = classify_website_ownership(_with_audit_payload(prospect, audit))
    if ownership != "owned":
        return WebsiteHealthAssessment(
            route="A",
            total_score=None,
            category_scores={},
            rule_evidence={
                "website": {
                    "ownership": ownership,
                    "reason": "no_owned_website",
                    "final_url": _string(audit, "final_url")
                    or _string(audit, "resolved_website_url")
                    or prospect.source_website_url,
                },
                "scoring": {
                    "version": ASSESSMENT_VERSION,
                    "status": "not_scored",
                    "reason": "not_functioning_owned_website",
                },
            },
            forced_route_reason="no_owned_website",
            website_ownership=ownership,
            outcome_reason="no_owned_website",
        )

    technical = _technical_score(audit)
    conversion = _conversion_score(audit, prospect.phone)
    local = _local_score(audit)
    trust = _trust_score(audit)
    services = _service_score(audit)
    category_scores = {
        "technical_mobile": technical[0],
        "conversion_path": conversion[0],
        "local_relevance": local[0],
        "trust_credibility": trust[0],
        "service_completeness": services[0],
    }
    total_score = sum(category_scores.values())
    forced_route_reason = (
        "no_usable_contact_path" if not _has_usable_contact_path(audit) else None
    )
    route = _route_for_score(total_score)
    if forced_route_reason:
        route = "B"

    return WebsiteHealthAssessment(
        route=route,
        total_score=total_score,
        category_scores=category_scores,
        rule_evidence={
            "website": {
                "ownership": "owned",
                "reason": "owned_website",
                "final_url": _string(audit, "final_url")
                or _string(audit, "resolved_website_url")
                or prospect.source_website_url,
            },
            "scoring": {
                "version": ASSESSMENT_VERSION,
                "total_score": total_score,
                "category_scores": category_scores,
                "rules": {
                    "technical_mobile": technical[1],
                    "conversion_path": conversion[1],
                    "local_relevance": local[1],
                    "trust_credibility": trust[1],
                    "service_completeness": services[1],
                },
                "route": route,
                "forced_route_reason": forced_route_reason,
            },
        },
        forced_route_reason=forced_route_reason,
        website_ownership="owned",
        outcome_reason=forced_route_reason or _outcome_for_route(route),
    )


def _technical_score(audit: Mapping[str, object]) -> tuple[int, dict[str, object]]:
    return _score_rules(
        (
            ("reachable_final_page", 5, _reachable(audit), "Final page is reachable"),
            ("valid_https", 4, _final_url(audit).startswith("https://"), "Final URL uses HTTPS"),
            (
                "usable_mobile_viewport",
                6,
                _bool(audit, "has_mobile_viewport") and not _bool(audit, "has_horizontal_overflow"),
                "Mobile viewport is usable without horizontal overflow",
            ),
            (
                "main_content_under_4s",
                6,
                _number(audit, "dom_content_ms") is not None
                and int(_number(audit, "dom_content_ms") or 0) <= 4000,
                "Main content is available within 4 seconds",
            ),
            (
                "title_and_h1",
                4,
                bool(_string(audit, "title")) and bool(_string(audit, "h1")),
                "Page has a non-empty title and H1",
            ),
        )
    )


def _conversion_score(
    audit: Mapping[str, object], source_phone: str | None
) -> tuple[int, dict[str, object]]:
    return _score_rules(
        (
            (
                "prominent_tap_to_call",
                8,
                _bool(audit, "has_visible_tel_link"),
                "Prominent tap-to-call phone is visible",
            ),
            (
                "mobile_primary_cta",
                7,
                _bool(audit, "has_mobile_primary_cta"),
                "Primary quote or contact CTA is visible on mobile",
            ),
            (
                "usable_contact_method",
                5,
                _bool(audit, "has_contact_form") or _bool(audit, "has_mailto_link"),
                "Contact form, email link, or equivalent method is available",
            ),
            (
                "emergency_or_hours_clarity",
                3,
                _bool(audit, "has_emergency_or_hours_text"),
                "Emergency service or opening-hours clarity is present",
            ),
            (
                "phone_matches_source",
                2,
                _phone_matches(_string(audit, "displayed_phone"), source_phone),
                "Displayed phone agrees with the source phone",
            ),
        )
    )


def _local_score(audit: Mapping[str, object]) -> tuple[int, dict[str, object]]:
    suburbs = _sequence(audit.get("named_suburbs"))
    return _score_rules(
        (
            (
                "greater_brisbane_or_service_area",
                6,
                _bool(audit, "mentions_greater_brisbane") or _bool(audit, "has_service_area_page"),
                "Greater Brisbane or a service area is stated",
            ),
            (
                "three_named_suburbs_or_area_page",
                6,
                len(suburbs) >= 3 or _bool(audit, "has_service_area_page"),
                "At least three suburbs or a service-area page are present",
            ),
            (
                "nap_consistency",
                4,
                _bool(audit, "has_nap_consistency"),
                "Business name, address, and phone are consistent",
            ),
            (
                "local_business_schema",
                4,
                _bool(audit, "has_local_business_schema"),
                "Valid LocalBusiness schema is present",
            ),
        )
    )


def _trust_score(audit: Mapping[str, object]) -> tuple[int, dict[str, object]]:
    return _score_rules(
        (
            (
                "credentials_or_identity",
                4,
                _bool(audit, "has_credentials_or_identity"),
                "Credentials or verifiable business identity are shown",
            ),
            (
                "testimonials_or_reviews",
                4,
                _bool(audit, "has_testimonials_or_reviews"),
                "Testimonials or review proof are shown",
            ),
            (
                "genuine_project_photos",
                3,
                _bool(audit, "has_project_photos"),
                "Genuine project or work photos are present",
            ),
            (
                "about_or_team",
                2,
                _bool(audit, "has_about_or_team"),
                "About or team information is present",
            ),
            (
                "privacy_and_contact_details",
                2,
                _bool(audit, "has_privacy_and_contact_details"),
                "Privacy and complete contact details are present",
            ),
        )
    )


def _service_score(audit: Mapping[str, object]) -> tuple[int, dict[str, object]]:
    services = _sequence(audit.get("plumbing_services"))
    return _score_rules(
        (
            (
                "dedicated_service_pages",
                6,
                _bool(audit, "has_service_pages_or_sections"),
                "Dedicated service pages or clear sections are present",
            ),
            (
                "three_plumbing_services",
                4,
                len(services) >= 3,
                "At least three plumbing services are described",
            ),
            (
                "meaningful_service_copy",
                3,
                _bool(audit, "has_meaningful_service_copy"),
                "Service copy is meaningful and not placeholder text",
            ),
            (
                "faq_or_guidance",
                2,
                _bool(audit, "has_faq_or_guidance"),
                "FAQ or useful customer guidance is present",
            ),
        )
    )


def _score_rules(
    rules: Sequence[tuple[str, int, bool, str]],
) -> tuple[int, dict[str, object]]:
    evidence: dict[str, object] = {}
    total = 0
    for key, points, passed, description in rules:
        awarded = points if passed else 0
        total += awarded
        evidence[key] = {
            "passed": passed,
            "points": awarded,
            "available": points,
            "evidence": description if passed else f"Missing: {description}",
        }
    return total, evidence


def _with_audit_payload(
    prospect: ProspectInput, audit: Mapping[str, object]
) -> ProspectInput:
    payload = dict(prospect.source_payload)
    for target, source in (
        ("resolved_website_url", "final_url"),
        ("website_status_code", "status_code"),
        ("website_fetch_failures", "fetch_failures"),
        ("website_error", "website_error"),
        ("website_title", "title"),
        ("website_text", "visible_text"),
    ):
        value = audit.get(source)
        if value is not None:
            payload[target] = value
    return ProspectInput(
        id=prospect.id,
        discovery_run_id=prospect.discovery_run_id,
        source_business_id=prospect.source_business_id,
        business_name=prospect.business_name,
        primary_category=prospect.primary_category,
        additional_categories=prospect.additional_categories,
        phone=prospect.phone,
        full_address=prospect.full_address,
        locality=prospect.locality,
        state=prospect.state,
        postcode=prospect.postcode,
        business_status=prospect.business_status,
        rating=prospect.rating,
        review_count=prospect.review_count,
        source_website_url=prospect.source_website_url,
        source_payload=payload,
    )


def _route_for_score(score: int) -> Route:
    if score <= 59:
        return "B"
    if score <= 69:
        return "manual_review"
    return "healthy"


def _outcome_for_route(route: Route) -> str:
    return {
        "A": "no_owned_website",
        "B": "website_health_low",
        "manual_review": "website_health_manual_review",
        "healthy": "website_healthy",
    }[route]


def _has_usable_contact_path(audit: Mapping[str, object]) -> bool:
    return (
        _bool(audit, "has_visible_tel_link")
        or _bool(audit, "has_contact_form")
        or _bool(audit, "has_mailto_link")
        or bool(_string(audit, "displayed_phone"))
    )


def _reachable(audit: Mapping[str, object]) -> bool:
    status_code = _number(audit, "status_code")
    return (
        _number(audit, "fetch_failures") in {None, 0}
        and status_code is not None
        and 200 <= int(status_code) < 400
    )


def _final_url(audit: Mapping[str, object]) -> str:
    return _string(audit, "final_url") or _string(audit, "resolved_website_url") or ""


def _phone_matches(displayed_phone: str | None, source_phone: str | None) -> bool:
    return bool(
        displayed_phone
        and source_phone
        and normalize_phone(displayed_phone) == normalize_phone(source_phone)
    )


def _bool(audit: Mapping[str, object], key: str) -> bool:
    return audit.get(key) is True


def _string(audit: Mapping[str, object], key: str) -> str | None:
    value = audit.get(key)
    return value if isinstance(value, str) and value.strip() else None


def _number(audit: Mapping[str, object], key: str) -> int | float | None:
    value = audit.get(key)
    return value if isinstance(value, (int, float)) else None


def _sequence(value: object) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(item for item in value if isinstance(item, str) and item.strip())

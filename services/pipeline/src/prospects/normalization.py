from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal
from urllib.parse import urlparse
from uuid import UUID

ProspectStatus = Literal["normalized", "assessed", "held", "rejected"]
Route = Literal["A", "B", "manual_review", "healthy"]
WebsiteOwnership = Literal[
    "none", "social", "directory", "marketplace", "placeholder", "inaccessible", "owned"
]

APPROVED_PLUMBING_CATEGORIES = {
    "plumber",
    "plumbing",
    "drainage service",
    "gas fitter",
    "gasfitter",
}
REJECTED_CATEGORY_TERMS = {
    "supplier",
    "supply",
    "training",
    "school",
    "directory",
    "merchant",
    "building materials",
}
APPROVED_LOCALITIES = {
    "brisbane",
    "logan",
    "ipswich",
    "moreton bay",
    "redlands",
}
GREATER_BRISBANE_POSTCODE_RANGES = (
    (4000, 4184),
    (4205, 4207),
    (4300, 4305),
    (4500, 4521),
)
QUEENSLAND_STATES = {"qld", "queensland"}
PERMANENTLY_CLOSED_STATUSES = {
    "permanently closed",
    "permanently_closed",
    "closed permanently",
    "closed_permanently",
}
SOCIAL_HOSTS = {
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "x.com",
    "twitter.com",
}
DIRECTORY_HOSTS = {
    "yellowpages.com.au",
    "truelocal.com.au",
    "localbusinessguide.com.au",
    "aussieweb.com.au",
}
MARKETPLACE_HOSTS = {
    "hipages.com.au",
    "oneflare.com.au",
    "service.com.au",
    "airtasker.com",
}
PARKED_HOST_TERMS = ("godaddy", "sedoparking", "parkingcrew", "parked")
PLACEHOLDER_TERMS = (
    "coming soon",
    "under construction",
    "domain parked",
    "this domain is for sale",
    "site is not published",
)
KNOWN_FRANCHISE_NAMES = {
    "jim s plumbing",
    "jims plumbing",
    "metropolitan plumbing",
    "mr emergency plumbing",
    "plumbing bros",
}
KNOWN_FRANCHISE_DOMAINS = {
    "metropolitanplumbing.com.au",
    "jimsplumbing.net.au",
    "mremergency.com.au",
}


@dataclass(frozen=True)
class ProspectInput:
    id: UUID
    discovery_run_id: UUID
    source_business_id: str
    business_name: str
    primary_category: str | None
    additional_categories: tuple[str, ...] | list[str]
    phone: str | None
    full_address: str | None
    locality: str | None
    state: str | None
    postcode: str | None
    business_status: str | None
    rating: Decimal | None
    review_count: int | None
    source_website_url: str | None
    source_payload: Mapping[str, object]


@dataclass(frozen=True)
class NormalizationDecision:
    status: ProspectStatus
    route: Literal["A"] | None
    website_ownership: WebsiteOwnership | None
    reason: str


def normalize_name(value: str | None) -> str:
    if not value:
        return ""
    decomposed = unicodedata.normalize("NFKD", value)
    ascii_value = decomposed.encode("ascii", "ignore").decode("ascii")
    alnum_spaced = re.sub(r"[^a-zA-Z0-9]+", " ", ascii_value.casefold())
    return re.sub(r"\s+", " ", alnum_spaced).strip()


def normalize_phone(value: str | None) -> str | None:
    if not value:
        return None
    digits = re.sub(r"\D+", "", value)
    if digits.startswith("610"):
        return "61" + digits[3:]
    if digits.startswith("0") and len(digits) >= 9:
        return "61" + digits[1:]
    if digits.startswith("61"):
        return digits
    return digits or None


def normalize_domain(value: str | None) -> str | None:
    if not value:
        return None
    parsed = urlparse(value if "://" in value else f"https://{value}")
    host = (parsed.hostname or "").casefold()
    if host.startswith("www."):
        host = host[4:]
    return host or None


def is_owned_domain(value: str | None) -> bool:
    domain = normalize_domain(value)
    if domain is None:
        return False
    return not (
        _domain_in(domain, SOCIAL_HOSTS)
        or _domain_in(domain, DIRECTORY_HOSTS)
        or _domain_in(domain, MARKETPLACE_HOSTS)
        or any(term in domain for term in PARKED_HOST_TERMS)
    )


def classify_prospect(
    prospect: ProspectInput,
    *,
    matched_location_count: int,
    ambiguous_duplicate: bool = False,
) -> NormalizationDecision:
    status = (prospect.business_status or "").strip().casefold()
    if status in PERMANENTLY_CLOSED_STATUSES:
        return _reject("permanently_closed")
    if not _is_plumbing_category(prospect):
        return _reject("wrong_category")
    if not _is_inside_region(prospect):
        return _reject("outside_region")
    if _is_known_franchise(prospect):
        return _hold("franchise")
    if _string_value(prospect.source_payload, "website_error") == "resolver_exception":
        return _hold("resolver_error")
    if matched_location_count > 3:
        return _hold("too_many_locations")
    if ambiguous_duplicate:
        return _hold("ambiguous_duplicate")
    if (
        prospect.rating is not None
        and prospect.rating < Decimal("3.5")
        and (prospect.review_count or 0) >= 10
    ):
        return _hold("reputation_risk")

    ownership = classify_website_ownership(prospect)
    if ownership == "owned":
        return NormalizationDecision(
            status="normalized",
            route=None,
            website_ownership="owned",
            reason="owned_website",
        )
    return NormalizationDecision(
        status="assessed",
        route="A",
        website_ownership=ownership,
        reason="no_owned_website",
    )


def classify_website_ownership(prospect: ProspectInput) -> WebsiteOwnership:
    source_url = prospect.source_website_url
    if not source_url:
        return "none"
    payload = prospect.source_payload
    if _string_value(payload, "website_error") in {"unsafe_url", "unsafe_redirect"}:
        return "none"
    if _int_value(payload.get("website_fetch_failures")) >= 2:
        return "inaccessible"
    final_url = _string_value(payload, "resolved_website_url") or _string_value(
        payload, "website_final_url"
    ) or source_url
    domain = normalize_domain(final_url)
    if domain is None:
        return "none"
    if _domain_in(domain, SOCIAL_HOSTS):
        return "social"
    if _domain_in(domain, DIRECTORY_HOSTS):
        return "directory"
    if _domain_in(domain, MARKETPLACE_HOSTS):
        return "marketplace"
    if any(term in domain for term in PARKED_HOST_TERMS):
        return "placeholder"
    text = " ".join(
        value.casefold()
        for value in (
            _string_value(payload, "website_title"),
            _string_value(payload, "website_text"),
            _string_value(payload, "website_body"),
        )
        if value
    )
    if any(term in text for term in PLACEHOLDER_TERMS):
        return "placeholder"
    return "owned"


def _is_plumbing_category(prospect: ProspectInput) -> bool:
    categories = [
        prospect.primary_category or "",
        *list(prospect.additional_categories or ()),
    ]
    normalized = [normalize_name(category) for category in categories]
    if any(any(term in category for term in REJECTED_CATEGORY_TERMS) for category in normalized):
        return False
    return any(category in APPROVED_PLUMBING_CATEGORIES for category in normalized)


def _is_inside_region(prospect: ProspectInput) -> bool:
    locality = normalize_name(prospect.locality)
    address = normalize_name(prospect.full_address)
    state = normalize_name(prospect.state)
    if state and state not in QUEENSLAND_STATES:
        return False
    if not state and " qld " not in f" {address} " and " queensland " not in f" {address} ":
        return False
    postcode = _postcode_int(prospect.postcode)
    if postcode is not None and any(
        start <= postcode <= end for start, end in GREATER_BRISBANE_POSTCODE_RANGES
    ):
        return True
    if locality:
        return locality in APPROVED_LOCALITIES
    return locality in APPROVED_LOCALITIES or any(
        approved in address for approved in APPROVED_LOCALITIES
    )


def _is_known_franchise(prospect: ProspectInput) -> bool:
    name = normalize_name(prospect.business_name)
    domain = normalize_domain(prospect.source_website_url)
    return any(franchise in name for franchise in KNOWN_FRANCHISE_NAMES) or bool(
        domain and domain in KNOWN_FRANCHISE_DOMAINS
    )


def _domain_in(domain: str, hosts: set[str]) -> bool:
    return any(domain == host or domain.endswith(f".{host}") for host in hosts)


def _string_value(payload: Mapping[str, object], key: str) -> str | None:
    value = payload.get(key)
    return value if isinstance(value, str) and value.strip() else None


def _int_value(value: object) -> int:
    if value is None:
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return 0


def _postcode_int(value: str | None) -> int | None:
    if not value:
        return None
    match = re.search(r"\d{4}", value)
    return int(match.group(0)) if match else None


def _reject(reason: str) -> NormalizationDecision:
    return NormalizationDecision(
        status="rejected",
        route=None,
        website_ownership=None,
        reason=reason,
    )


def _hold(reason: str) -> NormalizationDecision:
    return NormalizationDecision(
        status="held",
        route=None,
        website_ownership=None,
        reason=reason,
    )

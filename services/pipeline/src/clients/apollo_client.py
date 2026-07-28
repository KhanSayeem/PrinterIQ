from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Literal, cast
from urllib.parse import urlparse

import httpx

from env import load_pipeline_env

_DEFAULT_BASE_URL = "https://api.apollo.io"
_STRATEGY_VERSION = "apollo-owner-verified-v2"
_OWNER_SENIORITIES = ("owner", "founder", "partner", "c_suite")
_SENIORITY_RANK = {value: index for index, value in enumerate(_OWNER_SENIORITIES)}
_DISABLED_REVEALS = {
    "reveal_personal_emails": False,
    "reveal_phone_number": False,
    "run_waterfall_email": False,
    "run_waterfall_phone": False,
}
_ORGANIZATION_DOMAIN_FIELDS = (
    "primary_domain",
    "domain",
    "website_url",
    "organization_website_url",
    "website",
    "url",
)
_BUSINESS_NAME_STOPWORDS = frozenset(
    {
        "and",
        "australia",
        "australian",
        "brisbane",
        "co",
        "company",
        "drain",
        "drainage",
        "drains",
        "electric",
        "electrical",
        "electrician",
        "electricians",
        "fitter",
        "fitters",
        "gas",
        "group",
        "hvac",
        "inc",
        "limited",
        "llc",
        "ltd",
        "plumber",
        "plumbers",
        "plumbing",
        "pty",
        "qld",
        "queensland",
        "roof",
        "roofer",
        "roofers",
        "roofing",
        "service",
        "services",
        "the",
    }
)
Route = Literal["A", "B"]


class MissingApolloAPIKeyError(RuntimeError):
    """Raised when the server-side Apollo credential is absent."""


class ApolloAPIError(RuntimeError):
    """Raised when Apollo transport or response validation fails."""


class ApolloRetryableError(ApolloAPIError):
    """Raised for transient provider failures that may be retried safely."""

    def __init__(self, message: str, *, retry_after_seconds: int | None = None) -> None:
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


class ApolloMasterKeyRequiredError(ApolloAPIError):
    """Raised when Apollo denies a master-key-only capability."""


@dataclass(frozen=True)
class ApolloVerifiedContact:
    organization_id: str
    person_id: str
    person_name: str
    person_title: str
    email: str
    email_status: Literal["verified"]
    evidence: dict[str, object]
    provider_usage: dict[str, object]


@dataclass(frozen=True)
class ApolloNoMatch:
    evidence: dict[str, object]
    provider_usage: dict[str, object]
    organization_id: str | None = None


class ApolloClient:
    def __init__(
        self,
        *,
        api_key: str,
        http_client: httpx.AsyncClient | None = None,
        base_url: str = _DEFAULT_BASE_URL,
    ) -> None:
        self._api_key = api_key
        self._http_client = http_client
        self._base_url = base_url.rstrip("/")

    @classmethod
    def from_env(cls) -> ApolloClient:
        load_pipeline_env()
        api_key = os.getenv("APOLLO_API_KEY")
        if not api_key:
            raise MissingApolloAPIKeyError("Missing env var: APOLLO_API_KEY")
        return cls(api_key=api_key)

    async def resolve_verified_owner(
        self,
        *,
        route: Route,
        business_name: str,
        normalized_domain: str | None,
        locality: str | None,
    ) -> ApolloVerifiedContact | ApolloNoMatch:
        request_count = 0
        organization_payload = _organization_search_payload(
            route=route,
            business_name=business_name,
            normalized_domain=normalized_domain,
            locality=locality,
        )
        organization_response = await self._post(
            "/api/v1/mixed_companies/search",
            json_body=organization_payload,
        )
        request_count += 1
        organization = _single_organization(organization_response)
        if organization is None:
            organization_count = _organization_count(organization_response)
            return _no_match(
                reason="organization_match_count_not_one",
                request_count=request_count,
                evidence={"organization_match_count": organization_count},
            )
        organization_id = _required_str(organization.get("id"))
        if organization_id is None:
            raise ApolloAPIError(
                "Apollo API POST /api/v1/mixed_companies/search returned a malformed response"
            )
        organization_identity = _organization_identity(
            route=route,
            business_name=business_name,
            normalized_domain=normalized_domain,
            organization=organization,
        )
        organization_evidence = _organization_match_evidence(
            organization_identity=organization_identity,
        )
        if organization_evidence is None:
            return _no_match(
                reason="rejected_organization_identity",
                request_count=request_count,
                organization_id=organization_id,
                evidence={
                    "organization_match": "single_rejected_identity",
                    "organization_identity": organization_identity,
                },
            )

        people_response = await self._post(
            "/api/v1/mixed_people/api_search",
            json_body={
                "organization_ids[]": [organization_id],
                "person_seniorities[]": list(_OWNER_SENIORITIES),
                "contact_email_status[]": ["verified"],
                "page": 1,
                "per_page": 10,
            },
            requires_master_key=True,
        )
        request_count += 1
        person = _select_owner(people_response, organization_id=organization_id)
        if person is None:
            return _no_match(
                reason="no_verified_owner_person",
                request_count=request_count,
                organization_id=organization_id,
                evidence=organization_evidence,
            )
        person_id = _required_str(person.get("id"))
        if person_id is None:
            raise ApolloAPIError(
                "Apollo API POST /api/v1/mixed_people/api_search returned a malformed response"
            )

        enrich_response = await self._post(
            "/api/v1/people/match",
            json_body={"id": person_id, **_DISABLED_REVEALS},
        )
        request_count += 1
        enriched = _person_payload(enrich_response)
        if enriched is None:
            raise ApolloAPIError(
                "Apollo API POST /api/v1/people/match returned a malformed response"
            )
        email_status = _required_str(enriched.get("email_status"))
        email = _required_str(enriched.get("email"))
        if email_status != "verified" or email is None:
            return _no_match(
                reason="person_email_not_verified",
                request_count=request_count,
                organization_id=organization_id,
                evidence={
                    **organization_evidence,
                    "person_seniority": _seniority(enriched) or _seniority(person),
                    "provider_email_status": email_status,
                },
            )
        enriched_id = _required_str(enriched.get("id")) or person_id
        return ApolloVerifiedContact(
            organization_id=_required_str(enriched.get("organization_id")) or organization_id,
            person_id=enriched_id,
            person_name=_required_str(enriched.get("name")) or "",
            person_title=_required_str(enriched.get("title")) or "",
            email=email,
            email_status="verified",
            evidence={
                **organization_evidence,
                "person_seniority": _seniority(enriched) or _seniority(person),
                "strategy": _STRATEGY_VERSION,
            },
            provider_usage={"request_count": request_count, "credits": None},
        )

    async def _post(
        self,
        path: str,
        *,
        json_body: dict[str, object],
        requires_master_key: bool = False,
    ) -> dict[str, object]:
        headers = {"X-Api-Key": self._api_key, "Content-Type": "application/json"}
        if self._http_client is None:
            async with httpx.AsyncClient(timeout=30, base_url=self._base_url) as http_client:
                return await self._send(
                    http_client,
                    path,
                    headers=headers,
                    json_body=json_body,
                    requires_master_key=requires_master_key,
                )
        return await self._send(
            self._http_client,
            path,
            headers=headers,
            json_body=json_body,
            requires_master_key=requires_master_key,
        )

    async def _send(
        self,
        http_client: httpx.AsyncClient,
        path: str,
        *,
        headers: dict[str, str],
        json_body: dict[str, object],
        requires_master_key: bool,
    ) -> dict[str, object]:
        try:
            response = await http_client.post(
                f"{self._base_url}{path}",
                headers=headers,
                json=json_body,
            )
        except httpx.HTTPError as error:
            raise ApolloRetryableError(
                f"Apollo API POST {path} failed in transport; response body omitted"
            ) from error
        if requires_master_key and response.status_code in {401, 403}:
            raise ApolloMasterKeyRequiredError(
                "apollo_master_key_required: Apollo People Search requires a master API key"
            )
        if not 200 <= response.status_code < 300:
            error_type = (
                ApolloRetryableError
                if response.status_code == 429 or response.status_code >= 500
                else ApolloAPIError
            )
            error_kwargs = (
                {"retry_after_seconds": _retry_after_seconds(response)}
                if error_type is ApolloRetryableError
                else {}
            )
            raise error_type(
                f"Apollo API POST {path} failed with {response.status_code}; response body omitted",
                **error_kwargs,
            )
        try:
            payload: Any = response.json()
        except ValueError as error:
            raise ApolloAPIError(f"Apollo API POST {path} returned a malformed response") from error
        if not isinstance(payload, dict):
            raise ApolloAPIError(f"Apollo API POST {path} returned a malformed response")
        return cast(dict[str, object], payload)


def _organization_search_payload(
    *,
    route: Route,
    business_name: str,
    normalized_domain: str | None,
    locality: str | None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "q_organization_name": business_name,
        "page": 1,
        "per_page": 5,
    }
    if route == "B" and normalized_domain:
        payload["q_organization_domains"] = normalized_domain
        return payload
    payload["organization_locations"] = [
        *([locality] if locality else []),
        "Greater Brisbane",
        "Queensland",
        "Australia",
    ]
    return payload


def _single_organization(payload: dict[str, object]) -> dict[str, object] | None:
    organizations = payload.get("organizations")
    if not isinstance(organizations, list):
        raise ApolloAPIError(
            "Apollo API POST /api/v1/mixed_companies/search returned a malformed response"
        )
    if len(organizations) != 1:
        return None
    organization = organizations[0]
    if not isinstance(organization, dict):
        raise ApolloAPIError(
            "Apollo API POST /api/v1/mixed_companies/search returned a malformed response"
        )
    return cast(dict[str, object], organization)


def _select_owner(
    payload: dict[str, object],
    *,
    organization_id: str,
) -> dict[str, object] | None:
    people = payload.get("people")
    if not isinstance(people, list):
        raise ApolloAPIError(
            "Apollo API POST /api/v1/mixed_people/api_search returned a malformed response"
        )
    candidates = [
        cast(dict[str, object], person)
        for person in people
        if isinstance(person, dict)
        and (_required_str(person.get("organization_id")) in {None, organization_id})
    ]
    ranked = sorted(
        (
            (_SENIORITY_RANK.get(_seniority(person) or "", 999), person)
            for person in candidates
        ),
        key=lambda item: item[0],
    )
    if not ranked or ranked[0][0] == 999:
        return None
    top_rank = ranked[0][0]
    top = [person for rank, person in ranked if rank == top_rank]
    if len(top) == 1:
        return top[0]
    exact = [
        person
        for person in top
        if _required_str(person.get("organization_id")) == organization_id
    ]
    return exact[0] if len(exact) == 1 else None


def _organization_identity(
    *,
    route: Route,
    business_name: str,
    normalized_domain: str | None,
    organization: dict[str, object],
) -> dict[str, object]:
    organization_name = _required_str(organization.get("name"))
    organization_domain = _organization_domain(organization)
    domain_match = (
        _domains_match(normalized_domain, organization_domain)
        if normalized_domain and organization_domain
        else False
    )
    name_match = (
        _business_names_match(business_name, organization_name)
        if organization_name is not None
        else False
    )
    return {
        "route": route,
        "business_name": business_name,
        "normalized_domain": normalized_domain,
        "apollo_organization_name": organization_name,
        "apollo_organization_domain": organization_domain,
        "domain_match": domain_match,
        "name_match": name_match,
    }


def _organization_match_evidence(
    *,
    organization_identity: dict[str, object],
) -> dict[str, object] | None:
    if not organization_identity["domain_match"] and not organization_identity["name_match"]:
        return None
    return {
        "organization_match": "single_verified_identity",
        "organization_identity": organization_identity,
    }


def _organization_domain(organization: dict[str, object]) -> str | None:
    for field_name in _ORGANIZATION_DOMAIN_FIELDS:
        domain = _domain_from_value(organization.get(field_name))
        if domain is not None:
            return domain
    return None


def _domains_match(left: str | None, right: str | None) -> bool:
    left_domain = _domain_from_value(left)
    right_domain = _domain_from_value(right)
    if left_domain is None or right_domain is None:
        return False
    return (
        left_domain == right_domain
        or left_domain.endswith(f".{right_domain}")
        or right_domain.endswith(f".{left_domain}")
    )


def _domain_from_value(value: object) -> str | None:
    raw = _required_str(value)
    if raw is None:
        return None
    parsed = urlparse(raw if "://" in raw else f"https://{raw}")
    host = parsed.hostname or raw.split("/")[0]
    domain = host.casefold().removeprefix("www.").strip(".")
    return domain or None


def _business_names_match(left: str, right: str | None) -> bool:
    if right is None:
        return False
    left_normalized = _normalized_business_name(left)
    right_normalized = _normalized_business_name(right)
    if not left_normalized or not right_normalized:
        return False
    if left_normalized == right_normalized:
        return True
    left_tokens = _business_name_tokens(left_normalized)
    right_tokens = _business_name_tokens(right_normalized)
    if not left_tokens or not right_tokens:
        return False
    shared = left_tokens & right_tokens
    if len(shared) >= 2:
        return True
    if len(left_tokens) == 1 and left_tokens <= right_tokens:
        return len(next(iter(left_tokens))) >= 5
    if len(right_tokens) == 1 and right_tokens <= left_tokens:
        return len(next(iter(right_tokens))) >= 5
    return False


def _normalized_business_name(value: str) -> str:
    return " ".join(_business_name_token_list(value))


def _business_name_tokens(value: str) -> set[str]:
    return set(_business_name_token_list(value))


def _business_name_token_list(value: str) -> list[str]:
    tokens = []
    current = []
    for character in value.casefold():
        if character.isalnum():
            current.append(character)
            continue
        if current:
            tokens.append("".join(current))
            current = []
    if current:
        tokens.append("".join(current))
    return [
        token
        for token in tokens
        if len(token) > 1 and token not in _BUSINESS_NAME_STOPWORDS
    ]


def _organization_count(payload: dict[str, object]) -> int:
    organizations = payload.get("organizations")
    if not isinstance(organizations, list):
        raise ApolloAPIError(
            "Apollo API POST /api/v1/mixed_companies/search returned a malformed response"
        )
    return len(organizations)


def _no_match(
    *,
    reason: str,
    request_count: int,
    evidence: dict[str, object],
    organization_id: str | None = None,
) -> ApolloNoMatch:
    return ApolloNoMatch(
        organization_id=organization_id,
        evidence={
            "strategy": _STRATEGY_VERSION,
            "outcome": "no_verified_owner",
            "rejection_reason": reason,
            **evidence,
        },
        provider_usage={"request_count": request_count, "credits": None},
    )


def _person_payload(payload: dict[str, object]) -> dict[str, object] | None:
    person = payload.get("person")
    if not isinstance(person, dict):
        return None
    return cast(dict[str, object], person)


def _seniority(person: dict[str, object]) -> str | None:
    seniority = _required_str(person.get("seniority"))
    if seniority in _SENIORITY_RANK:
        return seniority
    title = (_required_str(person.get("title")) or "").casefold()
    if "owner" in title:
        return "owner"
    if "founder" in title:
        return "founder"
    if "partner" in title:
        return "partner"
    if any(term in title for term in ("ceo", "chief", "director", "president")):
        return "c_suite"
    return None


def _required_str(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _retry_after_seconds(response: httpx.Response) -> int | None:
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    try:
        seconds = int(value)
    except ValueError:
        return None
    return max(0, min(seconds, 3600))

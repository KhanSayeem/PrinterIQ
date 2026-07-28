from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from clients.apollo_client import (
    ApolloAPIError,
    ApolloClient,
    ApolloMasterKeyRequiredError,
    ApolloNoMatch,
    ApolloRetryableError,
    ApolloVerifiedContact,
    MissingApolloAPIKeyError,
)


def test_route_b_resolves_domain_organization_searches_owner_and_enriches_verified_email() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.path == "/api/v1/mixed_companies/search":
                return httpx.Response(
                    200,
                    json={"organizations": [{"id": "org-1", "name": "Northside Plumbing"}]},
                )
            if request.url.path == "/api/v1/mixed_people/api_search":
                return httpx.Response(
                    200,
                    json={
                        "people": [
                            {
                                "id": "person-1",
                                "name": "Alex Owner",
                                "title": "Owner",
                                "organization_id": "org-1",
                                "email_status": "verified",
                            }
                        ]
                    },
                )
            if request.url.path == "/api/v1/people/match":
                return httpx.Response(
                    200,
                    json={
                        "person": {
                            "id": "person-1",
                            "name": "Alex Owner",
                            "title": "Owner",
                            "organization_id": "org-1",
                            "email": "alex@northside.example",
                            "email_status": "verified",
                        }
                    },
                )
            raise AssertionError(f"unexpected path {request.url.path}")

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://api.apollo.io",
        ) as http_client:
            client = ApolloClient(api_key="apollo-secret", http_client=http_client)
            contact = await client.resolve_verified_owner(
                route="B",
                business_name="Northside Plumbing",
                normalized_domain="northside.example",
                locality="Brisbane",
            )

        assert contact == ApolloVerifiedContact(
            organization_id="org-1",
            person_id="person-1",
            person_name="Alex Owner",
            person_title="Owner",
            email="alex@northside.example",
            email_status="verified",
            evidence={
                "organization_match": "single_verified_identity",
                "organization_identity": {
                    "route": "B",
                    "business_name": "Northside Plumbing",
                    "normalized_domain": "northside.example",
                    "apollo_organization_name": "Northside Plumbing",
                    "apollo_organization_domain": None,
                    "domain_match": False,
                    "name_match": True,
                },
                "person_seniority": "owner",
                "strategy": "apollo-owner-verified-v2",
            },
            provider_usage={"request_count": 3, "credits": None},
        )
        organization_request = json.loads(requests[0].content)
        assert organization_request["q_organization_domains"] == "northside.example"
        assert organization_request["q_organization_name"] == "Northside Plumbing"
        people_request = json.loads(requests[1].content)
        assert people_request["organization_ids[]"] == ["org-1"]
        assert people_request["person_seniorities[]"] == ["owner", "founder", "partner", "c_suite"]
        assert people_request["contact_email_status[]"] == ["verified"]
        assert people_request["page"] == 1
        assert people_request["per_page"] == 10
        enrich_request = json.loads(requests[2].content)
        assert enrich_request["id"] == "person-1"
        assert enrich_request.get("reveal_personal_emails") is False
        assert enrich_request.get("reveal_phone_number") is False
        assert enrich_request.get("run_waterfall_email") is False
        assert enrich_request.get("run_waterfall_phone") is False
        for request in requests:
            assert request.headers["X-Api-Key"] == "apollo-secret"

    asyncio.run(scenario())


def test_unrelated_single_organization_match_stops_before_people_search() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.path == "/api/v1/mixed_companies/search":
                return httpx.Response(
                    200,
                    json={
                        "organizations": [
                            {
                                "id": "org-breakthrough",
                                "name": "Breakthrough Energy",
                                "primary_domain": "breakthroughenergy.org",
                            }
                        ]
                    },
                )
            raise AssertionError("Unrelated organization must not reach people search")

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://api.apollo.io",
        ) as http_client:
            client = ApolloClient(api_key="apollo-secret", http_client=http_client)
            result = await client.resolve_verified_owner(
                route="B",
                business_name="Northside Plumbing",
                normalized_domain="northside.example",
                locality="Brisbane",
            )

        assert isinstance(result, ApolloNoMatch)
        assert result.provider_usage == {"request_count": 1, "credits": None}
        assert result.evidence["rejection_reason"] == "rejected_organization_identity"
        assert result.evidence["organization_identity"] == {
            "route": "B",
            "business_name": "Northside Plumbing",
            "normalized_domain": "northside.example",
            "apollo_organization_name": "Breakthrough Energy",
            "apollo_organization_domain": "breakthroughenergy.org",
            "domain_match": False,
            "name_match": False,
        }
        assert [request.url.path for request in requests] == ["/api/v1/mixed_companies/search"]

    asyncio.run(scenario())


def test_generic_trade_token_overlap_does_not_verify_organization_identity() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.path == "/api/v1/mixed_companies/search":
                return httpx.Response(
                    200,
                    json={
                        "organizations": [
                            {
                                "id": "org-smith",
                                "name": "Smith Plumbing Gas",
                            }
                        ]
                    },
                )
            raise AssertionError("Generic trade-token overlap must not reach people search")

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://api.apollo.io",
        ) as http_client:
            client = ApolloClient(api_key="apollo-secret", http_client=http_client)
            result = await client.resolve_verified_owner(
                route="A",
                business_name="A Grade Plumbing and Gas",
                normalized_domain=None,
                locality="Brisbane",
            )

        assert isinstance(result, ApolloNoMatch)
        assert result.evidence["rejection_reason"] == "rejected_organization_identity"
        assert result.evidence["organization_identity"] == {
            "route": "A",
            "business_name": "A Grade Plumbing and Gas",
            "normalized_domain": None,
            "apollo_organization_name": "Smith Plumbing Gas",
            "apollo_organization_domain": None,
            "domain_match": False,
            "name_match": False,
        }
        assert [request.url.path for request in requests] == ["/api/v1/mixed_companies/search"]

    asyncio.run(scenario())


def test_route_a_uses_business_name_and_greater_brisbane_location_without_domain() -> None:
    async def scenario() -> None:
        requests: list[dict[str, object]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(json.loads(request.content))
            if request.url.path == "/api/v1/mixed_companies/search":
                return httpx.Response(200, json={"organizations": []})
            raise AssertionError("Route A no-match must not spend people search credits")

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://api.apollo.io",
        ) as http_client:
            client = ApolloClient(api_key="apollo-secret", http_client=http_client)
            result = await client.resolve_verified_owner(
                route="A",
                business_name="Northside Plumbing",
                normalized_domain=None,
                locality="Logan",
            )

        assert isinstance(result, ApolloNoMatch)
        assert result.evidence["rejection_reason"] == "organization_match_count_not_one"
        assert result.evidence["organization_match_count"] == 0
        assert result.provider_usage == {"request_count": 1, "credits": None}
        assert requests == [
            {
                "q_organization_name": "Northside Plumbing",
                "organization_locations": ["Logan", "Greater Brisbane", "Queensland", "Australia"],
                "page": 1,
                "per_page": 5,
            }
        ]

    asyncio.run(scenario())


def test_ambiguous_organization_match_stops_before_people_search() -> None:
    async def scenario() -> None:
        request_count = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal request_count
            request_count += 1
            assert request.url.path == "/api/v1/mixed_companies/search"
            return httpx.Response(
                200,
                json={
                    "organizations": [
                        {"id": "org-1", "name": "Northside Plumbing"},
                        {"id": "org-2", "name": "North Side Plumbing"},
                    ]
                },
            )

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://api.apollo.io",
        ) as http_client:
            client = ApolloClient(api_key="apollo-secret", http_client=http_client)
            result = await client.resolve_verified_owner(
                route="B",
                business_name="Northside Plumbing",
                normalized_domain="northside.example",
                locality="Brisbane",
            )

        assert isinstance(result, ApolloNoMatch)
        assert result.evidence["rejection_reason"] == "organization_match_count_not_one"
        assert result.evidence["organization_match_count"] == 2
        assert request_count == 1

    asyncio.run(scenario())


def test_unverified_enrichment_response_is_not_accepted() -> None:
    async def scenario() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/v1/mixed_companies/search":
                return httpx.Response(
                    200,
                    json={"organizations": [{"id": "org-1", "name": "Northside Plumbing"}]},
                )
            if request.url.path == "/api/v1/mixed_people/api_search":
                return httpx.Response(
                    200,
                    json={"people": [{"id": "person-1", "title": "Founder"}]},
                )
            return httpx.Response(
                200,
                json={
                    "person": {
                        "id": "person-1",
                        "name": "Alex Founder",
                        "title": "Founder",
                        "email": "alex@gmail.com",
                        "email_status": "guessed",
                    }
                },
            )

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://api.apollo.io",
        ) as http_client:
            client = ApolloClient(api_key="apollo-secret", http_client=http_client)
            result = await client.resolve_verified_owner(
                route="B",
                business_name="Northside Plumbing",
                normalized_domain="northside.example",
                locality="Brisbane",
            )

        assert isinstance(result, ApolloNoMatch)
        assert result.evidence["rejection_reason"] == "person_email_not_verified"
        assert result.provider_usage == {"request_count": 3, "credits": None}

    asyncio.run(scenario())


def test_people_search_403_is_actionable_master_key_error_without_body_leak() -> None:
    async def scenario() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/v1/mixed_companies/search":
                return httpx.Response(
                    200,
                    json={"organizations": [{"id": "org-1", "name": "Northside Plumbing"}]},
                )
            return httpx.Response(403, json={"error": "secret account capability details"})

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://api.apollo.io",
        ) as http_client:
            client = ApolloClient(api_key="apollo-secret", http_client=http_client)
            with pytest.raises(ApolloMasterKeyRequiredError) as exc_info:
                await client.resolve_verified_owner(
                    route="B",
                    business_name="Northside Plumbing",
                    normalized_domain="northside.example",
                    locality="Brisbane",
                )

        message = str(exc_info.value)
        assert "apollo_master_key_required" in message
        assert "secret account capability details" not in message

    asyncio.run(scenario())


def test_retryable_error_preserves_retry_after_and_omits_provider_body() -> None:
    async def scenario() -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    429,
                    headers={"Retry-After": "30"},
                    json={"error": "private quota details"},
                )
            ),
            base_url="https://api.apollo.io",
        ) as http_client:
            client = ApolloClient(api_key="apollo-secret", http_client=http_client)
            with pytest.raises(ApolloRetryableError) as exc_info:
                await client.resolve_verified_owner(
                    route="A",
                    business_name="Northside Plumbing",
                    normalized_domain=None,
                    locality="Brisbane",
                )

        assert exc_info.value.retry_after_seconds == 30
        assert "private quota details" not in str(exc_info.value)

    asyncio.run(scenario())


def test_malformed_provider_response_is_rejected_without_echoing_payload() -> None:
    async def scenario() -> None:
        payload = {"organizations": "not-a-list"}
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)),
            base_url="https://api.apollo.io",
        ) as http_client:
            client = ApolloClient(api_key="apollo-secret", http_client=http_client)
            with pytest.raises(ApolloAPIError, match="malformed response") as exc_info:
                await client.resolve_verified_owner(
                    route="A",
                    business_name="Northside Plumbing",
                    normalized_domain=None,
                    locality="Brisbane",
                )

        assert repr(payload) not in str(exc_info.value)

    asyncio.run(scenario())


def test_from_env_requires_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("APOLLO_API_KEY", raising=False)
    monkeypatch.setenv("DOTENV_PATH", "missing-dotenv-file")

    with pytest.raises(MissingApolloAPIKeyError, match="APOLLO_API_KEY"):
        ApolloClient.from_env()

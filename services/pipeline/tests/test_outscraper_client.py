from __future__ import annotations

import asyncio

import httpx
import pytest

from clients.outscraper_client import (
    MissingOutscraperAPIKeyError,
    OutscraperAPIError,
    OutscraperClient,
    OutscraperRequest,
    OutscraperRetryableError,
)


def test_submit_google_maps_search_uses_fixed_async_australian_contract() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(202, json={"id": "request-123", "status": "Pending"})

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = OutscraperClient(api_key="outscraper-secret", http_client=http_client)
            result = await client.submit_google_maps_search(
                ["Plumber Brisbane QLD", "Gas fitter Logan QLD"], total_limit=500
            )

        assert result == OutscraperRequest("request-123", "Pending", [])
        assert len(requests) == 1
        request = requests[0]
        assert request.method == "GET"
        assert request.url.path == "/google-maps-search"
        assert request.url.params.get_list("query") == [
            "Plumber Brisbane QLD",
            "Gas fitter Logan QLD",
        ]
        assert request.url.params["limit"] == "100"
        assert request.url.params["totalLimit"] == "500"
        assert request.url.params["dropDuplicates"] == "true"
        assert request.url.params["region"] == "AU"
        assert request.url.params["language"] == "en"
        assert request.url.params["async"] == "true"
        assert "place_id" in request.url.params["fields"]
        assert "name" in request.url.params["fields"]
        assert request.headers["X-API-KEY"] == "outscraper-secret"

    asyncio.run(scenario())


def test_get_request_flattens_nested_success_data_and_retains_malformed_objects() -> None:
    async def scenario() -> None:
        payload = {
            "id": "request-123",
            "status": "Success",
            "data": [
                [{"place_id": "place-1", "name": "Northside Plumbing"}],
                [{"name": "Missing identity"}],
            ],
        }
        transport = httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = OutscraperClient(api_key="secret", http_client=http_client)
            result = await client.get_request("request-123")

        assert result == OutscraperRequest(
            request_id="request-123",
            status="Success",
            data=[
                {"place_id": "place-1", "name": "Northside Plumbing"},
                {"name": "Missing identity"},
            ],
        )

    asyncio.run(scenario())


def test_get_request_uses_flat_poll_contract() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={"id": "request-123", "status": "Pending"})

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = OutscraperClient(api_key="secret", http_client=http_client)
            await client.get_request("request-123")

        assert str(requests[0].url) == "https://api.outscraper.com/requests/request-123?flat=true"

    asyncio.run(scenario())


def test_get_request_maps_empty_204_to_terminal_provider_failure() -> None:
    async def scenario() -> None:
        transport = httpx.MockTransport(lambda _: httpx.Response(204))
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = OutscraperClient(api_key="secret", http_client=http_client)
            result = await client.get_request("request-123")

        assert result == OutscraperRequest("request-123", "Failure", [])

    asyncio.run(scenario())


def test_submit_maps_empty_204_to_terminal_provider_failure() -> None:
    async def scenario() -> None:
        transport = httpx.MockTransport(lambda _: httpx.Response(204))
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = OutscraperClient(api_key="secret", http_client=http_client)
            result = await client.submit_google_maps_search(["Plumber Brisbane QLD"], 500)

        assert result == OutscraperRequest("", "Failure", [])

    asyncio.run(scenario())


def test_retryable_status_preserves_numeric_retry_after_without_provider_body() -> None:
    async def scenario() -> None:
        transport = httpx.MockTransport(
            lambda _: httpx.Response(
                429,
                headers={"Retry-After": "45"},
                json={"error": "private account details"},
            )
        )
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = OutscraperClient(api_key="secret", http_client=http_client)
            with pytest.raises(OutscraperRetryableError) as exc_info:
                await client.get_request("request-123")

        assert exc_info.value.retry_after_seconds == 45
        assert "private account details" not in str(exc_info.value)

    asyncio.run(scenario())


def test_permanent_status_is_not_retryable() -> None:
    async def scenario() -> None:
        transport = httpx.MockTransport(lambda _: httpx.Response(401))
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = OutscraperClient(api_key="secret", http_client=http_client)
            with pytest.raises(OutscraperAPIError) as exc_info:
                await client.get_request("request-123")

        assert not isinstance(exc_info.value, OutscraperRetryableError)

    asyncio.run(scenario())


@pytest.mark.parametrize("status", ["Pending", "Failure"])
def test_get_request_accepts_provider_terminal_states(status: str) -> None:
    async def scenario() -> None:
        transport = httpx.MockTransport(
            lambda _: httpx.Response(200, json={"id": "request-123", "status": status})
        )
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = OutscraperClient(api_key="secret", http_client=http_client)
            result = await client.get_request("request-123")

        assert result.status == status
        assert result.data == []

    asyncio.run(scenario())


def test_from_env_requires_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OUTSCRAPER_API_KEY", raising=False)
    monkeypatch.setenv("DOTENV_PATH", "missing-dotenv-file")

    with pytest.raises(MissingOutscraperAPIKeyError, match="OUTSCRAPER_API_KEY"):
        OutscraperClient.from_env()


def test_api_error_omits_secret_and_provider_body() -> None:
    async def scenario() -> None:
        secret = "outscraper-secret"
        provider_body = "customer@example.com exceeded quota"
        transport = httpx.MockTransport(
            lambda _: httpx.Response(429, json={"error": provider_body})
        )
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = OutscraperClient(api_key=secret, http_client=http_client)
            with pytest.raises(OutscraperAPIError) as exc_info:
                await client.get_request("request-123")

        message = str(exc_info.value)
        assert "429" in message
        assert secret not in message
        assert provider_body not in message
        assert "response body omitted" in message

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "payload",
    [
        [],
        {"id": "request-123", "status": "Unknown"},
        {"status": "Success", "data": []},
        {"id": "request-123", "status": "Success", "data": "not-a-list"},
    ],
)
def test_malformed_provider_response_is_rejected_without_echoing_payload(payload: object) -> None:
    async def scenario() -> None:
        transport = httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = OutscraperClient(api_key="secret", http_client=http_client)
            with pytest.raises(OutscraperAPIError, match="malformed response") as exc_info:
                await client.get_request("request-123")

        assert repr(payload) not in str(exc_info.value)

    asyncio.run(scenario())

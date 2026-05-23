from __future__ import annotations

import asyncio

import httpx
import pytest

from clients.instantly_client import InstantlyAPIError, InstantlyClient


def test_add_lead_to_campaign_sends_bearer_auth_and_documented_body() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={"id": "lead-123"})

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = InstantlyClient(api_key="secret-key", http_client=http_client)

            result = await client.add_lead_to_campaign(
                {
                    "campaign": "campaign-123",
                    "email": "example@example.com",
                    "personalization": "Hello there",
                    "website": "https://example.com",
                    "last_name": "Doe",
                    "first_name": "John",
                    "company_name": "Example Inc.",
                    "phone": "+1234567890",
                    "custom_variables": {"lead_id": "lead-uuid"},
                }
            )

        assert result == {"id": "lead-123"}
        assert len(requests) == 1
        request = requests[0]
        assert request.method == "POST"
        assert str(request.url) == "https://api.instantly.ai/api/v2/leads"
        assert request.headers["Authorization"] == "Bearer secret-key"
        assert request.headers["Content-Type"] == "application/json"
        assert request.read()
        assert request.content == (
            b'{"campaign":"campaign-123","email":"example@example.com",'
            b'"personalization":"Hello there","website":"https://example.com",'
            b'"last_name":"Doe","first_name":"John","company_name":"Example Inc.",'
            b'"phone":"+1234567890","custom_variables":{"lead_id":"lead-uuid"}}'
        )

    asyncio.run(scenario())


def test_from_env_loads_api_key_from_dotenv_path(tmp_path, monkeypatch) -> None:
    dotenv_path = tmp_path / ".env.local"
    dotenv_path.write_text("INSTANTLY_API_KEY=dotenv-secret\n", encoding="utf-8")

    monkeypatch.delenv("INSTANTLY_API_KEY", raising=False)
    monkeypatch.setenv("DOTENV_PATH", str(dotenv_path))

    client = InstantlyClient.from_env()

    assert isinstance(client, InstantlyClient)


def test_add_lead_to_campaign_raises_for_non_2xx_response() -> None:
    async def scenario() -> None:
        transport = httpx.MockTransport(lambda _: httpx.Response(429, json={"error": "limit"}))
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = InstantlyClient(api_key="secret-key", http_client=http_client)

            with pytest.raises(InstantlyAPIError, match="429"):
                await client.add_lead_to_campaign(
                    {"campaign": "campaign-123", "email": "example@example.com"}
                )

    asyncio.run(scenario())


def test_api_error_does_not_include_response_body_with_possible_pii() -> None:
    async def scenario() -> None:
        response_body = {
            "error": "Lead brett@stonebuilders.com.au already exists",
            "phone": "+61400000001",
        }
        transport = httpx.MockTransport(lambda _: httpx.Response(400, json=response_body))
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = InstantlyClient(api_key="secret-key", http_client=http_client)

            with pytest.raises(InstantlyAPIError) as exc_info:
                await client.add_lead_to_campaign(
                    {"campaign": "campaign-123", "email": "brett@stonebuilders.com.au"}
                )

        message = str(exc_info.value)
        assert "400" in message
        assert "brett@stonebuilders.com.au" not in message
        assert "+61400000001" not in message
        assert "response body omitted" in message

    asyncio.run(scenario())


def test_pause_and_unsubscribe_are_patch_lead_wrappers() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={"id": "lead-123"})

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = InstantlyClient(api_key="secret-key", http_client=http_client)
            await client.pause_lead("lead-123")
            await client.unsubscribe_lead("lead-123")

        assert [request.method for request in requests] == ["PATCH", "PATCH"]
        assert [str(request.url) for request in requests] == [
            "https://api.instantly.ai/api/v2/leads/lead-123",
            "https://api.instantly.ai/api/v2/leads/lead-123",
        ]
        assert requests[0].read()
        assert requests[0].content == b'{"status":-1}'
        assert requests[1].read()
        assert requests[1].content == b'{"lt_interest_status":-1}'

    asyncio.run(scenario())

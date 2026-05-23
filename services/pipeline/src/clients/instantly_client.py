from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

import httpx

from env import load_pipeline_env

_DEFAULT_BASE_URL = "https://api.instantly.ai"


class MissingInstantlyAPIKeyError(RuntimeError):
    """Raised when Instantly API credentials are absent."""


class InstantlyAPIError(RuntimeError):
    """Raised for non-success responses from the Instantly API."""


class InstantlyClient:
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
    def from_env(cls) -> InstantlyClient:
        load_pipeline_env()
        api_key = os.getenv("INSTANTLY_API_KEY")
        if not api_key:
            raise MissingInstantlyAPIKeyError("Missing env var: INSTANTLY_API_KEY")
        return cls(api_key=api_key)

    async def add_lead_to_campaign(self, payload: Mapping[str, object]) -> dict[str, object]:
        return await self._request("POST", "/api/v2/leads", json=dict(payload))

    async def pause_lead(self, instantly_lead_id: str) -> dict[str, object]:
        return await self._request(
            "PATCH",
            f"/api/v2/leads/{instantly_lead_id}",
            json={"status": -1},
        )

    async def unsubscribe_lead(self, instantly_lead_id: str) -> dict[str, object]:
        return await self._request(
            "PATCH",
            f"/api/v2/leads/{instantly_lead_id}",
            json={"lt_interest_status": -1},
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, object],
    ) -> dict[str, object]:
        headers = {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}
        if self._http_client is None:
            async with httpx.AsyncClient(timeout=30) as http_client:
                return await self._send(http_client, method, path, headers=headers, json=json)
        return await self._send(self._http_client, method, path, headers=headers, json=json)

    async def _send(
        self,
        http_client: httpx.AsyncClient,
        method: str,
        path: str,
        *,
        headers: dict[str, str],
        json: dict[str, object],
    ) -> dict[str, object]:
        response = await http_client.request(
            method,
            f"{self._base_url}{path}",
            headers=headers,
            json=json,
        )
        if response.status_code != 200:
            raise InstantlyAPIError(
                f"Instantly API {method} {path} failed with {response.status_code}; "
                "response body omitted"
            )
        data: Any = response.json()
        if not isinstance(data, dict):
            raise InstantlyAPIError(f"Instantly API {method} {path} returned a non-object response")
        return data

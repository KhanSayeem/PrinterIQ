from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from typing import Any, cast

import httpx

from env import load_pipeline_env

_DEFAULT_BASE_URL = "https://api.instantly.ai"

# Repeated query parameters, in the shape httpx accepts for them. Spelled out
# rather than `list[tuple[str, str]]` because that is invariant in its value
# type and will not pass to httpx.
QueryParams = list[tuple[str, str | int | float | bool | None]]


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
        return await self._request("POST", "/api/v2/leads/add", json=dict(payload))

    async def fetch_campaign_analytics(
        self,
        *,
        campaign_ids: Sequence[str],
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> list[dict[str, object]]:
        """Read per-campaign send and bounce counts from Instantly.

        `GET /api/v2/campaigns/analytics` answers with one object per campaign
        carrying `emails_sent_count` and `bounced_count`, so unlike every other
        call on this client the useful response is a list rather than an
        object. `campaign_id` is repeated once per campaign, and the dates are
        `YYYY-MM-DD`, which is why the caller formats them rather than passing
        a datetime.
        """
        params: QueryParams = [("campaign_id", campaign_id) for campaign_id in campaign_ids]
        if start_date is not None:
            params.append(("start_date", start_date))
        if end_date is not None:
            params.append(("end_date", end_date))
        return await self._request_list("GET", "/api/v2/campaigns/analytics", params=params)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, object],
    ) -> dict[str, object]:
        data = await self._request_json(method, path, json=json)
        if not isinstance(data, dict):
            raise InstantlyAPIError(f"Instantly API {method} {path} returned a non-object response")
        return data

    async def _request_list(
        self,
        method: str,
        path: str,
        *,
        params: QueryParams,
    ) -> list[dict[str, object]]:
        data = await self._request_json(method, path, params=params)
        # Instantly's list endpoints are inconsistent: some answer with a bare
        # array and some wrap it in `items`. Both are accepted, and anything
        # else raises rather than silently reading as an empty result, because
        # an empty result here is indistinguishable from a campaign that has
        # not sent anything.
        if isinstance(data, list):
            rows: list[object] = data
        elif isinstance(data, dict) and isinstance(data.get("items"), list):
            rows = list(cast(list[object], data["items"]))
        else:
            raise InstantlyAPIError(f"Instantly API {method} {path} returned a non-list response")

        for row in rows:
            if not isinstance(row, dict):
                raise InstantlyAPIError(
                    f"Instantly API {method} {path} returned a non-object list entry"
                )
        return cast(list[dict[str, object]], rows)

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, object] | None = None,
        params: QueryParams | None = None,
    ) -> Any:
        headers = {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}
        if self._http_client is None:
            async with httpx.AsyncClient(timeout=30) as http_client:
                return await self._send(
                    http_client, method, path, headers=headers, json=json, params=params
                )
        return await self._send(
            self._http_client, method, path, headers=headers, json=json, params=params
        )

    async def _send(
        self,
        http_client: httpx.AsyncClient,
        method: str,
        path: str,
        *,
        headers: dict[str, str],
        json: dict[str, object] | None,
        params: QueryParams | None = None,
    ) -> Any:
        response = await http_client.request(
            method,
            f"{self._base_url}{path}",
            headers=headers,
            json=json,
            params=params,
        )
        if response.status_code != 200:
            raise InstantlyAPIError(
                f"Instantly API {method} {path} failed with {response.status_code}; "
                "response body omitted"
            )
        data: Any = response.json()
        return data

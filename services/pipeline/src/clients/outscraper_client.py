from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Literal, cast
from urllib.parse import quote

import httpx

from env import load_pipeline_env

_DEFAULT_BASE_URL = "https://api.outscraper.com"
_GOOGLE_MAPS_FIELDS = (
    "place_id",
    "name",
    "site",
    "website",
    "phone",
    "address",
    "full_address",
    "city",
    "state",
    "postal_code",
    "latitude",
    "longitude",
    "category",
    "subtypes",
    "rating",
    "reviews",
    "business_status",
    "location_link",
)
OutscraperStatus = Literal["Pending", "Success", "Failure"]


class MissingOutscraperAPIKeyError(RuntimeError):
    """Raised when the server-side Outscraper credential is absent."""


class OutscraperAPIError(RuntimeError):
    """Raised when Outscraper transport or response validation fails."""


class OutscraperRetryableError(OutscraperAPIError):
    """Raised for transient provider failures that may be retried safely."""

    def __init__(self, message: str, *, retry_after_seconds: int | None = None) -> None:
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


@dataclass(frozen=True)
class OutscraperRequest:
    request_id: str
    status: OutscraperStatus
    data: list[dict[str, object]]


class OutscraperClient:
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
    def from_env(cls) -> OutscraperClient:
        load_pipeline_env()
        api_key = os.getenv("OUTSCRAPER_API_KEY")
        if not api_key:
            raise MissingOutscraperAPIKeyError("Missing env var: OUTSCRAPER_API_KEY")
        return cls(api_key=api_key)

    async def submit_google_maps_search(
        self,
        queries: list[str],
        total_limit: int,
    ) -> OutscraperRequest:
        parameter_items: list[tuple[str, str | int | float | bool | None]] = [
            ("query", query) for query in queries
        ]
        parameter_items.extend(
            [
                ("limit", 100),
                ("totalLimit", total_limit),
                ("dropDuplicates", "true"),
                ("region", "AU"),
                ("language", "en"),
                ("async", "true"),
                ("fields", ",".join(_GOOGLE_MAPS_FIELDS)),
            ]
        )
        return await self._request(
            "/google-maps-search", params=httpx.QueryParams(parameter_items)
        )

    async def get_request(self, request_id: str) -> OutscraperRequest:
        path = f"/requests/{quote(request_id, safe='')}"
        return await self._request(
            path,
            params=httpx.QueryParams({"flat": "true"}),
            empty_failure_request_id=request_id,
        )

    async def _request(
        self,
        path: str,
        *,
        params: httpx.QueryParams,
        empty_failure_request_id: str | None = None,
    ) -> OutscraperRequest:
        headers = {"X-API-KEY": self._api_key}
        if self._http_client is None:
            async with httpx.AsyncClient(timeout=30) as http_client:
                return await self._send(
                    http_client,
                    path,
                    headers=headers,
                    params=params,
                    empty_failure_request_id=empty_failure_request_id,
                )
        return await self._send(
            self._http_client,
            path,
            headers=headers,
            params=params,
            empty_failure_request_id=empty_failure_request_id,
        )

    async def _send(
        self,
        http_client: httpx.AsyncClient,
        path: str,
        *,
        headers: dict[str, str],
        params: httpx.QueryParams,
        empty_failure_request_id: str | None,
    ) -> OutscraperRequest:
        try:
            response = await http_client.get(
                f"{self._base_url}{path}",
                headers=headers,
                params=params,
            )
        except httpx.HTTPError as error:
            raise OutscraperRetryableError(
                f"Outscraper API GET {path} failed in transport; response body omitted"
            ) from error
        if response.status_code == 204:
            return OutscraperRequest(empty_failure_request_id or "", "Failure", [])
        if not 200 <= response.status_code < 300:
            error_type = (
                OutscraperRetryableError
                if response.status_code == 429 or response.status_code >= 500
                else OutscraperAPIError
            )
            error_kwargs = (
                {"retry_after_seconds": _retry_after_seconds(response)}
                if error_type is OutscraperRetryableError
                else {}
            )
            raise error_type(
                f"Outscraper API GET {path} failed with {response.status_code}; "
                "response body omitted",
                **error_kwargs,
            )
        try:
            payload: Any = response.json()
        except ValueError as error:
            raise OutscraperAPIError(
                f"Outscraper API GET {path} returned a malformed response"
            ) from error
        return _parse_request(payload, path=path)


def _parse_request(payload: object, *, path: str) -> OutscraperRequest:
    if not isinstance(payload, dict):
        raise OutscraperAPIError(f"Outscraper API GET {path} returned a malformed response")

    request_id = payload.get("id")
    status = payload.get("status")
    if not isinstance(request_id, str) or status not in {"Pending", "Success", "Failure"}:
        raise OutscraperAPIError(f"Outscraper API GET {path} returned a malformed response")

    data_value = payload.get("data", [])
    if not isinstance(data_value, list):
        raise OutscraperAPIError(f"Outscraper API GET {path} returned a malformed response")

    data: list[dict[str, object]] = []
    for group in data_value:
        records = group if isinstance(group, list) else [group]
        for record in records:
            if not isinstance(record, dict):
                raise OutscraperAPIError(
                    f"Outscraper API GET {path} returned a malformed response"
                )
            data.append(cast(dict[str, object], record))

    return OutscraperRequest(
        request_id=request_id,
        status=cast(OutscraperStatus, status),
        data=data,
    )


def _retry_after_seconds(response: httpx.Response) -> int | None:
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    try:
        seconds = int(value)
    except ValueError:
        return None
    return max(0, min(seconds, 3600))

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import ssl
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import ParseResult, urljoin, urlparse, urlunparse

import httpx

_MAX_REDIRECTS = 5
_DEFAULT_MAX_BODY_BYTES = 64 * 1024
DEFAULT_TIMEOUT_SECONDS = 8.0
DEFAULT_RETRY_DELAY_SECONDS = 1.0


class ProspectWebsiteResolver:
    def __init__(
        self,
        *,
        http_client: httpx.AsyncClient | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_body_bytes: int = _DEFAULT_MAX_BODY_BYTES,
        resolve_dns: bool = True,
        retry_delay_seconds: float = DEFAULT_RETRY_DELAY_SECONDS,
    ) -> None:
        self._http_client = http_client
        self._timeout_seconds = timeout_seconds
        self._max_body_bytes = max_body_bytes
        self._resolve_dns = resolve_dns
        self._retry_delay_seconds = retry_delay_seconds

    async def resolve(self, url: str) -> dict[str, object]:
        unsafe = None if self._resolve_dns else await _unsafe_reason(url, resolve_dns=False)
        if unsafe:
            return _failed_evidence(url, unsafe)
        if self._http_client is None:
            async with httpx.AsyncClient(
                timeout=self._timeout_seconds,
                follow_redirects=False,
                headers={"User-Agent": "PrinterIQ prospect website resolver/1.0"},
            ) as http_client:
                return await self._resolve_with_client(http_client, url)
        return await self._resolve_with_client(self._http_client, url)

    async def _resolve_with_client(
        self, http_client: httpx.AsyncClient, url: str
    ) -> dict[str, object]:
        last_error: str | None = None
        final_url = url
        for attempt in range(2):
            try:
                fetched = await self._fetch_with_redirects(http_client, url)
                return {
                    "resolved_website_url": fetched.final_url,
                    "website_status_code": fetched.status_code,
                    "website_fetch_failures": 0,
                    "website_title": _title(fetched.body),
                    "website_text": _visible_text(fetched.body),
                    "website_body_truncated": fetched.truncated,
                }
            except UnsafeURL as error:
                return _failed_evidence(error.url, error.reason, failures=1)
            except (
                httpx.HTTPError,
                OSError,
                TimeoutError,
                asyncio.IncompleteReadError,
                asyncio.LimitOverrunError,
            ) as error:
                last_error = error.__class__.__name__
                if attempt == 0 and self._retry_delay_seconds > 0:
                    await asyncio.sleep(self._retry_delay_seconds)
        return _failed_evidence(final_url, last_error or "HTTPError")

    async def _fetch_with_redirects(
        self, http_client: httpx.AsyncClient, url: str
    ) -> FetchedWebsite:
        current_url = url
        for redirect_count in range(_MAX_REDIRECTS + 1):
            try:
                target = await _request_target(
                    current_url,
                    resolve_dns=self._resolve_dns,
                    timeout_seconds=self._timeout_seconds,
                )
            except UnsafeURL as error:
                if redirect_count > 0:
                    raise UnsafeURL(error.url, "unsafe_redirect") from error
                raise
            if self._resolve_dns:
                fetched = await _fetch_pinned_target(
                    target,
                    timeout_seconds=self._timeout_seconds,
                    max_body_bytes=self._max_body_bytes,
                )
                if 300 <= fetched.status_code < 400 and fetched.location:
                    current_url = urljoin(target.evidence_url, fetched.location)
                    continue
                return fetched
            async with http_client.stream(
                "GET",
                target.evidence_url,
                follow_redirects=False,
            ) as response:
                if 300 <= response.status_code < 400 and response.headers.get("location"):
                    current_url = urljoin(target.evidence_url, str(response.headers["location"]))
                    continue
                body, truncated = await _read_limited_text(response, self._max_body_bytes)
                return FetchedWebsite(
                    final_url=target.evidence_url,
                    status_code=response.status_code,
                    body=body,
                    truncated=truncated,
                )
        raise UnsafeURL(current_url, "too_many_redirects")


@dataclass(frozen=True)
class FetchedWebsite:
    final_url: str
    status_code: int
    body: str
    truncated: bool
    location: str | None = None


@dataclass(frozen=True)
class RequestTarget:
    evidence_url: str
    connect_host: str
    port: int
    use_tls: bool
    tls_server_hostname: str | None
    host_header: str
    request_target: str


class UnsafeURL(RuntimeError):
    def __init__(self, url: str, reason: str) -> None:
        super().__init__(reason)
        self.url = url
        self.reason = reason


def merge_website_evidence(
    source_payload: Mapping[str, object],
    evidence: Mapping[str, object],
) -> dict[str, object]:
    merged = dict(source_payload)
    for key, value in evidence.items():
        if value is not None:
            merged[key] = value
    return merged


async def _request_target(
    url: str,
    *,
    resolve_dns: bool,
    timeout_seconds: float,
) -> RequestTarget:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise UnsafeURL(url, "unsafe_url")
    host = parsed.hostname.casefold()
    if host == "localhost" or host.endswith(".localhost"):
        raise UnsafeURL(url, "unsafe_url")
    port = _safe_port(parsed)
    if port is None:
        raise UnsafeURL(url, "unsafe_url")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        if not resolve_dns:
            return _target_for_host(parsed, url, host)
        resolved_ip = await _safe_resolved_ip(
            host,
            port,
            timeout_seconds=timeout_seconds,
            unsafe_url=url,
        )
        if resolved_ip is None:
            raise httpx.ConnectError("dns_resolution_failed") from None
        return _target_for_host(parsed, url, str(resolved_ip), tls_hostname=host)
    if _is_unsafe_ip(ip):
        raise UnsafeURL(url, "unsafe_url")
    return _target_for_host(parsed, url, host)


async def _fetch_pinned_target(
    target: RequestTarget,
    *,
    timeout_seconds: float,
    max_body_bytes: int,
) -> FetchedWebsite:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    ssl_context = ssl.create_default_context() if target.use_tls else None
    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(
            host=target.connect_host,
            port=target.port,
            ssl=ssl_context,
            server_hostname=target.tls_server_hostname,
        ),
        timeout=timeout_seconds,
    )
    try:
        request = (
            f"GET {target.request_target} HTTP/1.1\r\n"
            f"Host: {target.host_header}\r\n"
            "User-Agent: PrinterIQ prospect website resolver/1.0\r\n"
            "Accept: text/html,application/xhtml+xml\r\n"
            "Connection: close\r\n\r\n"
        )
        writer.write(request.encode("ascii"))
        timeout = _remaining_timeout(deadline)
        await asyncio.wait_for(writer.drain(), timeout=timeout)
        timeout = _remaining_timeout(deadline)
        raw_head = await asyncio.wait_for(
            reader.readuntil(b"\r\n\r\n"),
            timeout=timeout,
        )
        status_code, headers = _parse_response_headers(
            raw_head.decode("iso-8859-1", errors="replace")
        )
        body, truncated = await _read_limited_stream_body(
            reader,
            max_body_bytes=max_body_bytes,
            deadline=deadline,
        )
        return FetchedWebsite(
            final_url=target.evidence_url,
            status_code=status_code,
            body=body,
            truncated=truncated,
            location=headers.get("location"),
        )
    finally:
        writer.close()
        close_timeout = _optional_remaining_timeout(deadline)
        if close_timeout is not None:
            try:
                await asyncio.wait_for(writer.wait_closed(), timeout=close_timeout)
            except (OSError, TimeoutError, ssl.SSLError):
                pass


async def _read_limited_text(
    response: httpx.Response, max_body_bytes: int
) -> tuple[str, bool]:
    chunks: list[bytes] = []
    total = 0
    truncated = False
    async for chunk in response.aiter_bytes():
        if not chunk:
            continue
        remaining = max_body_bytes - total
        if remaining <= 0:
            truncated = True
            break
        chunks.append(chunk[:remaining])
        total += min(len(chunk), remaining)
        if len(chunk) > remaining:
            truncated = True
            break
    return b"".join(chunks).decode(response.encoding or "utf-8", errors="replace"), truncated


async def _read_limited_stream_body(
    reader: asyncio.StreamReader,
    *,
    max_body_bytes: int,
    deadline: float,
) -> tuple[str, bool]:
    chunks: list[bytes] = []
    total = 0
    truncated = False
    while total < max_body_bytes:
        timeout = _remaining_timeout(deadline)
        chunk = await asyncio.wait_for(
            reader.read(min(8192, max_body_bytes - total)),
            timeout=timeout,
        )
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    if total == max_body_bytes:
        timeout = _remaining_timeout(deadline)
        extra = await asyncio.wait_for(reader.read(1), timeout=timeout)
        truncated = bool(extra)
    return b"".join(chunks).decode("utf-8", errors="replace"), truncated


def _remaining_timeout(deadline: float) -> float:
    remaining = deadline - asyncio.get_running_loop().time()
    if remaining <= 0:
        raise TimeoutError
    return remaining


def _optional_remaining_timeout(deadline: float) -> float | None:
    remaining = deadline - asyncio.get_running_loop().time()
    return remaining if remaining > 0 else None


def _parse_response_headers(header_text: str) -> tuple[int, dict[str, str]]:
    lines = header_text.split("\r\n")
    status_parts = lines[0].split()
    status_code = int(status_parts[1]) if len(status_parts) > 1 else 0
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if not line or ":" not in line:
            continue
        key, value = line.split(":", maxsplit=1)
        headers[key.strip().casefold()] = value.strip()
    return status_code, headers


async def _unsafe_reason(url: str, *, resolve_dns: bool) -> str | None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return "unsafe_url"
    host = parsed.hostname.casefold()
    if host == "localhost" or host.endswith(".localhost"):
        return "unsafe_url"
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        if not resolve_dns:
            return None
        port = _safe_port(parsed)
        if port is None:
            return "unsafe_url"
        return await _unsafe_dns_reason(host, port)
    return "unsafe_url" if _is_unsafe_ip(ip) else None


async def _unsafe_dns_reason(host: str, port: int) -> str | None:
    try:
        resolved_ip = await _safe_resolved_ip(
            host,
            port,
            timeout_seconds=8.0,
            unsafe_url=host,
        )
    except UnsafeURL:
        return "unsafe_url"
    return None if resolved_ip is not None else "unsafe_url"


async def _safe_resolved_ip(
    host: str,
    port: int,
    *,
    timeout_seconds: float,
    unsafe_url: str,
) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        addresses = await asyncio.wait_for(
            asyncio.to_thread(socket.getaddrinfo, host, port),
            timeout=timeout_seconds,
        )
    except (OSError, TimeoutError):
        return None
    resolved: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for address in addresses:
        raw_ip = address[4][0]
        try:
            ip = ipaddress.ip_address(raw_ip)
        except ValueError:
            raise UnsafeURL(unsafe_url, "unsafe_url") from None
        if _is_unsafe_ip(ip):
            raise UnsafeURL(unsafe_url, "unsafe_url")
        resolved.append(ip)
    return resolved[0] if resolved else None


def _target_for_host(
    parsed: ParseResult,
    evidence_url: str,
    connect_host: str,
    *,
    tls_hostname: str | None = None,
) -> RequestTarget:
    return RequestTarget(
        evidence_url=evidence_url,
        connect_host=connect_host,
        port=_safe_port(parsed) or _default_port(parsed.scheme),
        use_tls=parsed.scheme == "https",
        tls_server_hostname=tls_hostname if parsed.scheme == "https" else None,
        host_header=_host_header(parsed),
        request_target=_origin_form(parsed),
    )


def _origin_form(parsed: ParseResult) -> str:
    path = urlunparse(("", "", parsed.path or "/", parsed.params, parsed.query, ""))
    return path or "/"


def _host_header(parsed: ParseResult) -> str:
    host = parsed.hostname or ""
    if parsed.port is None:
        return host
    return f"{host}:{parsed.port}"


def _default_port(scheme: str) -> int:
    return 443 if scheme == "https" else 80


def _is_unsafe_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return not ip.is_global


def _safe_port(parsed: ParseResult) -> int | None:
    try:
        return parsed.port or _default_port(parsed.scheme)
    except ValueError:
        return None


def _failed_evidence(url: str, error: str, *, failures: int = 2) -> dict[str, object]:
    return {
        "resolved_website_url": url,
        "website_fetch_failures": failures,
        "website_error": error,
    }


def _title(html: str) -> str | None:
    match = re.search(r"<title[^>]*>(.*?)</title>", html, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return None
    return re.sub(r"\s+", " ", match.group(1)).strip()


def _visible_text(html: str) -> str:
    without_scripts = re.sub(
        r"<(script|style)[^>]*>.*?</\1>",
        " ",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    text = re.sub(r"<[^>]+>", " ", without_scripts)
    return re.sub(r"\s+", " ", text).strip()[:4000]

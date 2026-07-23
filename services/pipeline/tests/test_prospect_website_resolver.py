from __future__ import annotations

import asyncio
import socket

import httpx
import pytest

from clients import prospect_website_resolver
from clients.prospect_website_resolver import ProspectWebsiteResolver


def test_resolver_follows_redirects_and_captures_final_url_evidence() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.host == "northside.example":
                return httpx.Response(
                    302,
                    headers={"Location": "https://facebook.com/northsideplumbing"},
                )
            return httpx.Response(
                200,
                text="<title>Northside Plumbing</title><main>Emergency plumber</main>",
            )

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport, follow_redirects=True) as client:
            evidence = await ProspectWebsiteResolver(
                http_client=client,
                resolve_dns=False,
            ).resolve(
                "https://northside.example"
            )

        assert [request.method for request in requests] == ["GET", "GET"]
        assert evidence["resolved_website_url"] == "https://facebook.com/northsideplumbing"
        assert evidence["website_title"] == "Northside Plumbing"
        assert evidence["website_fetch_failures"] == 0

    asyncio.run(scenario())


def test_resolver_blocks_private_and_local_network_urls_without_fetching() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, text="<title>Internal</title>")

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            evidence = await ProspectWebsiteResolver(http_client=client).resolve(
                "http://169.254.169.254/latest/meta-data"
            )

        assert requests == []
        assert evidence["resolved_website_url"] == "http://169.254.169.254/latest/meta-data"
        assert evidence["website_fetch_failures"] == 1
        assert evidence["website_error"] == "unsafe_url"

    asyncio.run(scenario())


def test_resolver_treats_malformed_port_as_unsafe_without_fetching() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []
        transport = httpx.MockTransport(
            lambda request: requests.append(request) or httpx.Response(200)
        )
        async with httpx.AsyncClient(transport=transport) as client:
            evidence = await ProspectWebsiteResolver(http_client=client).resolve(
                "https://example.com:notaport/path"
            )

        assert requests == []
        assert evidence["resolved_website_url"] == "https://example.com:notaport/path"
        assert evidence["website_fetch_failures"] == 1
        assert evidence["website_error"] == "unsafe_url"

    asyncio.run(scenario())


def test_resolver_blocks_shared_carrier_nat_ip_without_fetching() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []
        transport = httpx.MockTransport(
            lambda request: requests.append(request) or httpx.Response(200)
        )
        async with httpx.AsyncClient(transport=transport) as client:
            evidence = await ProspectWebsiteResolver(http_client=client).resolve(
                "http://100.64.0.1/admin"
            )

        assert requests == []
        assert evidence["resolved_website_url"] == "http://100.64.0.1/admin"
        assert evidence["website_fetch_failures"] == 1
        assert evidence["website_error"] == "unsafe_url"

    asyncio.run(scenario())


def test_resolver_blocks_dns_to_shared_carrier_nat_without_fetching(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def fake_getaddrinfo(host: str, port: int):
            assert host == "carrier.example"
            return [
                (
                    socket.AF_INET,
                    socket.SOCK_STREAM,
                    socket.IPPROTO_TCP,
                    "",
                    ("100.64.0.1", port),
                )
            ]

        monkeypatch.setattr(prospect_website_resolver.socket, "getaddrinfo", fake_getaddrinfo)
        transport = httpx.MockTransport(
            lambda request: requests.append(request) or httpx.Response(200)
        )
        async with httpx.AsyncClient(transport=transport) as client:
            evidence = await ProspectWebsiteResolver(http_client=client).resolve(
                "https://carrier.example/admin"
            )

        assert requests == []
        assert evidence["resolved_website_url"] == "https://carrier.example/admin"
        assert evidence["website_fetch_failures"] == 1
        assert evidence["website_error"] == "unsafe_url"

    asyncio.run(scenario())


def test_resolver_blocks_redirects_to_private_network_urls_before_fetching_target() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(302, headers={"Location": "http://127.0.0.1/admin"})

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            evidence = await ProspectWebsiteResolver(
                http_client=client,
                resolve_dns=False,
            ).resolve(
                "https://northside.example"
            )

        assert [str(request.url) for request in requests] == ["https://northside.example"]
        assert evidence["resolved_website_url"] == "http://127.0.0.1/admin"
        assert evidence["website_fetch_failures"] == 1
        assert evidence["website_error"] == "unsafe_redirect"

    asyncio.run(scenario())


def test_resolver_fetches_the_validated_ip_with_original_host_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        connections: list[dict[str, object]] = []

        class FakeWriter:
            def __init__(self) -> None:
                self.data = bytearray()

            def write(self, data: bytes) -> None:
                self.data.extend(data)

            async def drain(self) -> None:
                return None

            def close(self) -> None:
                return None

            async def wait_closed(self) -> None:
                return None

        def fake_getaddrinfo(host: str, port: int):
            assert host == "rebind.example"
            assert port == 443
            return [
                (
                    socket.AF_INET,
                    socket.SOCK_STREAM,
                    socket.IPPROTO_TCP,
                    "",
                    ("93.184.216.34", port),
                )
            ]

        async def fake_open_connection(**kwargs: object):
            reader = asyncio.StreamReader()
            reader.feed_data(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Length: 21\r\n"
                b"\r\n"
                b"<title>Pinned</title>"
            )
            reader.feed_eof()
            writer = FakeWriter()
            connections.append(kwargs | {"writer": writer})
            return reader, writer

        monkeypatch.setattr(prospect_website_resolver.socket, "getaddrinfo", fake_getaddrinfo)
        monkeypatch.setattr(
            prospect_website_resolver.asyncio,
            "open_connection",
            fake_open_connection,
        )
        evidence = await ProspectWebsiteResolver().resolve("https://rebind.example/path")

        assert connections[0]["host"] == "93.184.216.34"
        assert connections[0]["port"] == 443
        assert connections[0]["server_hostname"] == "rebind.example"
        request = bytes(connections[0]["writer"].data).decode("ascii")
        assert request.startswith("GET /path HTTP/1.1\r\n")
        assert "Host: rebind.example\r\n" in request
        assert evidence["resolved_website_url"] == "https://rebind.example/path"
        assert evidence["website_fetch_failures"] == 0

    asyncio.run(scenario())


def test_resolver_body_read_uses_absolute_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        writers: list[FakeWriter] = []

        class FakeWriter:
            def __init__(self) -> None:
                self.wait_closed_calls = 0

            def write(self, data: bytes) -> None:
                return None

            async def drain(self) -> None:
                return None

            def close(self) -> None:
                return None

            async def wait_closed(self) -> None:
                self.wait_closed_calls += 1
                return None

        def fake_getaddrinfo(host: str, port: int):
            assert host == "slow.example"
            return [
                (
                    socket.AF_INET,
                    socket.SOCK_STREAM,
                    socket.IPPROTO_TCP,
                    "",
                    ("93.184.216.34", port),
                )
            ]

        async def fake_open_connection(**_: object):
            reader = asyncio.StreamReader()
            reader.feed_data(b"HTTP/1.1 200 OK\r\n\r\n")
            writer = FakeWriter()
            writers.append(writer)
            return reader, writer

        monkeypatch.setattr(prospect_website_resolver.socket, "getaddrinfo", fake_getaddrinfo)
        monkeypatch.setattr(
            prospect_website_resolver.asyncio,
            "open_connection",
            fake_open_connection,
        )

        evidence = await ProspectWebsiteResolver(timeout_seconds=0.01).resolve(
            "https://slow.example/path"
        )

        assert evidence["resolved_website_url"] == "https://slow.example/path"
        assert evidence["website_fetch_failures"] == 2
        assert evidence["website_error"] == "TimeoutError"
        assert [writer.wait_closed_calls for writer in writers] == [0, 0]

    asyncio.run(scenario())


def test_resolver_dns_lookup_uses_resolver_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        connections: list[object] = []
        dns_attempts = 0

        async def fake_to_thread(function: object, *args: object):
            nonlocal dns_attempts
            del function, args
            dns_attempts += 1
            await asyncio.sleep(1)

        async def fake_open_connection(**kwargs: object):
            connections.append(kwargs)
            raise AssertionError("resolver should not fetch after DNS timeout")

        monkeypatch.setattr(prospect_website_resolver.asyncio, "to_thread", fake_to_thread)
        monkeypatch.setattr(
            prospect_website_resolver.asyncio,
            "open_connection",
            fake_open_connection,
        )

        evidence = await ProspectWebsiteResolver(timeout_seconds=0.01).resolve(
            "https://slow-dns.example/path"
        )

        assert connections == []
        assert dns_attempts == 2
        assert evidence["resolved_website_url"] == "https://slow-dns.example/path"
        assert evidence["website_fetch_failures"] == 2
        assert evidence["website_error"] == "ConnectError"

    asyncio.run(scenario())


def test_resolver_streams_only_the_configured_body_limit() -> None:
    async def scenario() -> None:
        body = "<title>Northside Plumbing</title>" + ("A" * 5000)
        transport = httpx.MockTransport(lambda _: httpx.Response(200, text=body))
        async with httpx.AsyncClient(transport=transport) as client:
            evidence = await ProspectWebsiteResolver(
                http_client=client,
                max_body_bytes=64,
                resolve_dns=False,
            ).resolve("https://northside.example")

        assert evidence["website_title"] == "Northside Plumbing"
        assert len(str(evidence["website_text"])) <= 64
        assert evidence["website_body_truncated"] is True

    asyncio.run(scenario())


def test_resolver_collects_placeholder_text_without_interactions() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                200,
                text="<title>Coming soon</title><button>Call now</button>",
            )

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport, follow_redirects=True) as client:
            evidence = await ProspectWebsiteResolver(
                http_client=client,
                resolve_dns=False,
            ).resolve(
                "https://placeholder.example"
            )

        assert [request.method for request in requests] == ["GET"]
        assert evidence["website_title"] == "Coming soon"
        assert "Call now" in str(evidence["website_text"])

    asyncio.run(scenario())


def test_resolver_requires_two_failed_fetches_before_inaccessible_evidence() -> None:
    async def scenario() -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            raise httpx.ConnectError("network unavailable", request=request)

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport, follow_redirects=True) as client:
            evidence = await ProspectWebsiteResolver(
                http_client=client,
                resolve_dns=False,
            ).resolve(
                "https://offline.example"
            )

        assert attempts == 2
        assert evidence["resolved_website_url"] == "https://offline.example"
        assert evidence["website_fetch_failures"] == 2
        assert evidence["website_error"] == "ConnectError"

    asyncio.run(scenario())


def test_resolver_recovers_when_first_fetch_fails_and_second_succeeds() -> None:
    async def scenario() -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise httpx.ConnectError("temporary failure", request=request)
            return httpx.Response(200, text="<title>Recovered</title>")

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            evidence = await ProspectWebsiteResolver(
                http_client=client,
                resolve_dns=False,
            ).resolve(
                "https://northside.example"
            )

        assert attempts == 2
        assert evidence["resolved_website_url"] == "https://northside.example"
        assert evidence["website_fetch_failures"] == 0
        assert evidence["website_title"] == "Recovered"

    asyncio.run(scenario())

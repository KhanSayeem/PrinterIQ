from __future__ import annotations

import asyncio
import sys
import types
from typing import Any

import pytest

from clients import playwright_audit as playwright_audit_module
from clients.playwright_audit import PlaywrightAuditor
from weaknesses import Weakness


class FakePlaywrightError(Exception):
    """Stand-in for playwright.async_api.Error, the base navigation error.

    Real examples seen in production: net::ERR_NAME_NOT_RESOLVED,
    net::ERR_CERT_COMMON_NAME_INVALID, net::ERR_CONNECTION_REFUSED.
    """


class FakeTimeoutError(Exception):
    """Stand-in for playwright.async_api.TimeoutError."""


class _FakeResponse:
    def __init__(self, status: int) -> None:
        self.status = status


class _FakePage:
    def __init__(
        self,
        *,
        status: int = 200,
        has_viewport_meta: bool = True,
        has_title: bool = True,
        has_meta_description: bool = True,
        has_h1: bool = True,
        html: str = "<html></html>",
        raise_timeout: bool = False,
        raise_nav_error: str | None = None,
        nav_error_urls: dict[str, str] | None = None,
        timeout_urls: set[str] | None = None,
        status_by_url: dict[str, int] | None = None,
    ) -> None:
        self._status = status
        self._nav_error_urls = nav_error_urls or {}
        self._timeout_urls = timeout_urls or set()
        self._status_by_url = status_by_url or {}
        self._eval_answers = {
            "() => !!document.querySelector('meta[name=\"viewport\"]')": has_viewport_meta,
            "() => !!document.title": has_title,
            "() => !!document.querySelector('meta[name=\"description\"]')": has_meta_description,
            "() => !!document.querySelector('h1')": has_h1,
        }
        self._html = html
        self._raise_timeout = raise_timeout
        self._raise_nav_error = raise_nav_error
        self.goto_calls: list[dict[str, Any]] = []
        self.closed = False

    async def goto(self, url: str, timeout: int, wait_until: str) -> _FakeResponse:
        self.goto_calls.append({"url": url, "timeout": timeout, "wait_until": wait_until})
        if url in self._timeout_urls:
            raise FakeTimeoutError("timed out")
        if url in self._nav_error_urls:
            raise FakePlaywrightError(self._nav_error_urls[url])
        if self._raise_timeout:
            raise FakeTimeoutError("timed out")
        if self._raise_nav_error:
            raise FakePlaywrightError(self._raise_nav_error)
        return _FakeResponse(self._status_by_url.get(url, self._status))

    async def evaluate(self, script: str) -> bool:
        return self._eval_answers[script]

    async def content(self) -> str:
        return self._html

    async def close(self) -> None:
        self.closed = True


class _FakeBrowser:
    def __init__(self, page: _FakePage) -> None:
        self._page = page
        self.new_page_calls: list[dict[str, Any]] = []
        self.closed = False

    async def new_page(self, **kwargs: Any) -> _FakePage:
        self.new_page_calls.append(kwargs)
        return self._page

    async def close(self) -> None:
        self.closed = True


class _FakeChromium:
    def __init__(self, browser: _FakeBrowser) -> None:
        self._browser = browser

    async def launch(self) -> _FakeBrowser:
        return self._browser


class _FakePlaywrightContext:
    def __init__(self, browser: _FakeBrowser) -> None:
        self.chromium = _FakeChromium(browser)

    async def __aenter__(self) -> _FakePlaywrightContext:
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> bool:
        return False


class _FakeLoop:
    def __init__(self, times: list[float]) -> None:
        self._times = iter(times)

    def time(self) -> float:
        return next(self._times)


class _FakeAsyncioModule:
    """Stand-in for the `asyncio` module as seen by playwright_audit.py.

    Only `get_event_loop` is exercised by the code under test, so that is
    all this shim needs to provide.
    """

    def __init__(self, times: list[float]) -> None:
        self._loop = _FakeLoop(times)

    def get_event_loop(self) -> _FakeLoop:
        return self._loop


def _install_fake_playwright_module(monkeypatch: pytest.MonkeyPatch, browser: _FakeBrowser) -> None:
    def async_playwright() -> _FakePlaywrightContext:
        return _FakePlaywrightContext(browser)

    fake_async_api = types.SimpleNamespace(
        Error=FakePlaywrightError,
        TimeoutError=FakeTimeoutError,
        async_playwright=async_playwright,
    )
    fake_playwright_pkg = types.SimpleNamespace(async_api=fake_async_api)

    monkeypatch.setitem(sys.modules, "playwright", fake_playwright_pkg)
    monkeypatch.setitem(sys.modules, "playwright.async_api", fake_async_api)


def _run_audit(
    browser: _FakeBrowser,
    monkeypatch: pytest.MonkeyPatch,
    *,
    times: list[float],
    url: str = "https://example.com",
) -> dict[str, object]:
    _install_fake_playwright_module(monkeypatch, browser)
    monkeypatch.setattr(playwright_audit_module, "asyncio", _FakeAsyncioModule(times))

    async def scenario() -> dict[str, object]:
        return await PlaywrightAuditor().audit(url)

    return asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Mobile emulation
# ---------------------------------------------------------------------------


def test_audit_runs_under_mobile_emulation(monkeypatch: pytest.MonkeyPatch) -> None:
    page = _FakePage()
    browser = _FakeBrowser(page)

    _run_audit(browser, monkeypatch, times=[0.0, 1.0])

    assert browser.new_page_calls == [
        {"viewport": {"width": 390, "height": 844, "isMobile": True}}
    ]


# ---------------------------------------------------------------------------
# slow_load threshold
# ---------------------------------------------------------------------------


def test_load_ms_over_threshold_emits_slow_load(monkeypatch: pytest.MonkeyPatch) -> None:
    page = _FakePage()
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 5.001])

    assert result["load_ms"] == 5001
    assert Weakness.SLOW_LOAD in result["weaknesses"]


def test_load_ms_under_threshold_does_not_emit_slow_load(monkeypatch: pytest.MonkeyPatch) -> None:
    page = _FakePage()
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 4.999])

    assert result["load_ms"] == 4999
    assert Weakness.SLOW_LOAD not in result["weaknesses"]


def test_load_ms_exactly_at_threshold_does_not_emit_slow_load(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The threshold is strictly-greater-than: 'over 5 seconds' does not
    include exactly 5 seconds."""
    page = _FakePage()
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 5.0])

    assert result["load_ms"] == 5000
    assert Weakness.SLOW_LOAD not in result["weaknesses"]


# ---------------------------------------------------------------------------
# Canonical weakness labels
# ---------------------------------------------------------------------------


def test_all_measured_weaknesses_use_canonical_labels(monkeypatch: pytest.MonkeyPatch) -> None:
    page = _FakePage(
        has_viewport_meta=False,
        has_title=False,
        has_meta_description=False,
        has_h1=False,
    )
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 5.001])

    assert set(result["weaknesses"]) == {
        Weakness.NO_MOBILE,
        Weakness.NO_META_TITLE,
        Weakness.NO_META_DESCRIPTION,
        Weakness.NO_H1,
        Weakness.SLOW_LOAD,
    }


def test_https_url_does_not_emit_no_ssl(monkeypatch: pytest.MonkeyPatch) -> None:
    page = _FakePage()
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 1.0], url="https://example.com")

    assert Weakness.NO_SSL not in result["weaknesses"]


def test_http_url_emits_no_ssl(monkeypatch: pytest.MonkeyPatch) -> None:
    page = _FakePage()
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 1.0], url="http://example.com")

    assert Weakness.NO_SSL in result["weaknesses"]


# ---------------------------------------------------------------------------
# Unreachable / failed audit handling preserved exactly
# ---------------------------------------------------------------------------


def test_error_status_returns_unreachable_shape_with_no_weaknesses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = _FakePage(status=500)
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 1.0])

    assert result["is_reachable"] is False
    assert result["has_site"] is True
    assert result["weaknesses"] == []
    assert result["has_h1"] is None
    assert result["has_meta_title"] is None
    assert result["has_meta_description"] is None
    assert result["is_mobile_friendly"] is None
    assert result["has_ssl"] is None
    assert result["load_ms"] is None
    assert result["cms_detected"] is None
    assert result["raw_audit"] == {}


def test_timeout_returns_unreachable_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    page = _FakePage(raise_timeout=True)
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0])

    assert result["is_reachable"] is False
    assert result["weaknesses"] == []
    assert result["has_h1"] is None
    assert result["load_ms"] is None


# ---------------------------------------------------------------------------
# Navigation failures
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "nav_error",
    [
        "Page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.com/",
        "Page.goto: net::ERR_CERT_COMMON_NAME_INVALID at https://example.com/",
        "Page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/",
        "Page.goto: net::ERR_CONNECTION_CLOSED at https://example.com/",
    ],
)
def test_navigation_failure_reports_unreachable_instead_of_raising(
    monkeypatch: pytest.MonkeyPatch, nav_error: str
) -> None:
    """A site that will not load is a finding, not a crash.

    Only TimeoutError was caught, so any other navigation error escaped the
    auditor and dead-lettered the enrich job. Re-enriching production hit this
    on 15 of the first ~100 leads: dead domains, refused connections, and
    certificates that do not match the domain. Those leads produced no
    enrichment row at all, so they could never be assessed or re-run cleanly.
    """
    browser = _FakeBrowser(_FakePage(raise_nav_error=nav_error))

    result = _run_audit(browser, monkeypatch, times=[0.0, 1.0])

    assert result["is_reachable"] is False
    assert result["weaknesses"] == []
    assert result["load_ms"] is None


def test_navigation_failure_does_not_claim_a_weakness_it_could_not_measure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A bad certificate is tempting to record as no_ssl, but the page never
    loaded, so nothing was measured. Claiming otherwise is exactly the
    fabricated-weakness problem the grounding work exists to prevent."""
    browser = _FakeBrowser(
        _FakePage(raise_nav_error="Page.goto: net::ERR_CERT_COMMON_NAME_INVALID")
    )

    result = _run_audit(browser, monkeypatch, times=[0.0, 1.0])

    assert result["weaknesses"] == []
    assert result["has_ssl"] is None


# ---------------------------------------------------------------------------
# Blank URL: no site, no browser
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("blank_url", ["", "   ", "\t\n "])
def test_blank_url_returns_no_site_without_launching_a_browser(
    blank_url: str,
) -> None:
    """Safety net for any caller that hands the auditor an empty URL.

    workers.enrich no longer does, but page.goto("") raises, is caught as a
    navigation error, and returns _unreachable(), which asserts has_site True
    for a business that has no site at all. No playwright module is installed
    in this test on purpose: if the short-circuit is removed, the import of
    playwright.async_api is what fails, which is the proof that no browser
    was launched.
    """

    async def scenario() -> dict[str, object]:
        return await PlaywrightAuditor().audit(blank_url)

    result = asyncio.run(scenario())

    assert result["has_site"] is False
    assert result["is_reachable"] is False
    assert result["weaknesses"] == [Weakness.NO_WEBSITE]
    for field_name in (
        "is_mobile_friendly",
        "has_ssl",
        "has_meta_title",
        "has_meta_description",
        "has_h1",
        "load_ms",
        "cms_detected",
        "lighthouse_mobile_score",
    ):
        assert result[field_name] is None, field_name


def test_unreachable_still_reports_has_site_true(monkeypatch: pytest.MonkeyPatch) -> None:
    """Explicit regression guard so nobody tidies the two paths into one.

    A URL that exists but fails to load is evidence of a broken site, not
    evidence of no site. Merging no-site and unreachable would replace one
    wrong record with a different wrong record.
    """
    browser = _FakeBrowser(_FakePage(raise_nav_error="Page.goto: net::ERR_NAME_NOT_RESOLVED"))

    result = _run_audit(browser, monkeypatch, times=[0.0, 1.0])

    assert result["has_site"] is True
    assert result["is_reachable"] is False
    assert result["weaknesses"] == []


# ---------------------------------------------------------------------------
# Defensive normalisation at the audit boundary
# ---------------------------------------------------------------------------


def test_schemeless_url_is_normalised_before_navigation(monkeypatch: pytest.MonkeyPatch) -> None:
    """The audit must not depend on ingest having cleaned the value.

    252 leads are already in the database with the raw bare domain the
    Australian export supplies, and re-enriching them goes through this
    method with exactly that value. Chromium rejects a schemeless string,
    which surfaced as an unreachable record with an empty weaknesses array,
    and that empty array archives the lead in workers.qualify after the paid
    Haiku call has already been spent.
    """
    page = _FakePage()
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 1.0], url="cottellandco.com.au")

    assert [call["url"] for call in page.goto_calls] == ["https://cottellandco.com.au"]
    assert result["is_reachable"] is True
    assert result["raw_audit"] == {"url": "https://cottellandco.com.au", "status": 200}


def test_normalised_url_drives_has_ssl_not_the_raw_value(monkeypatch: pytest.MonkeyPatch) -> None:
    """The second victim on this path.

    `has_ssl` was a `startswith("https://")` test against the raw value, so
    a schemeless URL could never register SSL and always carried a `no_ssl`
    weakness, even for a site served entirely over TLS.
    """
    page = _FakePage()
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 1.0], url="example.com.au")

    assert result["has_ssl"] is True
    assert Weakness.NO_SSL not in result["weaknesses"]


def test_mixed_case_https_scheme_does_not_fabricate_a_no_ssl_weakness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = _FakePage()
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 1.0], url="HTTPS://example.com")

    assert page.goto_calls[0]["url"] == "https://example.com"
    assert result["has_ssl"] is True
    assert Weakness.NO_SSL not in result["weaknesses"]


def test_surrounding_whitespace_is_stripped_before_navigation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = _FakePage()
    browser = _FakeBrowser(page)

    _run_audit(browser, monkeypatch, times=[0.0, 1.0], url="  https://example.com  ")

    assert page.goto_calls[0]["url"] == "https://example.com"


# ---------------------------------------------------------------------------
# http fallback for a scheme we inferred
# ---------------------------------------------------------------------------


def test_inferred_https_falls_back_to_http_when_navigation_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An http-only site is a real business we should still reach.

    We guessed https for a bare domain, so a navigation failure on that
    guess is not evidence about the business, it is evidence about our
    guess. Recording it as unreachable produces the empty weaknesses array
    that archives the lead, which is exactly the failure this incident was.
    """
    page = _FakePage(
        nav_error_urls={
            "https://example.com.au": "Page.goto: net::ERR_SSL_PROTOCOL_ERROR",
        }
    )
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 0.0, 0.0, 1.0], url="example.com.au")

    assert [call["url"] for call in page.goto_calls] == [
        "https://example.com.au",
        "http://example.com.au",
    ]
    assert result["is_reachable"] is True
    assert result["has_site"] is True


def test_inferred_https_falls_back_to_http_after_a_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A host with no TLS listener commonly hangs rather than refusing, so
    the timeout path needs the same fallback as the error path."""
    page = _FakePage(timeout_urls={"https://example.com.au"})
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 0.0, 1.0], url="example.com.au")

    assert [call["url"] for call in page.goto_calls] == [
        "https://example.com.au",
        "http://example.com.au",
    ]
    assert result["is_reachable"] is True


def test_http_fallback_records_has_ssl_false(monkeypatch: pytest.MonkeyPatch) -> None:
    """has_ssl must reflect the scheme that actually loaded, not the one we
    guessed. The fallback loaded over http, so the site genuinely has no
    SSL and no_ssl is a measured weakness rather than an assumed one."""
    page = _FakePage(
        nav_error_urls={"https://example.com.au": "Page.goto: net::ERR_SSL_PROTOCOL_ERROR"}
    )
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 0.0, 0.0, 1.0], url="example.com.au")

    assert result["has_ssl"] is False
    assert Weakness.NO_SSL in result["weaknesses"]
    assert result["raw_audit"] == {"url": "http://example.com.au", "status": 200}


def test_successful_https_attempt_records_has_ssl_true_and_never_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other half of the has_ssl contract, plus the guarantee that a
    working site is never visited twice."""
    page = _FakePage()
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 1.0], url="example.com.au")

    assert len(page.goto_calls) == 1
    assert result["has_ssl"] is True
    assert Weakness.NO_SSL not in result["weaknesses"]


def test_inferred_https_falls_back_to_http_on_an_error_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Some hosts answer the https port with an error page rather than
    refusing the connection, which is still a failure of our guess."""
    page = _FakePage(status_by_url={"https://example.com.au": 502, "http://example.com.au": 200})
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 0.0, 0.0, 1.0], url="example.com.au")

    assert [call["url"] for call in page.goto_calls] == [
        "https://example.com.au",
        "http://example.com.au",
    ]
    assert result["is_reachable"] is True
    assert result["has_ssl"] is False


def test_source_supplied_https_is_never_retried_over_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The fallback is a correction to our own guess, not a downgrade policy.

    When the source said https and https failed, that is a fact about the
    site. Retrying over http would visit a URL nobody claimed exists and
    could report SSL findings for a host that never served the page.
    """
    page = _FakePage(raise_nav_error="Page.goto: net::ERR_CONNECTION_REFUSED")
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 1.0], url="https://example.com")

    assert [call["url"] for call in page.goto_calls] == ["https://example.com"]
    assert result["is_reachable"] is False
    assert result["weaknesses"] == []


def test_a_genuinely_dead_domain_is_still_unreachable_after_the_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Do not weaken the unreachable handling from PR #134.

    Both attempts failing is a real finding about a dead domain. It must
    still return the unreachable record rather than crashing, and must still
    claim no weakness it could not measure.
    """
    page = _FakePage(raise_nav_error="Page.goto: net::ERR_NAME_NOT_RESOLVED")
    browser = _FakeBrowser(page)

    result = _run_audit(browser, monkeypatch, times=[0.0, 1.0], url="dead-domain.com.au")

    assert [call["url"] for call in page.goto_calls] == [
        "https://dead-domain.com.au",
        "http://dead-domain.com.au",
    ]
    assert result["has_site"] is True
    assert result["is_reachable"] is False
    assert result["weaknesses"] == []
    assert result["has_ssl"] is None
    assert result["load_ms"] is None
    assert result["raw_audit"] == {}


def test_the_page_is_closed_once_even_when_both_attempts_fail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The retry runs inside the existing page lifecycle, so the finally
    block that closes it must not become conditional on a single attempt."""
    page = _FakePage(raise_nav_error="Page.goto: net::ERR_NAME_NOT_RESOLVED")
    browser = _FakeBrowser(page)

    _run_audit(browser, monkeypatch, times=[0.0, 1.0], url="dead-domain.com.au")

    assert page.closed is True
    assert browser.closed is True

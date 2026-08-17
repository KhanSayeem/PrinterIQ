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
    ) -> None:
        self._status = status
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
        if self._raise_timeout:
            raise FakeTimeoutError("timed out")
        if self._raise_nav_error:
            raise FakePlaywrightError(self._raise_nav_error)
        return _FakeResponse(self._status)

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

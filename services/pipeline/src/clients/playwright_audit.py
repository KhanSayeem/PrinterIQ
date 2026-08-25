from __future__ import annotations

import asyncio
import logging

from weaknesses import Weakness
from website_url import normalise_website_url

logger = logging.getLogger(__name__)

_TIMEOUT_MS = 30_000

# Ported from clients.prospect_website_audit._MOBILE_VIEWPORT so this audit
# measures the site the way a mobile visitor actually experiences it — our
# email copy says "on mobile", so the audit must run under mobile emulation.
_MOBILE_VIEWPORT = {"width": 390, "height": 844, "isMobile": True}

# "over 5 seconds" is the exact claim made in customer-facing copy, so the
# threshold is strictly-greater-than 5000ms, not inclusive of it.
_SLOW_LOAD_THRESHOLD_MS = 5_000

_CMS_MARKERS: dict[str, list[str]] = {
    "WordPress": ["wp-content", "wp-includes"],
    "Wix": ["wix.com", "wixstatic.com"],
    "Squarespace": ["squarespace.com"],
    "Shopify": ["cdn.shopify.com", "shopify.com"],
}


class PlaywrightAuditor:
    """Playwright-backed website auditor. Browser lifecycle is fully managed inside."""

    async def audit(self, url: str) -> dict[str, object]:
        # Short-circuit before the playwright import, so no browser is
        # launched and no dependency is touched for a URL there is nothing
        # to visit. page.goto("") raises, which the navigation handler below
        # catches and answers with _unreachable() — and _unreachable() says
        # has_site True, which is the wrong record for a business with no
        # site. workers.enrich decides this authoritatively from the lead
        # row and never calls here with a blank URL; this is the net for any
        # other caller.
        if not url.strip():
            return _no_site()

        from playwright.async_api import Error as _PlaywrightError  # type: ignore[import-untyped]
        from playwright.async_api import TimeoutError as _Timeout  # type: ignore[import-untyped]
        from playwright.async_api import async_playwright  # type: ignore[import-untyped]

        # Normalised here as well as at ingest, deliberately. workers.ingest
        # now stores a well-formed value, but 252 leads are already in the
        # database holding the raw bare domain the Australian export supplies,
        # and re-enriching them arrives here with exactly that string.
        # page.goto rejects a schemeless URL, which produced _unreachable()
        # and its empty weaknesses array, and that array archives the lead in
        # workers.qualify after the paid Haiku call. Normalising at this
        # boundary means no caller, and no historical row, can reproduce it.
        normalised = normalise_website_url(url)
        if not normalised.url:
            return _no_site()

        # The http retry exists for one specific case: we guessed https for a
        # schemeless value, and the guess failed. That failure is evidence
        # about our guess, not about the business, and an http-only site is a
        # real business we should still reach. When the source supplied the
        # scheme there is nothing to correct, so no second attempt is made
        # and a failure stays the honest finding it was.
        attempts = [normalised.url]
        if normalised.scheme_was_inferred:
            attempts.append("http://" + normalised.url.removeprefix("https://"))

        async with async_playwright() as p:
            browser = await p.chromium.launch()
            try:
                page = await browser.new_page(viewport=_MOBILE_VIEWPORT)
                try:
                    for attempt_url in attempts:
                        loop = asyncio.get_event_loop()
                        start = loop.time()
                        try:
                            response = await page.goto(
                                attempt_url, timeout=_TIMEOUT_MS, wait_until="domcontentloaded"
                            )
                        except _Timeout:
                            logger.warning("Playwright 30s timeout for %s", attempt_url)
                            continue
                        except _PlaywrightError as exc:
                            # A site that will not load is a finding, not a
                            # crash. Only _Timeout was caught before, so a
                            # dead domain, a refused connection or a
                            # certificate that does not match the domain
                            # escaped the auditor and dead-lettered the enrich
                            # job, leaving the lead with no enrichment row at
                            # all. Re-enriching production hit this on 15 of
                            # the first hundred leads.
                            #
                            # Deliberately does not record a weakness. A bad
                            # certificate is tempting to log as no_ssl, but
                            # the page never loaded and nothing was measured;
                            # asserting otherwise is the fabricated-weakness
                            # problem the grounding work exists to prevent.
                            # is_reachable = False is the honest signal, and
                            # the empty weaknesses array archives the lead on
                            # the derived gate.
                            logger.warning(
                                "Playwright navigation failed for %s: %s",
                                attempt_url,
                                str(exc).splitlines()[0],
                            )
                            continue

                        load_ms = int((loop.time() - start) * 1000)
                        if response is None or response.status >= 400:
                            continue

                        return await _measure_loaded_page(
                            page, url=attempt_url, status=response.status, load_ms=load_ms
                        )

                    return _unreachable()
                finally:
                    await page.close()
            finally:
                await browser.close()


async def _measure_loaded_page(
    page: object, *, url: str, status: int, load_ms: int
) -> dict[str, object]:
    """Measure a page that actually loaded, over the scheme that loaded it.

    `url` is the attempt that succeeded, not the value the caller passed in.
    That distinction is the whole point: has_ssl must describe the scheme the
    site really answered on. When the https guess failed and the http
    fallback is what loaded, the site genuinely has no SSL, so no_ssl becomes
    a measured weakness rather than an assumed one. Reading the scheme off
    the caller's raw string, which is what this code used to do, meant a
    schemeless URL could never register SSL at all.
    """
    has_ssl = url.startswith("https://")
    is_mobile = bool(
        await page.evaluate("() => !!document.querySelector('meta[name=\"viewport\"]')")
    )
    has_title = bool(await page.evaluate("() => !!document.title"))
    has_meta_desc = bool(
        await page.evaluate("() => !!document.querySelector('meta[name=\"description\"]')")
    )
    has_h1 = bool(await page.evaluate("() => !!document.querySelector('h1')"))
    html: str = await page.content()
    cms = _detect_cms(html)

    weaknesses: list[str] = []
    if not is_mobile:
        weaknesses.append(Weakness.NO_MOBILE)
    if not has_ssl:
        weaknesses.append(Weakness.NO_SSL)
    if not has_title:
        weaknesses.append(Weakness.NO_META_TITLE)
    if not has_meta_desc:
        weaknesses.append(Weakness.NO_META_DESCRIPTION)
    if not has_h1:
        weaknesses.append(Weakness.NO_H1)
    if load_ms > _SLOW_LOAD_THRESHOLD_MS:
        weaknesses.append(Weakness.SLOW_LOAD)

    return {
        "has_site": True,
        "is_reachable": True,
        "is_mobile_friendly": is_mobile,
        "has_ssl": has_ssl,
        "has_meta_title": has_title,
        "has_meta_description": has_meta_desc,
        "has_h1": has_h1,
        "load_ms": load_ms,
        "cms_detected": cms,
        "lighthouse_mobile_score": None,
        "weaknesses": weaknesses,
        "raw_audit": {"url": url, "status": status},
    }


def _detect_cms(html: str) -> str | None:
    for cms, markers in _CMS_MARKERS.items():
        if any(m in html for m in markers):
            return cms
    return None


def _no_site() -> dict[str, object]:
    """A business with no website URL at all.

    Deliberately distinct from _unreachable(). No site and a site that will
    not load are different facts about a business, and collapsing them would
    replace one wrong record with a different wrong record. The one weakness
    recorded here is the absence itself, which is measurable without a
    browser; everything a browser would have measured stays None.
    """
    return {
        "has_site": False,
        "is_reachable": False,
        "is_mobile_friendly": None,
        "has_ssl": None,
        "has_meta_title": None,
        "has_meta_description": None,
        "has_h1": None,
        "load_ms": None,
        "cms_detected": None,
        "lighthouse_mobile_score": None,
        "weaknesses": [Weakness.NO_WEBSITE],
        "raw_audit": {},
    }


def _unreachable() -> dict[str, object]:
    return {
        "has_site": True,
        "is_reachable": False,
        "is_mobile_friendly": None,
        "has_ssl": None,
        "has_meta_title": None,
        "has_meta_description": None,
        "has_h1": None,
        "load_ms": None,
        "cms_detected": None,
        "lighthouse_mobile_score": None,
        "weaknesses": [],
        "raw_audit": {},
    }

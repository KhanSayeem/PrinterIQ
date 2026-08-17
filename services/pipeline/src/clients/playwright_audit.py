from __future__ import annotations

import asyncio
import logging

from weaknesses import Weakness

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
        from playwright.async_api import Error as _PlaywrightError  # type: ignore[import-untyped]
        from playwright.async_api import TimeoutError as _Timeout  # type: ignore[import-untyped]
        from playwright.async_api import async_playwright  # type: ignore[import-untyped]

        async with async_playwright() as p:
            browser = await p.chromium.launch()
            try:
                page = await browser.new_page(viewport=_MOBILE_VIEWPORT)
                try:
                    loop = asyncio.get_event_loop()
                    start = loop.time()
                    response = await page.goto(
                        url, timeout=_TIMEOUT_MS, wait_until="domcontentloaded"
                    )
                    load_ms = int((loop.time() - start) * 1000)

                    if response is None or response.status >= 400:
                        return _unreachable()

                    has_ssl = url.startswith("https://")
                    is_mobile = bool(
                        await page.evaluate(
                            "() => !!document.querySelector('meta[name=\"viewport\"]')"
                        )
                    )
                    has_title = bool(await page.evaluate("() => !!document.title"))
                    has_meta_desc = bool(
                        await page.evaluate(
                            "() => !!document.querySelector('meta[name=\"description\"]')"
                        )
                    )
                    has_h1 = bool(
                        await page.evaluate("() => !!document.querySelector('h1')")
                    )
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
                        "raw_audit": {"url": url, "status": response.status},
                    }

                except _Timeout:
                    logger.warning("Playwright 30s timeout for %s", url)
                    return _unreachable()
                except _PlaywrightError as exc:
                    # A site that will not load is a finding, not a crash.
                    # Only _Timeout was caught before, so a dead domain, a
                    # refused connection or a certificate that does not match
                    # the domain escaped the auditor and dead-lettered the
                    # enrich job, leaving the lead with no enrichment row at
                    # all. Re-enriching production hit this on 15 of the first
                    # hundred leads.
                    #
                    # Deliberately does not record a weakness. A bad
                    # certificate is tempting to log as no_ssl, but the page
                    # never loaded and nothing was measured; asserting
                    # otherwise is the fabricated-weakness problem the
                    # grounding work exists to prevent. is_reachable = False
                    # is the honest signal, and the empty weaknesses array
                    # archives the lead on the derived gate.
                    logger.warning(
                        "Playwright navigation failed for %s: %s",
                        url,
                        str(exc).splitlines()[0],
                    )
                    return _unreachable()
                finally:
                    await page.close()
            finally:
                await browser.close()


def _detect_cms(html: str) -> str | None:
    for cms, markers in _CMS_MARKERS.items():
        if any(m in html for m in markers):
            return cms
    return None


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

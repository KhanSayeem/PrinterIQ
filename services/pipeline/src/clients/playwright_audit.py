from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)

_TIMEOUT_MS = 30_000

_CMS_MARKERS: dict[str, list[str]] = {
    "WordPress": ["wp-content", "wp-includes"],
    "Wix": ["wix.com", "wixstatic.com"],
    "Squarespace": ["squarespace.com"],
    "Shopify": ["cdn.shopify.com", "shopify.com"],
}


class PlaywrightAuditor:
    """Playwright-backed website auditor. Browser lifecycle is fully managed inside."""

    async def audit(self, url: str) -> dict[str, object]:
        from playwright.async_api import TimeoutError as _Timeout  # type: ignore[import-untyped]
        from playwright.async_api import async_playwright  # type: ignore[import-untyped]

        async with async_playwright() as p:
            browser = await p.chromium.launch()
            try:
                page = await browser.new_page()
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
                        weaknesses.append("no_mobile")
                    if not has_ssl:
                        weaknesses.append("no_ssl")
                    if not has_title:
                        weaknesses.append("no_meta_title")
                    if not has_meta_desc:
                        weaknesses.append("no_meta_description")
                    if not has_h1:
                        weaknesses.append("no_h1")

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

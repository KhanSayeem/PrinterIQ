from __future__ import annotations

import asyncio
import importlib
import re
from typing import Any
from urllib.parse import urlparse

_TIMEOUT_MS = 30_000
_MOBILE_VIEWPORT = {"width": 390, "height": 844, "isMobile": True}
_CTA_TERMS = ("quote", "contact", "book", "call", "estimate")
_SERVICE_TERMS = (
    "blocked drain",
    "hot water",
    "gas fitting",
    "leak",
    "toilet",
    "tap",
    "emergency plumbing",
    "drainage",
)
_SUBURBS = (
    "brisbane",
    "logan",
    "ipswich",
    "moreton bay",
    "redlands",
    "north lakes",
    "springfield",
    "cleveland",
    "caboolture",
)


class ProspectWebsiteAuditor:
    async def audit(self, url: str) -> dict[str, object]:
        playwright_api = importlib.import_module("playwright.async_api")
        async_playwright = playwright_api.async_playwright
        playwright_timeout = playwright_api.TimeoutError

        async with async_playwright() as p:
            browser = await p.chromium.launch()
            try:
                page = await browser.new_page(viewport=_MOBILE_VIEWPORT)
                try:
                    loop = asyncio.get_running_loop()
                    start = loop.time()
                    response = await page.goto(
                        url,
                        timeout=_TIMEOUT_MS,
                        wait_until="domcontentloaded",
                    )
                    dom_content_ms = int((loop.time() - start) * 1000)
                    final_url = page.url
                    status_code = response.status if response is not None else 0
                    if response is None or status_code >= 400:
                        return _failed(final_url, status_code)
                    title = await page.title()
                    h1 = await _first_text(page, "h1")
                    html = await page.content()
                    text = _visible_text(html)
                    return {
                        "final_url": final_url,
                        "status_code": status_code,
                        "fetch_failures": 0,
                        "title": title,
                        "h1": h1,
                        "visible_text": text[:4000],
                        "has_mobile_viewport": "viewport" in html.casefold(),
                        "has_horizontal_overflow": await page.evaluate(
                            "() => document.documentElement.scrollWidth > window.innerWidth + 1"
                        ),
                        "dom_content_ms": dom_content_ms,
                        "has_visible_tel_link": await _has_visible_link(page, "a[href^='tel:']"),
                        "has_mobile_primary_cta": await _has_mobile_cta(page),
                        "has_contact_form": await page.locator("form").count() > 0,
                        "has_mailto_link": await page.locator("a[href^='mailto:']").count() > 0,
                        "has_emergency_or_hours_text": _has_terms(
                            text, ("24/7", "emergency", "after hours", "open")
                        ),
                        "displayed_phone": _phone(text),
                        "mentions_greater_brisbane": _has_terms(
                            text, ("greater brisbane", "brisbane", "logan", "ipswich")
                        ),
                        "named_suburbs": [
                            suburb for suburb in _SUBURBS if suburb in text.casefold()
                        ],
                        "has_service_area_page": _has_terms(
                            text, ("service area", "areas we service")
                        ),
                        "has_nap_consistency": bool(_phone(text))
                        and bool(urlparse(final_url).hostname),
                        "has_local_business_schema": "LocalBusiness" in html,
                        "has_credentials_or_identity": _has_terms(
                            text, ("licensed", "qbcc", "insured", "abn")
                        ),
                        "has_testimonials_or_reviews": _has_terms(
                            text, ("testimonial", "review", "stars", "google rating")
                        ),
                        "has_project_photos": await page.locator("img").count() >= 3,
                        "has_about_or_team": _has_terms(
                            text, ("about us", "our team", "family owned")
                        ),
                        "has_privacy_and_contact_details": _has_terms(text, ("privacy", "contact")),
                        "has_service_pages_or_sections": _has_terms(
                            text, ("services", "plumbing services")
                        ),
                        "plumbing_services": [
                            service for service in _SERVICE_TERMS if service in text.casefold()
                        ],
                        "has_meaningful_service_copy": len(text.split()) >= 120,
                        "has_faq_or_guidance": _has_terms(
                            text, ("faq", "frequently asked", "tips")
                        ),
                    }
                except playwright_timeout:
                    return _failed(url, 0, error="timeout")
                finally:
                    await page.close()
            finally:
                await browser.close()


async def _has_visible_link(page: Any, selector: str) -> bool:
    locator = page.locator(selector)
    count = await locator.count()
    for index in range(count):
        if await locator.nth(index).is_visible():
            return True
    return False


async def _first_text(page: Any, selector: str) -> str | None:
    try:
        value = await page.locator(selector).first.text_content(timeout=500)
        return value if isinstance(value, str) and value.strip() else None
    except Exception:
        return None


async def _has_mobile_cta(page: Any) -> bool:
    links = page.locator("a, button")
    count = await links.count()
    for index in range(min(count, 80)):
        item = links.nth(index)
        if not await item.is_visible():
            continue
        box = await item.bounding_box()
        if not box or box.get("y", 9999) > 844:
            continue
        text = (await item.text_content()) or ""
        if any(term in text.casefold() for term in _CTA_TERMS):
            return True
    return False


def _failed(url: str, status_code: int, *, error: str = "unreachable") -> dict[str, object]:
    return {
        "final_url": url,
        "status_code": status_code,
        "fetch_failures": 2,
        "website_error": error,
    }


def _visible_text(html: str) -> str:
    without_scripts = re.sub(
        r"<(script|style)[^>]*>.*?</\1>",
        " ",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    text = re.sub(r"<[^>]+>", " ", without_scripts)
    return re.sub(r"\s+", " ", text).strip()


def _has_terms(text: str, terms: tuple[str, ...]) -> bool:
    lowered = text.casefold()
    return any(term in lowered for term in terms)


def _phone(text: str) -> str | None:
    match = re.search(r"(?:\+?61|0)\s?[2378](?:[\s.-]?\d){8}", text)
    return match.group(0) if match else None

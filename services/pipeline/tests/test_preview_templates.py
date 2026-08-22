from __future__ import annotations

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PREVIEW_TEMPLATE_DIR = REPO_ROOT / "services" / "pipeline" / "src" / "templates" / "previews"
MANIFEST_PATH = REPO_ROOT / "image-download-manifest.json"
NGINX_PREVIEW_CONFIG_PATH = REPO_ROOT / "nginx" / "preview.presciaiq.com.conf"

EXPECTED_TOKEN_COUNT = 20
EXPECTED_TEMPLATE_IMAGE_REFS = 15
TEMPLATE_NAMES = [
    "business",
    "concreting",
    "electrical",
    "general",
    "hvac",
    "landscaping",
    "plumbing",
]
# The one template that must work for a business of any kind, and is the
# fallback for every industry no trade template claims.
NEUTRAL_TEMPLATE_NAME = "business"
EXPECTED_TOKENS = {
    "{{ABOUT_BLURB}}",
    "{{BUSINESS_NAME}}",
    "{{CITY}}",
    "{{EMAIL}}",
    "{{FOUNDER_NAME}}",
    "{{PHONE}}",
    "{{SERVICE_1_DESC}}",
    "{{SERVICE_1_TITLE}}",
    "{{SERVICE_2_DESC}}",
    "{{SERVICE_2_TITLE}}",
    "{{SERVICE_3_DESC}}",
    "{{SERVICE_3_TITLE}}",
    "{{SERVICE_4_DESC}}",
    "{{SERVICE_4_TITLE}}",
    "{{SERVICE_5_DESC}}",
    "{{SERVICE_5_TITLE}}",
    "{{SERVICE_6_DESC}}",
    "{{SERVICE_6_TITLE}}",
    "{{STATE}}",
    "{{YEAR_FOUNDED}}",
}
REMOVED_TOKENS = {
    "{{FIRST_NAME}}",
    "{{PREVIEW_URL}}",
    "{{TAGLINE}}",
    "{{WEAKNESS_CALLOUT}}",
}

TOKEN_RE = re.compile(r"\{\{[A-Z0-9_]+\}\}")
LOCAL_PREVIEW_IMAGE_RE = re.compile(r"['\"](/assets/previews/[^'\"]+\.jpg)['\"]")


def _expected_image_paths(template_name: str) -> set[str]:
    return {
        f"/assets/previews/{template_name}/hero.jpg",
        f"/assets/previews/{template_name}/fullbleed-1.jpg",
        f"/assets/previews/{template_name}/fullbleed-2.jpg",
        f"/assets/previews/{template_name}/project-1.jpg",
        f"/assets/previews/{template_name}/project-2.jpg",
        f"/assets/previews/{template_name}/project-3.jpg",
        f"/assets/previews/{template_name}/project-4.jpg",
        f"/assets/previews/{template_name}/project-5.jpg",
        "/assets/previews/shared/avatar-1.jpg",
        "/assets/previews/shared/avatar-2.jpg",
        "/assets/previews/shared/avatar-3.jpg",
        "/assets/previews/shared/sector-civic.jpg",
        "/assets/previews/shared/sector-commercial.jpg",
        "/assets/previews/shared/sector-hospitality.jpg",
        "/assets/previews/shared/sector-residential.jpg",
    }


def test_preview_templates_use_only_manifested_local_images() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    manifest_paths = set(manifest)
    assert len(manifest_paths) == 64

    template_paths = sorted(PREVIEW_TEMPLATE_DIR.glob("*.html"))
    assert [path.name for path in template_paths] == [f"{name}.html" for name in TEMPLATE_NAMES]

    failures: list[str] = []

    for template_path in template_paths:
        html = template_path.read_text(encoding="utf-8")
        template_name = template_path.stem
        tokens = set(TOKEN_RE.findall(html))
        local_image_paths = LOCAL_PREVIEW_IMAGE_RE.findall(html)
        unique_local_image_paths = set(local_image_paths)
        expected_image_paths = _expected_image_paths(template_name)
        missing_manifest_paths = sorted(set(local_image_paths) - manifest_paths)

        if len(tokens) != EXPECTED_TOKEN_COUNT:
            failures.append(
                f"{template_path.name}: expected {EXPECTED_TOKEN_COUNT} unique tokens, "
                f"found {len(tokens)}"
            )

        if tokens != EXPECTED_TOKENS:
            failures.append(
                f"{template_path.name}: token set mismatch; "
                f"missing={', '.join(sorted(EXPECTED_TOKENS - tokens)) or 'none'}; "
                f"extra={', '.join(sorted(tokens - EXPECTED_TOKENS)) or 'none'}"
            )

        removed_tokens_found = sorted(tokens & REMOVED_TOKENS)
        if removed_tokens_found:
            failures.append(
                f"{template_path.name}: removed tokens still present: "
                f"{', '.join(removed_tokens_found)}"
            )

        if "images.unsplash.com" in html:
            failures.append(f"{template_path.name}: contains direct Unsplash image references")

        if "https://" in html:
            failures.append(f"{template_path.name}: contains external HTTPS references")

        if '<meta name="robots" content="noindex, nofollow, noarchive">' not in html:
            failures.append(f"{template_path.name}: missing noindex robots meta")

        if len(local_image_paths) != EXPECTED_TEMPLATE_IMAGE_REFS:
            failures.append(
                f"{template_path.name}: expected {EXPECTED_TEMPLATE_IMAGE_REFS} local preview "
                f"image references, found {len(local_image_paths)}"
            )

        if unique_local_image_paths != expected_image_paths:
            missing_paths = sorted(expected_image_paths - unique_local_image_paths)
            extra_paths = sorted(unique_local_image_paths - expected_image_paths)
            failures.append(
                f"{template_path.name}: local image path set mismatch; "
                f"missing={', '.join(missing_paths) or 'none'}; "
                f"extra={', '.join(extra_paths) or 'none'}"
            )

        if missing_manifest_paths:
            failures.append(
                f"{template_path.name}: local image paths missing from manifest: "
                f"{', '.join(missing_manifest_paths)}"
            )

    assert failures == []


def test_preview_nginx_config_blocks_search_indexing() -> None:
    config = NGINX_PREVIEW_CONFIG_PATH.read_text(encoding="utf-8")

    assert "listen 443 ssl;" in config
    assert "return 301 https://preview.presciaiq.com$request_uri;" in config
    assert 'add_header X-Robots-Tag "noindex, nofollow, noarchive" always;' in config
    assert "location /p/" in config
    assert "location /assets/" in config
    assert "location / {\n        return 404;" in config
    assert "try_files $uri $uri/ $uri.html =404;" in config


# ---------------------------------------------------------------------------
# The neutral fallback template
# ---------------------------------------------------------------------------

# Claims a cafe, an accountant or a school cannot make, and which the
# "general" template makes on every page.
TRADE_SPECIFIC_PHRASES = [
    "licensed",
    "insured",
    "free quote",
    "trades",
    "tradie",
    "workmanship",
    "craftsman",
    "job site",
    "on the tools",
    # Property-sector framing, found by rendering the page and reading it
    # rather than by any assertion. "Trusted by homeowners" and a project
    # tagged "Residential" are nonsense on a cafe's demo page, and the earlier
    # phrase list said nothing about either.
    "homeowner",
    "residential",
]


SCRIPT_OR_STYLE_RE = re.compile(r"<(script|style)\b.*?</\1>", re.DOTALL | re.IGNORECASE)
URL_ATTRIBUTE_RE = re.compile(r'\b(?:src|href)\s*=\s*"[^"]*"', re.IGNORECASE)


def _customer_visible_copy(template_name: str) -> str:
    """Everything a prospect reads, and nothing they do not.

    Scoped deliberately. Asset paths are excluded because
    `shared/sector-residential.jpg` is a filename, not a claim, and a phrase
    list that trips on it either blocks a correct template or gets weakened
    until it stops catching real copy. CSS and scripts are excluded for the
    same reason. Alt text stays in: a screen reader hears it.
    """
    html = (PREVIEW_TEMPLATE_DIR / f"{template_name}.html").read_text(encoding="utf-8")
    html = SCRIPT_OR_STYLE_RE.sub(" ", html)
    html = URL_ATTRIBUTE_RE.sub(" ", html)
    return html.lower()


def test_neutral_template_contains_no_trade_specific_claims() -> None:
    copy = _customer_visible_copy(NEUTRAL_TEMPLATE_NAME)

    found = [phrase for phrase in TRADE_SPECIFIC_PHRASES if phrase in copy]

    assert found == [], f"neutral template still claims: {found}"


def test_general_template_is_still_the_trades_template() -> None:
    """Proves the test above is testing something.

    If the phrase list were wrong, or _customer_visible_copy stripped too
    much, this would fail too, because general.html demonstrably makes these
    claims in its visible copy.
    """
    copy = _customer_visible_copy("general")

    found = [phrase for phrase in TRADE_SPECIFIC_PHRASES if phrase in copy]

    assert "licensed" in found
    assert "free quote" in found
    assert "homeowner" in found
    assert "residential" in found


def test_no_template_contains_a_dash_substitute() -> None:
    """Em and en dashes are banned in customer-facing copy repo-wide, and a
    preview page is as customer-facing as it gets."""
    failures: list[str] = []
    for template_path in sorted(PREVIEW_TEMPLATE_DIR.glob("*.html")):
        html = template_path.read_text(encoding="utf-8")
        if template_path.stem != NEUTRAL_TEMPLATE_NAME:
            # The trade templates predate this rule and are out of scope here.
            continue
        for dash in ("\u2014", "\u2013"):
            if dash in html:
                failures.append(f"{template_path.name}: contains {dash!r}")
    assert failures == []


def test_every_template_wraps_its_phone_row_in_a_conditional_block() -> None:
    """A lead with no phone must not render an empty clickable tel: row.

    Only 45.8% of the Australian list has a phone number of any kind, so this
    is the common case, not the edge case.
    """
    failures: list[str] = []
    for template_path in sorted(PREVIEW_TEMPLATE_DIR.glob("*.html")):
        html = template_path.read_text(encoding="utf-8")
        if "{{PHONE}}" not in html:
            continue
        if "{{#IF_PHONE}}" not in html or "{{/IF_PHONE}}" not in html:
            failures.append(f"{template_path.name}: {{{{PHONE}}}} is not inside a conditional")
            continue
        before = html.split("{{#IF_PHONE}}")[0]
        after = html.split("{{/IF_PHONE}}")[-1]
        if "{{PHONE}}" in before or "{{PHONE}}" in after:
            failures.append(f"{template_path.name}: a {{{{PHONE}}}} sits outside the conditional")
    assert failures == []


def test_every_template_renders_with_no_tokens_left_behind() -> None:
    """Runs across the whole template directory, so a template added later is
    covered without anybody remembering to add it here."""
    import sys

    sys.path.insert(0, str(REPO_ROOT / "services" / "pipeline" / "src"))
    from workers.generate_preview import render_preview_html

    lead = {
        "business_name": "Sample Co",
        "city": "Brisbane",
        "state": "QLD",
        "phone": "+61400000001",
        "email": "sample@example.com",
    }
    personalisation = {
        "about_blurb": "A sample blurb.",
        "founder_name": "Sam Sample",
        "year_founded": 2004,
        "services": [
            {"title": f"Service {index}", "description": f"Description {index}"}
            for index in range(1, 7)
        ],
    }

    failures: list[str] = []
    for template_path in sorted(PREVIEW_TEMPLATE_DIR.glob("*.html")):
        rendered = render_preview_html(
            template_path.read_text(encoding="utf-8"),
            lead=lead,
            personalisation=personalisation,
        )
        leftovers = sorted(set(TOKEN_RE.findall(rendered)))
        if leftovers:
            failures.append(f"{template_path.name}: unrendered {leftovers}")
        if "{{#IF_" in rendered or "{{/IF_" in rendered:
            failures.append(f"{template_path.name}: conditional markers survived rendering")
    assert failures == []


def test_every_template_renders_without_a_phone() -> None:
    import sys

    sys.path.insert(0, str(REPO_ROOT / "services" / "pipeline" / "src"))
    from workers.generate_preview import render_preview_html

    lead = {
        "business_name": "Sample Co",
        "city": "Brisbane",
        "state": "QLD",
        "phone": "",
        "email": "sample@example.com",
    }
    personalisation = {
        "about_blurb": "A sample blurb.",
        "founder_name": "Sam Sample",
        "year_founded": 2004,
        "services": [
            {"title": f"Service {index}", "description": f"Description {index}"}
            for index in range(1, 7)
        ],
    }

    failures: list[str] = []
    for template_path in sorted(PREVIEW_TEMPLATE_DIR.glob("*.html")):
        rendered = render_preview_html(
            template_path.read_text(encoding="utf-8"),
            lead=lead,
            personalisation=personalisation,
        )
        if "tel:" in rendered:
            failures.append(f"{template_path.name}: empty tel: link rendered")
        if TOKEN_RE.findall(rendered):
            failures.append(f"{template_path.name}: unrendered tokens")
    assert failures == []

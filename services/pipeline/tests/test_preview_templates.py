from __future__ import annotations

import json
import re
from collections import Counter
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
    # {{STATE}} is gone from every template. It only ever appeared beside the
    # city, and the comma between the two belongs to the joined value.
    "{{LOCATION}}",
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
    "{{YEAR_FOUNDED}}",
}
REMOVED_TOKENS = {
    "{{FIRST_NAME}}",
    "{{STATE}}",
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


# ---------------------------------------------------------------------------
# A lead with no city and no state still gets a page worth looking at
# ---------------------------------------------------------------------------

# Dropping State from the required import fields lets 8,511 more Australian
# rows in, and most of the rows with no state have no city either, so
# "neither" is the common case rather than the edge one.
BASELINE_CITY = "Brisbane"
BASELINE_STATE = "QLD"
DEGRADED_LOCATION_CASES = [
    ("Brisbane", ""),
    ("", "QLD"),
    ("", ""),
]

_TEXT_NODE_RE = re.compile(r">([^<>]*)<")
_SEPARATORS = ",\u00b7"


def _render(template_html: str, *, city: str, state: str) -> str:
    import sys

    sys.path.insert(0, str(REPO_ROOT / "services" / "pipeline" / "src"))
    from workers.generate_preview import render_preview_html

    return render_preview_html(
        template_html,
        lead={
            "business_name": "Sample Co",
            "city": city,
            "state": state,
            "phone": "+61400000001",
            "email": "sample@example.com",
        },
        personalisation={
            "about_blurb": "A sample blurb.",
            "founder_name": "Sam Sample",
            "year_founded": 2004,
            "services": [
                {"title": f"Service {index}", "description": f"Description {index}"}
                for index in range(1, 7)
            ],
        },
    )


def _visible_lines(rendered_html: str) -> list[str]:
    body = SCRIPT_OR_STYLE_RE.sub(" ", rendered_html)
    lines: list[str] = []
    for node in _TEXT_NODE_RE.findall(body):
        for raw_line in node.splitlines():
            line = raw_line.strip()
            if line:
                lines.append(line)
    return lines


_EMPTY_ELEMENT_RE = re.compile(
    r"<(span|li|p|h1|h2|h3|h4|a|title)\b[^>]*>\s*</\1>", re.IGNORECASE
)


def _empty_elements(rendered_html: str) -> Counter[str]:
    body = SCRIPT_OR_STYLE_RE.sub(" ", rendered_html)
    return Counter(tag.lower() for tag in _EMPTY_ELEMENT_RE.findall(body))


def _acquired_defects(baseline_html: str, degraded_html: str) -> list[str]:
    """Marks a vanished city or state left behind, judged only on the lines
    it changed.

    A page is full of punctuation that is correct where it stands: the dot
    between two marquee items, a comma before a line break. Checking every
    line would either flag all of that or have to be watered down until it
    flags nothing. Comparing against the same page rendered with both values
    present isolates exactly the lines this change can break.
    """
    remaining = Counter(_visible_lines(baseline_html))
    defects: list[str] = []
    for line in _visible_lines(degraded_html):
        if remaining[line] > 0:
            remaining[line] -= 1
            continue
        if line[0] in _SEPARATORS:
            defects.append(f"opens with {line[0]!r}: {line!r}")
        if line[-1] in _SEPARATORS:
            defects.append(f"closes with {line[-1]!r}: {line!r}")
        if re.search(rf"[{_SEPARATORS}]\s*[{_SEPARATORS}]", line):
            defects.append(f"doubled separator: {line!r}")
        if re.search(r"\s,", line):
            # A dot is legitimately space-surrounded. A comma never is.
            defects.append(f"space before a comma: {line!r}")
        if "  " in line:
            defects.append(f"gap left by a missing value: {line!r}")

    # An accent word that vanished leaves no text to inspect at all, only
    # an element with nothing in it. "Transforming <span></span> Gardens"
    # reads as a rendering fault rather than as copy, and every check above
    # is blind to it because an empty element contributes no text node.
    baseline_empties = _empty_elements(baseline_html)
    for tag, count in _empty_elements(degraded_html).items():
        if count > baseline_empties[tag]:
            defects.append(
                f"{count - baseline_empties[tag]} more empty <{tag}> than with a location"
            )
    return defects


def test_the_defect_detector_finds_the_marks_it_is_looking_for() -> None:
    """Proves the sweep below is testing something.

    Each pair is what one line of a template degrades into when a value goes
    missing. If the detector were broken, the sweep would pass by finding
    nothing at all.
    """
    assert _acquired_defects("<p>Sample Co, Brisbane</p>", "<p>Sample Co,</p>") != []
    assert _acquired_defects("<p>Brisbane, QLD</p>", "<p>, QLD</p>") != []
    assert _acquired_defects(
        "<p>Brisbane \u00b7 QLD \u00b7 Surrounds</p>", "<p>\u00b7 QLD \u00b7 Surrounds</p>"
    ) != []
    assert _acquired_defects("<p>Sample Co \u00b7 Brisbane</p>", "<p>Sample Co \u00b7</p>") != []
    assert _acquired_defects(
        "<p>Founded in Brisbane in 2004.</p>", "<p>Founded in  in 2004.</p>"
    ) != []
    assert _acquired_defects(
        "<p>Serving Brisbane, QLD and beyond</p>", "<p>Serving , and beyond</p>"
    ) != []
    assert _acquired_defects(
        "<h2>Transforming <span>Brisbane</span> Gardens</h2>",
        "<h2>Transforming <span></span> Gardens</h2>",
    ) != []


def test_the_defect_detector_passes_punctuation_that_is_correct_where_it_stands() -> None:
    """The other half of the proof. A detector that flagged everything would
    make the sweep meaningless too, just noisily instead of quietly."""
    # A location line that shed only its state is finished copy, not a defect.
    assert _acquired_defects(
        "<p>Sample Co \u00b7 Brisbane, QLD</p>", "<p>Sample Co \u00b7 Brisbane</p>"
    ) == []
    # A comma before a line break, unchanged between the two renders.
    assert _acquired_defects(
        "<p>Every job, every detail,</p>", "<p>Every job, every detail,</p>"
    ) == []
    # A lone separator span, unchanged between the two renders.
    assert _acquired_defects(
        '<span class="dot">\u00b7</span>', '<span class="dot">\u00b7</span>'
    ) == []
    # A decorative element that is empty in both renders is part of the
    # design, not damage.
    assert _acquired_defects('<span class="rule"></span>', '<span class="rule"></span>') == []


def test_every_template_renders_cleanly_when_the_city_or_state_is_missing() -> None:
    """A page with a stray comma where the suburb should be tells the
    prospect the page was generated. That is the one thing it must not say.

    Runs over the whole directory so a template added later is covered
    without anybody remembering to add it here.
    """
    failures: list[str] = []
    for template_path in sorted(PREVIEW_TEMPLATE_DIR.glob("*.html")):
        source = template_path.read_text(encoding="utf-8")
        baseline = _render(source, city=BASELINE_CITY, state=BASELINE_STATE)
        for city, state in DEGRADED_LOCATION_CASES:
            degraded = _render(source, city=city, state=state)
            for defect in _acquired_defects(baseline, degraded):
                failures.append(f"{template_path.name} city={city!r} state={state!r}: {defect}")
    assert failures == [], "\n".join(failures[:40])


def test_a_lead_with_both_a_city_and_a_state_still_says_where_it_is() -> None:
    """Guards the cheap way to pass the sweep above: deleting every mention
    of the location. The page has to still be local when the data is there."""
    failures: list[str] = []
    for template_path in sorted(PREVIEW_TEMPLATE_DIR.glob("*.html")):
        rendered = _render(
            template_path.read_text(encoding="utf-8"),
            city=BASELINE_CITY,
            state=BASELINE_STATE,
        )
        if f"{BASELINE_CITY}, {BASELINE_STATE}" not in rendered:
            failures.append(f"{template_path.name}: never renders the city and state together")
        if rendered.count(BASELINE_CITY) < 10:
            failures.append(
                f"{template_path.name}: only {rendered.count(BASELINE_CITY)} city mentions"
            )
    assert failures == []


def test_no_template_pairs_city_and_state_by_hand() -> None:
    """`{{CITY}}, {{STATE}}` is only ever right when both are present.

    The comma belongs to the joined value, which is what {{LOCATION}} is, so
    no template is allowed to punctuate the pair itself.
    """
    failures: list[str] = []
    pair = re.compile(
        r"\{\{CITY\}\}\s*[,\u00b7]\s*\{\{STATE\}\}|\{\{STATE\}\}\s*[,\u00b7]\s*\{\{CITY\}\}"
    )
    for template_path in sorted(PREVIEW_TEMPLATE_DIR.glob("*.html")):
        html = template_path.read_text(encoding="utf-8")
        if pair.search(html):
            failures.append(f"{template_path.name}: joins {{{{CITY}}}} and {{{{STATE}}}} by hand")
    assert failures == []

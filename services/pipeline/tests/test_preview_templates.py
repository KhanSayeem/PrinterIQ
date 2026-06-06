from __future__ import annotations

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PREVIEW_TEMPLATE_DIR = REPO_ROOT / "services" / "pipeline" / "src" / "templates" / "previews"
MANIFEST_PATH = REPO_ROOT / "image-download-manifest.json"

EXPECTED_TOKEN_COUNT = 20
EXPECTED_TEMPLATE_IMAGE_REFS = 15
TEMPLATE_NAMES = ["concreting", "electrical", "general", "hvac", "landscaping", "plumbing"]
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
    assert len(manifest_paths) == 56

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

from __future__ import annotations

import re
from pathlib import Path

from clients import claude_client

REPO_ROOT = Path(__file__).resolve().parents[3]
PROMPT_PATH = REPO_ROOT / "prompts" / "opener-v2.txt"


def test_opener_v2_prompt_contract_mentions_preview_hook_and_output_schema() -> None:
    prompt = PROMPT_PATH.read_text(encoding="utf-8")
    rendered = claude_client._render_prompt(prompt, {})

    assert '"subject_line"' in prompt
    assert '"opener"' in prompt
    assert '"followup_1"' in prompt
    assert '"followup_2"' in prompt
    assert "{preview_url}" in prompt
    assert "[Check it out]({preview_url})" in prompt
    assert "[Check it out]({preview_url})" in rendered
    assert "$$1,500 flat" in prompt
    assert "$1,500 flat" in rendered
    assert "Macauley" in prompt


def test_opener_v2_prompt_bans_dash_and_corporate_copy_patterns() -> None:
    prompt = PROMPT_PATH.read_text(encoding="utf-8")

    assert "em-dash" in prompt
    assert "double-hyphen" in prompt
    assert "hope this email finds you well" in prompt.lower()
    assert "corporate language" in prompt.lower()
    assert "Casual Aussie tone" in prompt
    assert "No em-dashes" in prompt
    assert re.search(r"No double-hyphen", prompt) is not None


def test_opener_v2_uses_sonnet_model() -> None:
    assert claude_client._MODEL_MAP["opener-v2"] == "claude-sonnet-4-6"


def test_opener_v2_render_leaves_only_preview_url_placeholder() -> None:
    prompt = PROMPT_PATH.read_text(encoding="utf-8")
    rendered = claude_client._render_prompt(
        prompt,
        {
            "lead_json": '{"first_name":"Brett","business_name":"Stone Builders"}',
            "top_weakness": "no_mobile",
            "rationale": "The site is hard to use on mobile.",
        },
    )

    placeholders = re.findall(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", rendered)
    assert placeholders
    assert set(placeholders) == {"preview_url"}

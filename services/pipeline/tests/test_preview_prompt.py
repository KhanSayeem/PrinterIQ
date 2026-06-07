from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
PROMPT_PATH = REPO_ROOT / "prompts" / "preview-personalise-v1.txt"


def test_preview_personalise_prompt_matches_current_template_contract() -> None:
    assert PROMPT_PATH.exists()

    prompt = PROMPT_PATH.read_text()

    assert "preview-personalise-v1" in prompt
    assert "{business_name}" in prompt
    assert "{city}" in prompt
    assert "{state}" in prompt
    assert "{industry}" in prompt
    assert "{keywords}" in prompt

    assert '"about_blurb"' in prompt
    assert '"founder_name"' in prompt
    assert '"year_founded"' in prompt
    assert '"services"' in prompt
    assert '"title"' in prompt
    assert '"description"' in prompt
    assert "exactly 6" in prompt
    assert "1995" in prompt
    assert "2018" in prompt

    assert '"tagline"' not in prompt
    assert "top_weakness" not in prompt
    assert "em-dash" in prompt
    assert "\u2014" not in prompt

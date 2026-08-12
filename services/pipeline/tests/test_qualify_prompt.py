from __future__ import annotations

from pathlib import Path

from clients import claude_client

REPO_ROOT = Path(__file__).resolve().parents[3]
PROMPT_PATH = REPO_ROOT / "prompts" / "qualify-v1.txt"


def test_qualify_v1_uses_haiku_model() -> None:
    assert claude_client._MODEL_MAP["qualify-v1"] == "claude-haiku-4-5-20251001"


def test_qualify_v1_prompt_schema_matches_haiku_contract() -> None:
    prompt = PROMPT_PATH.read_text(encoding="utf-8")

    assert '"score"' in prompt
    assert '"rationale"' in prompt
    assert '"top_weakness"' in prompt
    assert '"has_actionable_weakness"' in prompt

    # CHANGE 3: subject_line/opener/followup_1/followup_2 are generated and
    # discarded on every qualification — Sonnet (opener-v2) is the only prompt
    # that should own those fields now.
    assert '"subject_line"' not in prompt
    assert '"opener"' not in prompt
    assert '"followup_1"' not in prompt
    assert '"followup_2"' not in prompt


def test_qualify_v1_prompt_defines_actionable_weakness() -> None:
    prompt = PROMPT_PATH.read_text(encoding="utf-8")

    assert "has_actionable_weakness" in prompt
    assert "concrete" in prompt.lower()
    assert "fixable" in prompt.lower() or "fixable" in prompt.lower()
    assert "already good" in prompt.lower() or "no weaknesses found" in prompt.lower()
    assert "false" in prompt.lower()


def test_qualify_v1_prompt_bans_dash_substitutes() -> None:
    prompt = PROMPT_PATH.read_text(encoding="utf-8")

    assert "em dash" in prompt.lower() or "em-dash" in prompt.lower()
    assert "—" not in prompt
    assert "–" not in prompt

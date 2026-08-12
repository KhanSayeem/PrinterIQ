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
    assert '"weakness_label"' in prompt

    # has_actionable_weakness is derived in code from the enrichment
    # weaknesses array, so the prompt must not ask the model for it. Asking
    # produced the production defect where leads with measured weaknesses
    # were judged "not worth pitching a rebuild over" and archived.
    assert "has_actionable_weakness" not in prompt

    # CHANGE 3: subject_line/opener/followup_1/followup_2 are generated and
    # discarded on every qualification — Sonnet (opener-v2) is the only prompt
    # that should own those fields now.
    assert '"subject_line"' not in prompt
    assert '"opener"' not in prompt
    assert '"followup_1"' not in prompt
    assert '"followup_2"' not in prompt


def test_qualify_v1_prompt_declares_weakness_label_enum_matching_canonical_vocabulary() -> None:
    from weaknesses import WEAKNESS_LABELS

    prompt = PROMPT_PATH.read_text(encoding="utf-8")

    assert '"weakness_label"' in prompt
    for label in WEAKNESS_LABELS:
        assert label in prompt


def test_qualify_v1_prompt_grounds_weakness_label_in_enrichment_data() -> None:
    prompt = PROMPT_PATH.read_text(encoding="utf-8")

    assert "weaknesses array" in prompt.lower()
    assert "actually measured" in prompt.lower()
    assert "never pick a" in prompt.lower() or "does not show" in prompt.lower()


def test_qualify_v1_prompt_does_not_ask_the_model_to_judge_actionability() -> None:
    """Replaces test_qualify_v1_prompt_defines_actionable_weakness.

    The old wording, "worth pitching a rebuild over", was read literally and
    archived every lead whose only measured defect was a missing H1. The
    judgement is gone from the prompt entirely; presence of a measured
    weakness is now decided in code and severity is the score's job.
    """
    prompt = PROMPT_PATH.read_text(encoding="utf-8")

    assert "has_actionable_weakness" not in prompt
    assert "worth pitching a rebuild over" not in prompt.lower()


def test_qualify_v1_prompt_bans_dash_substitutes() -> None:
    prompt = PROMPT_PATH.read_text(encoding="utf-8")

    assert "em dash" in prompt.lower() or "em-dash" in prompt.lower()
    assert "—" not in prompt
    assert "–" not in prompt

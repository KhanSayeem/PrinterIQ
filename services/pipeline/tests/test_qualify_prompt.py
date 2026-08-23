from __future__ import annotations

from pathlib import Path

from clients import claude_client

REPO_ROOT = Path(__file__).resolve().parents[3]
PROMPT_PATH = REPO_ROOT / "prompts" / "qualify-v1.txt"
V2_PROMPT_PATH = REPO_ROOT / "prompts" / "qualify-v2.txt"
NOSITE_OPENER_PATH = REPO_ROOT / "prompts" / "opener-nosite-v1.txt"
OPENER_PATH = REPO_ROOT / "prompts" / "opener-v2.txt"


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


def test_qualify_v2_prompt_declares_every_canonical_weakness_label() -> None:
    """Includes no_website. A prompt that never offers the label as a
    permitted value cannot pick it, and a no-website lead would then fail the
    grounding gate with the one label its enrichment actually measured.

    Deliberately scoped to the enumeration itself. Asserting each label
    appears anywhere in the file passes while the label is only mentioned in
    a later paragraph and is absent from the list of allowed values, which is
    the only part the model reads as a constraint.
    """
    from weaknesses import WEAKNESS_LABELS

    prompt = V2_PROMPT_PATH.read_text(encoding="utf-8")

    assert '"weakness_label"' in prompt
    marker = "must be exactly one of these canonical values, and only"
    assert marker in prompt
    enumeration = prompt.split(marker, 1)[1].split("Choose the value", 1)[0]
    for label in WEAKNESS_LABELS:
        assert f'"{label}"' in enumeration, f"{label} is not offered as a permitted value"


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


def test_opener_v2_prompt_does_not_hardcode_the_price() -> None:
    """The price is one env var, not four hand-maintained copies.

    The Instantly copy was corrected to $1,499 while stripe.ts still charged
    $1,500 and both prompts still said $1,500, so a lead would have been billed
    more than the email quoted.
    """
    opener = (REPO_ROOT / "prompts" / "opener-v2.txt").read_text(encoding="utf-8")
    reply_agent = (REPO_ROOT / "prompts" / "reply-agent-v1.txt").read_text(encoding="utf-8")

    assert "1,500" not in opener
    assert "1,500" not in reply_agent
    assert "{price_aud}" in opener
    assert "{price_aud}" in reply_agent


def test_qualify_v1_prompt_bans_dash_substitutes() -> None:
    prompt = PROMPT_PATH.read_text(encoding="utf-8")

    assert "em dash" in prompt.lower() or "em-dash" in prompt.lower()
    assert "—" not in prompt
    assert "–" not in prompt


# ---------------------------------------------------------------------------
# qualify-v2: score what predicts a sale, not what industry the lead is in
#
# qualify-v1 line 4 listed "construction/trades industry" as a high-score
# signal and line 5 listed "not a tradie business" as a low-score signal. A
# real lead scored 28 with the rationale "Business model does not match tradie
# profile", which is the prompt working exactly as written and the business
# being wrong about what it sells.
# ---------------------------------------------------------------------------


def test_qualify_v2_uses_haiku_model() -> None:
    assert claude_client._MODEL_MAP["qualify-v2"] == "claude-haiku-4-5-20251001"


def test_qualify_worker_calls_the_v2_prompt() -> None:
    """A new prompt file nothing points at is a file, not a change."""
    from workers.qualify import _HAIKU_PROMPT

    assert _HAIKU_PROMPT == "qualify-v2"


def test_qualify_v1_is_kept_on_disk_and_wired_for_rollback() -> None:
    """prompt_version is written to every qualifications row. Deleting v1
    would make every historical score unreadable, and rolling back would stop
    being one constant."""
    assert PROMPT_PATH.exists()
    assert claude_client._MODEL_MAP["qualify-v1"] == "claude-haiku-4-5-20251001"


def test_qualify_v2_prompt_has_no_trade_preference() -> None:
    prompt = V2_PROMPT_PATH.read_text(encoding="utf-8").lower()

    for word in ("tradie", "tradies", "trades", "trade ", "construction"):
        assert word not in prompt, f"qualify-v2 still mentions {word!r}"


def test_qualify_v2_prompt_names_every_scoring_component_and_its_ceiling() -> None:
    """The rationale field is the only audit trail on a score. Named,
    bounded components are what make it checkable rather than a vibe."""
    prompt = V2_PROMPT_PATH.read_text(encoding="utf-8").lower()

    assert "website opportunity" in prompt
    assert "0-45" in prompt
    assert "contactability" in prompt
    assert "0-25" in prompt
    assert "website dependence" in prompt
    assert "0-20" in prompt
    assert "live and independent business" in prompt
    assert "0-10" in prompt


def test_qualify_v2_prompt_components_sum_to_one_hundred() -> None:
    """The schema caps score at 100. A rubric whose parts sum to more than
    that asks the model for a number it is not allowed to return."""
    import re

    prompt = V2_PROMPT_PATH.read_text(encoding="utf-8")
    ceilings = [int(match) for match in re.findall(r"\(0-(\d+)\)", prompt)]

    assert sorted(ceilings) == [10, 20, 25, 45]
    assert sum(ceilings) == 100


def test_qualify_v2_prompt_keeps_directory_platforms_as_a_negative() -> None:
    """Half the rationale on the lead that scored 28 was the bug. The other
    half was a judgement worth keeping: a directory's business model is being
    the website, so it does not want to buy one."""
    prompt = V2_PROMPT_PATH.read_text(encoding="utf-8").lower()

    assert "directory" in prompt
    assert "referral platform" in prompt or "marketplace" in prompt


def test_qualify_v2_prompt_scores_a_missing_website_highest_on_opportunity() -> None:
    prompt = V2_PROMPT_PATH.read_text(encoding="utf-8").lower()

    assert "no_website" in prompt
    assert "no website at all" in prompt


def test_qualify_v2_prompt_schema_matches_haiku_contract() -> None:
    """Ported verbatim from the v1 test. A rewrite must not quietly change
    the output contract the worker parses."""
    prompt = V2_PROMPT_PATH.read_text(encoding="utf-8")

    assert '"score"' in prompt
    assert '"rationale"' in prompt
    assert '"top_weakness"' in prompt
    assert '"weakness_label"' in prompt
    assert "has_actionable_weakness" not in prompt
    assert '"subject_line"' not in prompt
    assert '"opener"' not in prompt
    assert '"followup_1"' not in prompt
    assert '"followup_2"' not in prompt


def test_qualify_v2_prompt_grounds_weakness_label_in_enrichment_data() -> None:
    """Ported from the v1 test. The grounding rule is the single thing
    standing between a model's guess and a claim in a customer's inbox."""
    prompt = V2_PROMPT_PATH.read_text(encoding="utf-8")

    assert "weaknesses array" in prompt.lower()
    assert "actually measured" in prompt.lower()
    assert "never pick a" in prompt.lower() or "does not show" in prompt.lower()


def test_qualify_v2_prompt_does_not_ask_the_model_to_judge_actionability() -> None:
    prompt = V2_PROMPT_PATH.read_text(encoding="utf-8")

    assert "has_actionable_weakness" not in prompt
    assert "worth pitching a rebuild over" not in prompt.lower()


def test_qualify_v2_prompt_bans_dash_substitutes() -> None:
    prompt = V2_PROMPT_PATH.read_text(encoding="utf-8")

    assert "em dash" in prompt.lower() or "em-dash" in prompt.lower()
    assert "\u2014" not in prompt
    assert "\u2013" not in prompt


# ---------------------------------------------------------------------------
# opener-nosite-v1: copy for a business that has no site to talk about
# ---------------------------------------------------------------------------


def test_opener_nosite_prompt_uses_sonnet() -> None:
    assert claude_client._MODEL_MAP["opener-nosite-v1"] == "claude-sonnet-4-6"


def test_opener_nosite_prompt_never_asserts_the_lead_has_a_site() -> None:
    """opener-v2 hard-codes "spotted [business name]'s site and noticed".

    There is no wording of that sentence that is true for a business with no
    site, which is why this is a separate file rather than a branch inside
    the existing prompt.
    """
    prompt = NOSITE_OPENER_PATH.read_text(encoding="utf-8").lower()

    for phrase in (
        "your site",
        "your website",
        "'s site",
        "had a look at",
        "spotted",
        "took a look at your",
    ):
        assert phrase not in prompt, f"opener-nosite-v1 asserts a site: {phrase!r}"


def test_opener_nosite_prompt_names_the_unmeasured_claims_it_bans() -> None:
    """A no-site lead is where a model has least to say and is most tempted
    to invent. None of these are measured anywhere in the pipeline."""
    prompt = NOSITE_OPENER_PATH.read_text(encoding="utf-8").lower()

    for banned in ("google maps", "reviews", "ranking", "social media", "ad spend"):
        assert banned in prompt, f"opener-nosite-v1 does not name {banned!r} as off limits"
    assert "never" in prompt or "do not claim" in prompt


def test_opener_nosite_prompt_requires_the_preview_url_literal() -> None:
    """The Markdown link is the email's only link. If the literal is dropped,
    the send goes out with nothing to click and nothing fails loudly.

    Checked in the Step 1 structure block as well as in the rules. A rule
    saying "include this literal" next to an example that does not include it
    is a prompt arguing with itself, and the example is what gets copied.
    """
    prompt = NOSITE_OPENER_PATH.read_text(encoding="utf-8")
    literal = "[Check it out]({preview_url})"

    assert literal in prompt

    marker = "Use this Step 1 opener structure:"
    assert marker in prompt
    step_one = prompt.split(marker, 1)[1].split("Use this Follow-up 1", 1)[0]
    assert literal in step_one, "the Step 1 example does not contain the preview link literal"

    rules = prompt.split("Rules:", 1)[1]
    assert literal in rules


def test_opener_nosite_prompt_matches_the_sonnet_output_schema() -> None:
    prompt = NOSITE_OPENER_PATH.read_text(encoding="utf-8")

    for key in (
        '"subject_line"',
        '"opener"',
        '"followup_1"',
        '"followup_2"',
        '"weakness_sentence"',
    ):
        assert key in prompt


def test_opener_nosite_prompt_takes_the_same_variables_as_the_site_opener() -> None:
    """Both prompts are called from one code path with one variable dict. A
    variable the file needs but the caller does not pass renders as a literal
    brace in a customer email."""
    import re

    site = set(re.findall(r"\{([a-z_]+)\}", OPENER_PATH.read_text(encoding="utf-8")))
    nosite = set(re.findall(r"\{([a-z_]+)\}", NOSITE_OPENER_PATH.read_text(encoding="utf-8")))

    assert nosite <= site, f"opener-nosite-v1 needs unsupplied variables: {nosite - site}"


def test_opener_nosite_prompt_does_not_hardcode_the_price() -> None:
    prompt = NOSITE_OPENER_PATH.read_text(encoding="utf-8")

    assert "1,500" not in prompt
    assert "1,499" not in prompt
    assert "{price_aud}" in prompt


def test_opener_nosite_prompt_bans_dash_substitutes() -> None:
    prompt = NOSITE_OPENER_PATH.read_text(encoding="utf-8")

    assert "em dash" in prompt.lower() or "em-dash" in prompt.lower()
    assert "\u2014" not in prompt
    assert "\u2013" not in prompt

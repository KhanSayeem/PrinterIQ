from __future__ import annotations

from weaknesses import WEAKNESS_LABELS, Weakness


def test_canonical_weakness_labels_match_the_documented_set() -> None:
    assert WEAKNESS_LABELS == {
        "no_mobile",
        "no_ssl",
        "no_meta_title",
        "no_meta_description",
        "no_h1",
        "slow_load",
    }


def test_weakness_enum_values_match_weakness_labels() -> None:
    assert {member.value for member in Weakness} == WEAKNESS_LABELS


def test_enrich_worker_imports_shared_weakness_vocabulary() -> None:
    """enrich.py must not redefine its own weakness literals — it filters
    audit output through the same WEAKNESS_LABELS object defined here."""
    from workers import enrich

    assert enrich.WEAKNESS_LABELS is WEAKNESS_LABELS


def test_playwright_audit_imports_shared_weakness_vocabulary() -> None:
    """playwright_audit.py must not redefine its own weakness literals — it
    emits members of the same Weakness enum defined here."""
    from clients import playwright_audit

    assert playwright_audit.Weakness is Weakness


def test_qualify_worker_haiku_schema_enum_matches_canonical_labels() -> None:
    """The Haiku weakness_label JSON Schema enum must be sourced from the
    same canonical set, not a hand-copied list that can drift.

    The one permitted addition is the "none" sentinel, which Haiku returns
    when the enrichment measured no weakness. It is not a measurable label, so
    it stays out of WEAKNESS_LABELS, and asserting the enum is exactly the
    canonical set plus that sentinel keeps the anti-drift guarantee.
    """
    from workers.qualify import _HAIKU_SCHEMA, _NO_WEAKNESS_LABEL

    assert set(_HAIKU_SCHEMA["properties"]["weakness_label"]["enum"]) == (
        WEAKNESS_LABELS | {_NO_WEAKNESS_LABEL}
    )
    assert _NO_WEAKNESS_LABEL not in WEAKNESS_LABELS

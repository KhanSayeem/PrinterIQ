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


def test_qualify_worker_does_not_constrain_weakness_label_by_enum() -> None:
    """Grounding, not an enum, is the authority on weakness_label.

    Replaces test_qualify_worker_haiku_schema_enum_matches_canonical_labels.
    An enum here was redundant and harmful: the worker checks the label against
    *this lead's* measured weaknesses array, which rejects a valid canonical
    label the lead never measured, while the enum dead-lettered clean sites
    whose label was simply Haiku's word for "nothing".
    """
    from workers.qualify import _HAIKU_SCHEMA

    assert _HAIKU_SCHEMA["properties"]["weakness_label"] == {"type": "string"}
    assert "enum" not in _HAIKU_SCHEMA["properties"]["weakness_label"]


def test_canonical_vocabulary_is_still_the_producer_contract() -> None:
    """Dropping the schema enum must not dilute the measured vocabulary."""
    assert WEAKNESS_LABELS == {
        "no_mobile",
        "no_ssl",
        "no_meta_title",
        "no_meta_description",
        "no_h1",
        "slow_load",
    }
    assert "none" not in WEAKNESS_LABELS
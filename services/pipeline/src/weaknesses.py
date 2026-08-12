"""Canonical website-weakness vocabulary shared by every enrichment producer.

Both website-audit producers (`clients.playwright_audit`, and indirectly
`workers.enrich`, which persists whatever the audit measured) and the
qualification step (`workers.qualify`) must agree on the exact set of
weakness labels that can appear in `enrichments.weaknesses` and in Haiku's
`weakness_label` field. Defining the vocabulary once here — instead of
duplicating string literals in each producer — is what lets qualify.py
validate a Claude-generated `weakness_label` against what was actually
measured on the lead's site, so customer-facing copy never asserts a
problem that was never observed.
"""

from __future__ import annotations

from enum import StrEnum


class Weakness(StrEnum):
    """The complete, closed set of observable website weaknesses.

    Every value here must correspond to a signal that is actually measured
    by a website auditor (see `clients.playwright_audit`). Do not add a
    label here unless something in the codebase measures it.
    """

    NO_MOBILE = "no_mobile"
    NO_SSL = "no_ssl"
    NO_META_TITLE = "no_meta_title"
    NO_META_DESCRIPTION = "no_meta_description"
    NO_H1 = "no_h1"
    SLOW_LOAD = "slow_load"


WEAKNESS_LABELS: frozenset[str] = frozenset(member.value for member in Weakness)

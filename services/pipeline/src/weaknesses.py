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
    by an enrichment producer. Do not add a label here unless something in
    the codebase measures it.

    Producers, and which labels each one owns:

    - `clients.playwright_audit` measures a site that loaded, and owns every
      label below except NO_WEBSITE.
    - `workers.enrich` owns NO_WEBSITE alone. Playwright cannot observe the
      absence of a URL because it is never handed one; the enrich worker
      reads the lead row, so it is the only component that can measure this
      honestly. It is also the least inferential label here: NO_H1 needs a
      page load, a render and a selector match to be true, while NO_WEBSITE
      needs one column of the lead row.
    """

    NO_MOBILE = "no_mobile"
    NO_SSL = "no_ssl"
    NO_META_TITLE = "no_meta_title"
    NO_META_DESCRIPTION = "no_meta_description"
    NO_H1 = "no_h1"
    SLOW_LOAD = "slow_load"
    NO_WEBSITE = "no_website"


WEAKNESS_LABELS: frozenset[str] = frozenset(member.value for member in Weakness)

"""The single source of truth for what the website offer costs.

The price previously lived in four places that drifted independently: a
hardcoded amount in the reply agent's `stripe.ts`, `prompts/opener-v2.txt`,
`prompts/reply-agent-v1.txt`, and the Instantly templates. The Instantly copy
was corrected to $1,499 and nothing else was, so checkout would have charged
$1,500 against a $1,499 quote. Reading it from one env var, shared with the
reply agent's `offer.ts`, keeps checkout and both prompts in step.

The Instantly templates still have to be edited by hand, because they live in
a third-party UI. That is a runbook step, not something this can enforce.
"""

from __future__ import annotations

import os
import re

_DEFAULT_OFFER_PRICE_AUD = 1499
_WHOLE_DOLLARS = re.compile(r"^[1-9][0-9]*$")


def offer_price_aud() -> int:
    """The offer price in whole Australian dollars."""
    configured = (os.getenv("OFFER_PRICE_AUD") or "").strip()
    if not configured:
        return _DEFAULT_OFFER_PRICE_AUD

    # Deliberately strict. Falling back to the default on a malformed value
    # would quote one price while checkout charges another, which is the exact
    # failure this module exists to prevent.
    if not _WHOLE_DOLLARS.match(configured):
        raise ValueError(
            f"OFFER_PRICE_AUD must be a positive whole number of dollars, got: {configured}"
        )

    return int(configured)


def offer_price_display() -> str:
    """The price as it should appear in customer-facing copy, e.g. "1,499"."""
    return f"{offer_price_aud():,}"

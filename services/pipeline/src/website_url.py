"""Canonical website-URL normalisation shared by ingest and the audit.

A lead's `website_url` is written by `workers.ingest` and read by
`clients.playwright_audit`, and both ends have to agree on what a
well-formed value looks like. They did not, and the disagreement was
expensive.

The Australian source CSV spells websites as bare domains with no scheme,
`cottellandco.com.au` rather than `https://cottellandco.com.au`. Ingest
stored the raw cell, the audit handed it straight to `page.goto`, and
Chromium rejects a schemeless string outright. That surfaced as the
auditor's unreachable record, whose weaknesses array is deliberately empty
because nothing was measured, and an empty weaknesses array archives the
lead on the derived gate in `workers.qualify`. That gate runs after the
paid Haiku call, so each of the 252 leads archived this way had already
cost money before being discarded on a premise that was never observed.

Every earlier import happened to carry `https://`, which is why the raw
passthrough survived this long without anyone noticing.

Normalising in one place, rather than at each call site, is what lets the
audit trust the value it is handed and still defend itself against the
rows already sitting in the database with the raw form.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# RFC 3986 scheme grammar, followed by the authority separator. Matching the
# separator rather than the scheme alone is what keeps a value like
# "retail:grocery" out of this branch: a scheme without "//" is not something
# a browser can navigate to as a website.
#
# The pattern is case-insensitive by construction because the source data is
# inconsistent about it, and a case-sensitive test would not recognise
# "HTTP://example.com" as carrying a scheme and would produce the
# double-prefixed "https://HTTP://example.com".
_SCHEME_RE = re.compile(r"^(?P<scheme>[a-zA-Z][a-zA-Z0-9+.\-]*)://")


@dataclass(frozen=True)
class NormalisedWebsiteUrl:
    """A website URL a browser can navigate to, and where its scheme came from.

    `scheme_was_inferred` is not decoration. The audit retries over http when
    an https attempt fails, but only when the https was our own guess. A
    scheme the source actually supplied is evidence about the site, so a
    failure against it is a real finding; a scheme we invented is only
    evidence about the guess, and treating those two the same is how an
    http-only business ends up recorded as unreachable.
    """

    url: str
    scheme_was_inferred: bool


# A business with no website at all. `workers.enrich` keys its truthful
# no_website record on the empty string, and `clients.playwright_audit`
# short-circuits on it before any browser is launched, so the absence has to
# survive normalisation intact. Returning "https://" here would send 6,011
# Australian rows with a blank website cell down the audit path and convert
# an accurate record into a fabricated unreachable one.
_ABSENT = NormalisedWebsiteUrl(url="", scheme_was_inferred=False)


def normalise_website_url(raw: str) -> NormalisedWebsiteUrl:
    """Return `raw` in a form `page.goto` will accept, or empty if there is none.

    The scheme is lower-cased when one is present. That is not cosmetic:
    `has_ssl` is a `startswith("https://")` comparison, so leaving
    `HTTPS://x.com` alone would satisfy Chromium and still record the site as
    having no SSL, attaching a `no_ssl` weakness it does not have.

    An `http://` value is deliberately left as `http://`. Upgrading it would
    either fabricate an SSL result or fail navigation against a host that
    serves no TLS at all. The audit, which can see which scheme actually
    loaded, is the only component entitled to answer that question.
    """
    value = raw.strip()
    if not value:
        return _ABSENT

    match = _SCHEME_RE.match(value)
    if match is not None:
        scheme = match.group("scheme")
        return NormalisedWebsiteUrl(
            url=scheme.lower() + value[match.end("scheme") :],
            scheme_was_inferred=False,
        )

    # A protocol-relative "//example.com" carries an authority but no scheme.
    # Prefixing it blindly would yield "https:////example.com", so the leading
    # slashes are consumed rather than kept.
    host_and_path = value.lstrip("/")
    if not host_and_path:
        return _ABSENT

    return NormalisedWebsiteUrl(url=f"https://{host_and_path}", scheme_was_inferred=True)

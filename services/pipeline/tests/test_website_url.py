from __future__ import annotations

import pytest

from website_url import normalise_website_url

# ---------------------------------------------------------------------------
# A schemeless value gets the scheme it was missing
# ---------------------------------------------------------------------------


def test_bare_domain_gains_an_https_scheme() -> None:
    """The exact shape that archived 252 leads.

    The Australian source CSV stores websites as bare domains. Chromium
    rejects a schemeless string outright, so the audit returned its
    unreachable record with an empty weaknesses array, and an empty
    weaknesses array archives the lead on the derived gate in
    workers.qualify, after the paid Haiku call has already been made.
    """
    result = normalise_website_url("cottellandco.com.au")

    assert result.url == "https://cottellandco.com.au"
    assert result.scheme_was_inferred is True


def test_www_prefixed_domain_gains_an_https_scheme() -> None:
    """A leading www is a host label, not a scheme, and must not be mistaken
    for one."""
    result = normalise_website_url("www.example.com")

    assert result.url == "https://www.example.com"
    assert result.scheme_was_inferred is True


def test_protocol_relative_url_gains_an_https_scheme() -> None:
    """`//example.com` carries an authority but no scheme. Prefixing it
    blindly would produce `https:////example.com`, so the leading slashes
    are consumed rather than kept."""
    result = normalise_website_url("//example.com")

    assert result.url == "https://example.com"
    assert result.scheme_was_inferred is True


# ---------------------------------------------------------------------------
# A value that already carries a scheme keeps it
# ---------------------------------------------------------------------------


def test_https_url_is_unchanged() -> None:
    result = normalise_website_url("https://example.com")

    assert result.url == "https://example.com"
    assert result.scheme_was_inferred is False


def test_http_url_is_not_upgraded_to_https() -> None:
    """Deliberately not an upgrade.

    `has_ssl` is measured from the scheme that actually loaded, so silently
    rewriting a source-supplied http to https would either fabricate an SSL
    result or fail navigation on a host that has no TLS at all. The audit,
    not the normaliser, is what answers the scheme question.
    """
    result = normalise_website_url("http://example.com")

    assert result.url == "http://example.com"
    assert result.scheme_was_inferred is False


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("HTTP://example.com", "http://example.com"),
        ("HtTpS://x.com", "https://x.com"),
        ("HTTPS://example.com.au", "https://example.com.au"),
    ],
)
def test_mixed_case_scheme_is_recognised_and_lowercased(raw: str, expected: str) -> None:
    """Two separate bugs live here.

    A case-sensitive check would not recognise `HTTP://` as a scheme and
    would produce `https://HTTP://example.com`. Leaving the case alone
    instead would satisfy Chromium but break `has_ssl`, which is a
    `startswith("https://")` comparison, so `HTTPS://x.com` would be
    recorded as having no SSL and would carry a `no_ssl` weakness it does
    not have. Lowering the scheme, and only the scheme, fixes both.
    """
    result = normalise_website_url(raw)

    assert result.url == expected
    assert result.scheme_was_inferred is False


def test_a_non_http_scheme_is_left_alone() -> None:
    """Anything that already declares a scheme is somebody else's problem to
    validate. The normaliser's job is to stop a schemeless value reaching
    Chromium, not to police the protocol."""
    result = normalise_website_url("ftp://files.example.com")

    assert result.url == "ftp://files.example.com"
    assert result.scheme_was_inferred is False


# ---------------------------------------------------------------------------
# Whitespace
# ---------------------------------------------------------------------------


def test_surrounding_whitespace_is_stripped() -> None:
    result = normalise_website_url("  example.com.au \t")

    assert result.url == "https://example.com.au"
    assert result.scheme_was_inferred is True


def test_surrounding_whitespace_is_stripped_from_a_url_that_has_a_scheme() -> None:
    result = normalise_website_url("\n https://example.com  ")

    assert result.url == "https://example.com"
    assert result.scheme_was_inferred is False


# ---------------------------------------------------------------------------
# Absence stays absence
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("blank", ["", "   ", "\t\n "])
def test_a_blank_value_stays_blank(blank: str) -> None:
    """The empty string is the exact value workers.enrich keys its no-site
    path on, and `clients.playwright_audit` short-circuits on it before any
    browser is launched. Turning a blank into `https://` would hand both of
    them a URL for a business that has no website, converting a truthful
    `no_website` record into a fabricated unreachable one.
    """
    result = normalise_website_url(blank)

    assert result.url == ""
    assert result.scheme_was_inferred is False


@pytest.mark.parametrize("slashes_only", ["//", "///"])
def test_a_value_that_is_only_slashes_stays_blank(slashes_only: str) -> None:
    """Consuming the leading slashes of a protocol-relative URL can leave
    nothing behind. `https://` with no host is not a website, and would be
    handed to Chromium as though it were one."""
    result = normalise_website_url(slashes_only)

    assert result.url == ""
    assert result.scheme_was_inferred is False

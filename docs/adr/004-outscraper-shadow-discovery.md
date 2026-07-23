# ADR 004 - Outscraper Shadow Discovery Before Apollo

**Status:** Accepted for the bounded A/B shadow pilot. Supersedes ADR 003 only for staged shadow discovery.
**Date:** July 2026

## Context

ADR 003 intentionally limited Phase 1 to one Apollo CSV. PrinterIQ now needs to test discovery of Greater Brisbane plumbing businesses with missing or weak websites without changing the production lead pipeline.

## Decision

Outscraper may populate tenant-scoped prospect staging for a 300-500 business shadow run. The pilot is fixed to plumbing businesses in Brisbane, Logan, Ipswich, Moreton Bay, and Redlands, with a hard cap of 500 returned businesses.

Staged prospects cannot create leads, website previews, outreach sends, or Instantly requests. Apollo remains the contact resolver and only a verified business email is accepted. Live sending requires a separate ADR and compliance review.

Outscraper and Apollo credentials remain server-only. Provider payloads are retained for 30 days. Held, rejected, and unresolved normalized records are retained for 90 days only after the run is completed; active reviews retain their evidence.

## Consequences

- Provider terms, Australian privacy obligations, data retention, API spend, and lower Route A contact-match rates are explicit pilot risks.
- Public contact details are not treated as consent for outreach.
- The existing Apollo CSV path and lead state machine remain unchanged.
- A successful pilot produces a go/no-go recommendation only; it does not enable promotion or outreach.

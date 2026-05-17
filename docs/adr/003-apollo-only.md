# ADR 003 — Apollo CSV as sole lead source for Phase 1

**Status:** Accepted  
**Date:** May 2026

## Context

PrinterIQ needs a database of Australian tradie businesses with email addresses, phone numbers, websites, and tech stack data. Options: scrape Google/LinkedIn, buy leads from a broker, or use an existing Apollo.io export.

## Decision

Phase 1 uses a single Apollo.io CSV export of 4,484 leads (Apollo Construction — NSW, WA, QLD). No new lead sourcing is built in Phase 1.

## Rationale

- **Data quality.** Apollo provides 100% email-verified contacts, 99.8% with website URLs, 93% with tech stack data. This is sufficient for the enrichment pipeline to work without Google Maps lookups for the vast majority of leads.
- **Speed.** The export already exists. Building a scraper or API integration delays the revenue engine by weeks.
- **Volume.** 4,484 leads at a ~40% qualification rate gives ~1,800 qualified leads to contact — more than sufficient for Phase 1 revenue targets.
- **No new scope.** The column mapping for Apollo's 70-column CSV is hardcoded in `ingest.py`. Supporting a second lead source would require a CSV adapter layer — out of scope for Phase 1.

## Consequences

- `ingest.py` column mapping is hardcoded for Apollo format. A different CSV format will require a new ingest worker or an adapter.
- Phase 2 will need to define how new leads are sourced (ongoing Apollo exports, a second provider, or inbound).
- The `source_file` column in `leads` tracks which CSV each lead came from, enabling future dedup across multiple imports.
- Out of scope per PRD Section 13: no scraping, no new lead sourcing, no second vertical.

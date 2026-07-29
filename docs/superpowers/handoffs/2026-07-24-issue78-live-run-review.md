# PrinterIQ Issue #78 Live Run Review - 2026-07-24

## Scope

Issue #78: Run the Greater Brisbane plumbing shadow cohort and publish a go/no-go decision.

This review used the fresh worktree only:

`C:\Users\Hi\.codex\worktrees\7c4e\PrinterIQ`

The protected dirty main checkout was not touched. No secrets were printed. No new provider run was started. No prospect was promoted into leads, previews, outreach, or Instantly.

## Decision

Recalibrate and repeat.

The run is useful evidence, but it cannot pass Issue #78. It has no Route B cohort, only a 40-record validation sample, incomplete manual precision, failing usable yield, and unresolved provider cost reconciliation.

## Verified Live Run

Latest discovery run:

- Run ID: `7468dcbc-7813-4384-8f75-fd5d8f9a44cb`
- Status: `review_ready`
- Source: `outscraper`
- Source request ID: present in DB
- Submitted: `2026-07-23T21:06:33.684Z`
- Results received: `2026-07-23T21:08:10.428Z`
- Review ready: `2026-07-23T21:09:48.773Z`
- Failure code: `insufficient_sample`
- Failure detail: `Validation sample insufficient for passing gates: A=146, B=0, healthy_rejected=122`

Run counts:

- Discovered: 280
- Usable: 146
- Route A: 146
- Route B: 0
- Verified contacts: 33
- Route A verified contacts: 33
- Route B verified contacts: 0

Validation sample:

- Total selected sample: 40
- Route A sample: 20
- Route B sample: 0
- Healthy/rejected sample: 20
- Manual review rows: 0

Dashboard metrics:

- Usable yield: 52.1%, fails the >= 70% gate
- Routeable yield: 52.1%, passes the >= 20% gate
- Verified contacts: 33, passes the >= 30 count gate
- Unexpected failure rate: 0%, passes the < 5% gate
- Eligibility precision: incomplete
- Route precision: incomplete
- Cost status: reconciliation required

## Authenticated Dashboard Walk

The operator dashboard login succeeded and `/prospects` loaded.

Observed UI state:

- Shadow-mode banner is visible: staged prospects cannot create leads, previews, or outreach.
- Latest run shows `Review Ready`.
- Review gates show sample `40`, Route A sample `20`, Route B sample `0`, healthy/rejected sample `20`.
- The blocker notice shows: `40 sample records still need review; Cost reconciliation required; Sample is insufficient for a passing result`.
- The evidence list renders 280 prospect cards.
- The export link is present for `/api/prospects/export?runId=7468dcbc-7813-4384-8f75-fd5d8f9a44cb`.

Additional UI issue found:

- The dashboard showed `Start discovery run` while the latest run was `review_ready`.
- The operator runbook forbids starting another run while a run is `created`, `submitted`, `polling`, `persisted`, `processing`, or `review_ready`.
- This branch adds a dashboard fix so `persisted` and `review_ready` hide the start control.
- Hosted DB migration `0009_block_incomplete_discovery_runs.sql` was applied and read back successfully, so production now blocks another discovery run while any tenant run is `created`, `submitted`, `polling`, `persisted`, `processing`, or `review_ready`.

## Provider Reconciliation

Read-only Outscraper reconciliation was run against the existing completed source request ID only. It did not submit a new search.

Provider response:

- HTTP status: 200
- Provider status: `Success`
- Returned records: 280
- Website-like keys present: none

Top returned provider keys were limited to basic place fields such as `business_status`, `category`, `city`, `latitude`, `location_link`, `longitude`, `name`, `phone`, `place_id`, `postal_code`, `rating`, `reviews`, `state`, and `subtypes`.

This matches the hosted DB finding: all 280 stored source snapshots have no mapped `source_website_url`, no mapped `normalized_domain`, and no raw `site`, `website`, or `domain` key.

Relevant current Outscraper docs:

- `/google-maps-search` supports a `fields` selector and says the default returns all fields.
- The official sample response includes `site`.
- Outscraper FAQ says website/no-website filtering exists in advanced filters, but API support for UI quick filters must be confirmed before relying on it.

## Outcome Breakdown

Live DB outcome reasons:

- `no_owned_website`: 146 Route A / contact enriched
- `wrong_category`: 108 rejected
- `outside_region`: 13 rejected
- `ambiguous_duplicate`: 11 held
- `franchise`: 1 held
- `permanently_closed`: 1 rejected

Contact resolution:

- Route A verified: 33
- Route A no match: 113
- Non-routed/held/rejected contact attempts: none

Shadow isolation:

- Prospects with `lead_id`: 0
- Joined website previews from prospects: 0
- Joined outreach sends from prospects: 0

Runtime:

- PM2 `pipeline`, `dashboard`, and `reply-agent`: online
- Redis `bull:pipeline:wait`: 0
- Redis `bull:pipeline:active`: 0
- Redis `bull:pipeline:delayed`: 0
- Run jobs for `start_discovery`, `poll_outscraper`, `normalize_prospects`, `assess_prospects`, `enrich_prospect_contacts`, and `prepare_shadow_review`: completed

## Gate Review

- Exactly one fixed run: satisfied for this review cycle.
- Provider identifiers: satisfied by DB source request ID; not repeated here.
- Complete run reaches terminal state: satisfied, `review_ready` with actionable `insufficient_sample`.
- Manual 60-record sample review: failed/incomplete. Only 40 sample records exist because Route B sample is 0.
- Eligibility precision: incomplete, no manual decisions.
- Route precision: incomplete, no manual decisions.
- Usable yield: failed at 52.1%.
- Routeable yield: passed at 52.1%.
- Verified-email count: passed at 33.
- Route A/B volumes and match rates: Route A 146 with 23% verified match; Route B 0 with no match rate.
- Provider spend/cost: incomplete, reconciliation required.
- Shadow isolation: passed in DB checks.
- Live outreach enabled: no.

## What Issue #78 Needs Next

1. Reconcile spend from Outscraper and Apollo accounts and record actual cost per discovered, usable, routed, and verified prospect.
2. Deploy the dashboard start-control fix before any repeat live run, so the UI matches the hosted DB guard that now blocks `persisted` and `review_ready`.
3. Decide the calibration strategy for producing Route B:
   - If staying on Google Maps search, test a no-spend/request-design change first where possible, because the completed request had no `site` evidence at all.
   - Consider omitting the restrictive `fields` selector or using all provider fields for the calibration run, so schema drift or omitted columns are visible.
   - Confirm whether API-supported filters can target listings with websites; do not assume UI quick filters are available through `/google-maps-search`.
   - Consider a separate approved website-present calibration cohort, still shadow-only, if the provider/API can support it.
4. Manually review the current 40-record sample as a provider-quality exercise, but do not treat it as a passing Issue #78 sample.
5. Start a new live provider run only after explicit operator approval of query strategy, expected credit use, and spend ceiling.

## Boundaries Preserved

- Route A remains shadow-only.
- No leads, previews, outreach sends, or Instantly requests were created.
- No manual Apollo or new Outscraper search was started.
- No destructive DB, Redis, or storage action was performed.
- The only live DB write was the non-destructive active-run guard migration that recreates `discovery_runs_one_active_per_tenant_idx`.

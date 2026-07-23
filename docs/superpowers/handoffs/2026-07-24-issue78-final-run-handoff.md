# Issue 78 Final Live Run Handoff

Date: 2026-07-24
Repository: PrinterIQ
Branch containing this handoff: `codex/issue-78-final-handoff`
Protected checkout boundary: do not work in, clean, reset, stage, or switch `C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ`. Use only the fresh worktree.

## Suggested Skills

- `supabase`: use for any hosted DB inspection or tenant-scoped DB changes.
- `browser:control-in-app-browser`: use for dashboard `/prospects` verification.
- `diagnose`: use for the Apollo false-positive contact matcher and stale-active processing stall.
- `handoff`: use when creating the next committed continuation document.

## Source Context

Read these before continuing:

- `CLAUDE.md`
- `docs/operator-runbook.md`
- `docs/superpowers/specs/2026-07-22-outscraper-a-b-shadow-pilot-design.md`
- `docs/superpowers/handoffs/2026-07-24-issue78-next-sequence-handoff.md`
- `docs/superpowers/handoffs/2026-07-24-issue78-live-run-review.md`
- `docs/superpowers/handoffs/2026-07-24-prospects-live-run-handoff.md`

`AGENTS.md` was not present in this worktree.

## Credentials And Secrets

Dashboard credentials were provided directly in the task during the live run, but are intentionally not repeated here. Do not commit, print, paste into PRs, or store any credentials.

Important: the browser automation transcript exposed the filled dashboard credentials in tool output. Recommend rotating the dashboard password after this work window.

## Code And Deploy State

Merged and deployed during this sequence:

- PR #87, duplicate discovery-run guard UI, merged to `dev`.
- PR #89, production deploy of duplicate discovery-run guard, merged to `main` at `e4f06fcc6b7d653e76223a0a3c4c88341f32fd79`; deploy run `30048975164` succeeded.
- PR #90, current Outscraper website-field capture, merged to `main` at `dcbd866b490e0f30465c3956eb25f92b1c6c18ce`; deploy run `30050121797` succeeded.
- PR #91, JSONB NUL payload sanitizer, merged to `main` at `eb09a534c7397d4b0fbcaf00ae130e5111064b07`; deploy run `30052497979` succeeded.

PR #91 fixed a live processing blocker discovered during the repeat run: website resolver text contained a NUL byte, and Postgres rejected the JSONB payload with `unsupported Unicode escape sequence` / `\u0000 cannot be converted to text`.

Local verification for PR #91:

```powershell
python -m pytest services/pipeline/tests/test_queries.py services/pipeline/tests/test_outscraper_client.py services/pipeline/tests/test_discover_prospects.py services/pipeline/tests/test_schema.py
```

Result: `60 passed`.

## Live Run Sequence

Old evidence run:

- Run id: `7468dcbc-7813-4384-8f75-fd5d8f9a44cb`
- Final status before retirement: `review_ready`
- Counts: discovered `280`, usable `146`, Route A `146`, Route B `0`, verified contacts `33`
- Failure code: `insufficient_sample`
- No leads created.
- It was tenant/run scoped to `completed` with an `operator_repeat_decision` provider-usage note so a repeat shadow run could start. No prospect rows, leads, previews, outreach, storage, or provider data were deleted.

Provider calibration before the repeat:

- One approved Outscraper calibration request was run with query `plumber Brisbane QLD`, `limit=10`, `region=AU`, `language=en`, `async=false`, no enrichment, no DB writes, no Apollo.
- It returned 10 records.
- All 10 records used the current `website` field, not `site`.
- This proved the previous production field selector suppressed website data.

Repeat shadow run:

- New run id: `d8c015a3-f568-43ea-b8da-3c7994cf4acb`
- Started through the dashboard `/prospects` Start button, not by manual DB insertion.
- Shadow mode remained true.
- Source request id was present immediately after submission.
- No second repeat run was started.

Processing notes:

- Outscraper returned `276` records.
- Website capture worked: final DB readback showed `235` rows with non-empty `source_website_url`.
- Raw `source_payload ? 'website'` is not reliable after normalization, because source payloads are merged/replaced with resolver/audit evidence; use `source_website_url` for final website-capture proof.
- The repeat run stalled in `processing` after partial normalization because a website payload contained a NUL byte and the JSONB write failed.
- PR #91 was created, tested, merged, and deployed to fix recursive JSONB NUL sanitization.
- The run was then recovered tenant/run scoped from `failed` stale-active status back to `processing` with an `operator_recovery` provider-usage note.
- Normalization was resumed against the existing 276 persisted rows only. No new Outscraper request was made.
- Long local assessment took about 707.7 seconds and audited 87 sites. The stale-active guard marked the run failed during the long assessment, so it was recovered again with an `operator_recovery_after_assessment` note and continued.
- Apollo contact enrichment was run for the assessed Route A/B candidates as part of the approved shadow run. No lead promotion, preview generation, outreach scheduling, or Instantly action was performed.

## Final Production State

Final run id: `d8c015a3-f568-43ea-b8da-3c7994cf4acb`

DB readback:

- Status: `review_ready`
- Review ready at: `2026-07-23T23:35:50.724531+00:00`
- Discovered: `276`
- Usable: `123`
- Route A: `47`
- Route B: `14`
- Verified contacts: `11`
- Failure code: `insufficient_sample`
- Failure detail: `Validation sample insufficient for passing gates: A=47, B=14, healthy_rejected=193`
- Validation sample total: `54`
- Sample cohorts: A `20`, B `14`, healthy/rejected `20`
- Prospects with `lead_id`: `0`
- Contact rows: `61`
- Contact statuses: `50` no-match, `11` verified
- Contact rows with `credits_consumed`: `0`
- Distinct verified emails: `1`

Browser `/prospects` proof:

- Page title: `PrinterIQ Dashboard`
- Latest run: `Review ready`
- Start control hidden by active-run state: UI showed `A discovery run is active.`
- `Refresh run status` visible.
- `Export CSV` visible for `/api/prospects/export?runId=d8c015a3-f568-43ea-b8da-3c7994cf4acb`.
- Dashboard summary showed discovered `276`, usable `123`, Route A `47`, Route B `14`, verified contacts `11`, Route A verified `7`, Route B verified `4`.
- Review gates showed sample `54`, Route A sample `20`, Route B sample `14`, healthy/rejected sample `20`.
- Gate copy showed `Cost reconciliation required` and `Sample is insufficient for a passing result`.

## Cost Reconciliation

Outscraper:

- Before the repeat sequence, upcoming invoice showed quantity `290`, invoice total `0.0 usd`.
- After the repeat run, Outscraper balance readback showed:
  - balance `9.8`
  - account status `valid`
  - upcoming invoice quantity `566`
  - invoice total `0.20 usd`
  - invoice currency `usd`
- The quantity aligns with 290 prior records plus 276 repeat records.

Apollo:

- No-spend usage endpoint attempts returned `404 Not Found`, including the header-auth form and the query-string shape.
- DB has 61 contact rows: 50 no-match, 11 verified.
- DB `credits_consumed` is null/unset for every contact row.
- DB evidence includes provider request counts for verified contacts only; the sum from verified rows was `33`. This is not authoritative billing, and Apollo cost must not be invented.
- Apollo billing/usage UI or another working provider-side usage source is still required for authoritative credit reconciliation.

## Critical Finding

Route B discovery is now working, but Apollo contact matching is not safe.

All 11 rows marked `verified` resolved to the same obviously wrong contact:

- person name: `Bill Gates`
- title: `Founder`
- email: `be@breakthroughenergy.org`

Those same values appeared across unrelated plumbing businesses and both Route A and Route B records. The DB reported `distinct_verified_emails = 1`.

This invalidates the contact-match gate even though the dashboard count says 11 verified contacts.

## Recommendation

No-go for Issue #78 promotion, preview generation, outreach scheduling, or Instantly action.

The website-field blocker is fixed and Route B evidence now exists. However, the run still fails the sample/contact gates and Apollo "verified" contacts are false positives. Do not promote any prospects from this run until Apollo matching is hardened and rerun.

Recommended next engineering sequence:

1. Fix Apollo organization/person matching.
   - Require strong organization identity evidence before accepting a person.
   - Compare Apollo organization name/domain against the business name, normalized domain, and source website domain.
   - Reject generic or unrelated organizations even if Apollo returns a single organization.
   - Store enough organization evidence in `match_evidence` for dashboard review.
   - Add regression tests using the observed false-positive pattern: unrelated plumbing businesses all resolving to the same external founder/contact.

2. Add stale-active protection for long prospect processing.
   - The 10-minute stale-active guard is too aggressive for long website assessment runs.
   - Add worker heartbeat/progress updates, split website assessment into smaller queued batches, or exempt active long-running prospect stages from dashboard stale recovery.

3. Reconcile Apollo costs through a trustworthy provider source.
   - The API usage endpoint used in this task returned 404.
   - DB `credits_consumed` cannot be treated as authoritative because it is null for all rows.

4. After those fixes are deployed, run one new approved shadow discovery run.
   - Keep the same boundaries: no lead promotion, no preview generation, no outreach scheduling, and no Instantly action until review gates pass and operator approves promotion.

## Commands And Evidence To Reuse

Final DB summary query should include:

- `discovery_runs` status/counts/failure fields for run id `d8c015a3-f568-43ea-b8da-3c7994cf4acb`
- `business_prospects` counts for `source_website_url`, `lead_id`, validation sample, and sample cohorts
- `prospect_contacts` counts by status, `credits_consumed`, and distinct verified emails

Final browser verification should revisit:

```text
https://dashboard.presciaiq.com/prospects
```

Do not use prior-task credentials. If the browser session is not authenticated, ask the user to sign in manually or provide credentials directly in that task, then recommend password rotation after the work window.

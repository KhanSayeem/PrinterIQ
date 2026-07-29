# Issue 78 Production Hardening And Closeout Handoff

Date: 2026-07-29
Repository: PrinterIQ
Branch containing this handoff: `codex/issue-78-apollo-stale-hardening`
Protected checkout boundary: do not work in, clean, reset, stage, or switch `C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ`. Use only an isolated worktree.

## Suggested Skills

- `handoff`: use when creating the next committed continuation document.
- `supabase`: use for any hosted DB inspection or tenant-scoped evidence checks.
- `browser:control-in-app-browser`: use for authenticated dashboard `/prospects` verification if the operator signs in.
- `diagnose`: use if the hardened Apollo matching or stale processing recovery shows unexpected behavior.

## Source Context

Read these before continuing:

- `CLAUDE.md`
- `docs/operator-runbook.md`
- `docs/superpowers/specs/2026-07-22-outscraper-a-b-shadow-pilot-design.md`
- `docs/superpowers/handoffs/2026-07-24-issue78-final-run-handoff.md`
- `docs/superpowers/handoffs/2026-07-24-issue78-live-run-review.md`
- `docs/superpowers/handoffs/2026-07-24-issue78-next-sequence-handoff.md`
- `docs/superpowers/handoffs/2026-07-24-prospects-live-run-handoff.md`

## Current Production State

Issue #78 remains open:

- Issue: https://github.com/KhanSayeem/PrinterIQ/issues/78
- Status comment added: https://github.com/KhanSayeem/PrinterIQ/issues/78#issuecomment-5111696672

The hardening code has been promoted to production:

- PR #92, `codex/issue-78-apollo-stale-hardening` to `dev`, merged successfully.
- PR #93, `dev` to `main`, merged successfully: https://github.com/KhanSayeem/PrinterIQ/pull/93
- Production merge commit: `d1e569365721e30f8c7ed0f3a5976df3059e9b7e`
- Production deploy workflow: https://github.com/KhanSayeem/PrinterIQ/actions/runs/30414059785
- Deploy result: `success`

No live provider run, lead promotion, preview generation, outreach scheduling, or Instantly action was performed during the hardening/deploy closeout.

## What Changed

Apollo hardening:

- Strategy version is now `apollo-owner-verified-v2`.
- Apollo organization search can return structured `ApolloNoMatch` evidence instead of collapsing no-match outcomes to `None`.
- Generic trade/category token overlap no longer satisfies business-name matching by itself. The regression case from review, `A Grade Plumbing and Gas` versus `Smith Plumbing Gas`, is covered.
- No-match outcomes preserve request count, provider usage, rejected Apollo organization name/domain, organization count, and rejection reason where available.
- Contact-enrichment worker persists structured Apollo no-match evidence for `no_match` outcomes.

Dashboard stale-active protection:

- Dashboard stale recovery no longer excludes all `processing` discovery runs forever.
- `processing` runs use a longer stale cutoff and are only failed when there is no active prospect queue job for the run beyond that cutoff.
- Regression coverage asserts the active job guard appears in the recovery query.

## Verification Completed

Local verification before PR #92:

```powershell
python -m pytest services/pipeline/tests/test_apollo_client.py services/pipeline/tests/test_enrich_prospect_contacts.py services/pipeline/tests/test_queue_infrastructure.py
python -m pytest services/pipeline/tests/test_apollo_client.py services/pipeline/tests/test_enrich_prospect_contacts.py services/pipeline/tests/test_queue_infrastructure.py services/pipeline/tests/test_discover_prospects.py services/pipeline/tests/test_outscraper_client.py services/pipeline/tests/test_queries.py
```

Results recorded in-session:

- Focused Apollo/enrichment/queue suite: `35 passed`
- Expanded pipeline prospect suite after dev merge resolution: `90 passed`
- `git diff --check`: passed, with Windows line-ending warnings only

Dashboard verification after installing dependencies in `services/dashboard`:

```powershell
npm install
npm run test -- src/db/queries.test.ts src/app/actions/prospect-run-actions.test.ts
npm run test -- "src/app/(app)/prospects/page.test.tsx"
```

Results recorded in-session:

- DB/action Vitest files: `41 tests passed`
- Prospects page Vitest file: `5 tests passed`
- `npm install` reported 8 audit vulnerabilities already present in the dashboard dependency graph: 1 low, 7 high. No tracked package files changed.

GitHub verification:

- PR #92 checks passed: Dashboard build, Python ruff/mypy/pytest, Reply Agent tsc/vitest, CodeRabbit.
- PR #93 checks passed: Dashboard build, Python ruff/mypy/pytest, Reply Agent tsc/vitest, CodeRabbit.
- PR #93 was mergeable before merge.
- Production deploy run `30414059785` completed successfully.

Production smoke verification:

```powershell
curl.exe -I https://dashboard.presciaiq.com
curl.exe -I https://dashboard.presciaiq.com/login
```

Observed:

- `/` returned `307 Temporary Redirect` to `/login?redirectedFrom=%2F`.
- `/login` returned `200 OK`.

Production source verification on `origin/main` found:

- `apollo-owner-verified-v2`
- `ApolloNoMatch`
- `single_rejected_identity`
- provider usage/request count evidence for Apollo no-match outcomes
- regression test data for `A Grade Plumbing and Gas` versus `Smith Plumbing Gas`
- `processingStaleBefore`
- active `queue_jobs` guard for stale `processing` discovery-run recovery

## Why Issue 78 Is Still Open

Do not close Issue #78 yet.

The issue acceptance criteria are broader than shipping the hardening patch. The committed handoffs still record a no-go pilot result:

- the completed pilot had false-positive Apollo verified contacts before hardening;
- provider spend reconciliation is incomplete;
- manual review gates are incomplete;
- the run-level go/no-go criteria have not been re-evaluated with hardened Apollo evidence;
- a new live provider run would spend provider credits and requires explicit operator approval first.

The correct current decision is: production hardening deployed, but Issue #78 pilot closeout remains open.

## Proper Closeout Sequence

Use this sequence to close Issue #78 safely:

1. Confirm operator approval before any new live provider work.

   Approval must cover the Outscraper query strategy, Apollo usage, expected credit use, rate limits, and spend ceiling. Do not start another full run from the dashboard or manually call provider APIs without that explicit approval.

2. Decide whether a hardened rerun is required.

   A rerun is likely required because the previous Apollo verified-contact metrics were invalidated by false positives. If the operator chooses not to rerun, document that Issue #78 cannot fully satisfy its original acceptance criteria and close only if the operator accepts a stop/no-go outcome.

3. If approved, run exactly one fixed Greater Brisbane plumbing shadow run with the agreed 300-500 business cap.

   Keep the run shadow-only. Do not promote prospects into leads. Do not generate previews. Do not schedule outreach. Do not call or configure Instantly.

4. Record provider evidence.

   Record Outscraper request IDs, Apollo request counts, observed usage, and reconciled spend without exposing credentials. If provider account UI/API cannot produce authoritative spend, mark the cost gate incomplete instead of inventing values.

5. Review the persisted validation samples.

   Complete independent manual review for the required cohorts:

   - 20 Route A
   - 20 Route B
   - 20 healthy/rejected

   Manual review must use independent evidence from the business profile, website, and/or other public evidence. Do not mark manual review based only on automated evidence.

6. Recalculate and report the required metrics.

   Report eligibility precision, route precision, usable yield, routeable yield, unexpected failure rate, verified-email counts, Route A/B volumes, Route A/B verified-email match rates, and actual cost per discovered, usable, routed, and verified prospect.

7. Verify shadow isolation in the database.

   Confirm zero prospect-created leads, zero website previews, zero outreach sends, and zero Instantly requests for the shadow run.

8. Publish the final decision.

   The decision must be one of:

   - `go`
   - `recalibrate-and-repeat`
   - `stop`

   Explain every passed, failed, or incomplete gate.

9. Close Issue #78 only after the final decision is posted.

   The closing comment should link PR #92, PR #93, the production deploy run, the final pilot evidence report, and the database shadow-isolation evidence.

## Safe Next Actions

- Read current Issue #78 comments and labels.
- Ask the operator whether they approve a hardened rerun and what spend ceiling applies.
- If no approval is given, prepare a no-go/stop closeout report from existing evidence and explicitly state which acceptance criteria remain incomplete.
- If approval is given, run the shadow pilot only through the approved dashboard/worker path and monitor without manually bypassing the queue.

## Hard Boundaries

- Do not touch the protected dirty/main checkout at `C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ`.
- Do not print or commit secrets.
- Do not run live provider calls without explicit operator approval.
- Do not promote prospects into leads.
- Do not generate website previews from shadow prospects.
- Do not schedule outreach.
- Do not call or configure Instantly.
- Do not close Issue #78 based only on green tests or production deploy success.

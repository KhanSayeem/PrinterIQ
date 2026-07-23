# PrinterIQ Issue #78 Next Sequence Handoff - 2026-07-24

## Purpose

Fresh-session handoff for continuing Issue #78 after the live `/prospects` run review and PR #87.

Start from this branch if available:

`codex/issue-78-live-run-review`

PR:

`https://github.com/KhanSayeem/PrinterIQ/pull/87`

Read first:

- `CLAUDE.md`
- `AGENTS.md` if present
- `docs/superpowers/handoffs/2026-07-24-prospects-live-run-handoff.md`
- `docs/superpowers/handoffs/2026-07-24-issue78-live-run-review.md`
- `docs/operator-runbook.md`
- `docs/superpowers/specs/2026-07-22-outscraper-a-b-shadow-pilot-design.md`

## Suggested Skills

- `supabase`: hosted DB/runtime checks and migration verification.
- `browser:control-in-app-browser`: authenticated `/prospects` UI verification.
- `diagnose`: if provider field behavior, dashboard state, DB state, Redis, or PM2 disagree.
- `handoff`: write another repo-local handoff before ending a long continuation.

## Credential Handling

The source task included dashboard login credentials in chat. Do not commit, print, paste into PRs, or store those credentials in files. They are intentionally redacted from this handoff.

If the browser session is not already authenticated, ask the user to provide the dashboard credentials directly in the new task or sign in manually. Recommend rotating the credential after this work window because it was pasted into chat.

## Current Verified State

Live run:

- Run ID: `7468dcbc-7813-4384-8f75-fd5d8f9a44cb`
- Status: `review_ready`
- Discovered: 280
- Usable: 146
- Route A: 146
- Route B: 0
- Verified contacts: 33
- Failure code: `insufficient_sample`
- Failure detail: `Validation sample insufficient for passing gates: A=146, B=0, healthy_rejected=122`

Authenticated dashboard review found:

- Shadow-mode banner visible.
- Review gates show sample 40, Route A sample 20, Route B sample 0, healthy/rejected sample 20.
- Blockers shown: 40 sample records still need review, cost reconciliation required, sample insufficient.
- Evidence list renders 280 prospect cards.
- Export link exists for the live run.

Provider reconciliation:

- Existing Outscraper request was fetched read-only by source request ID.
- Provider returned 280 records and no website-like fields.
- Hosted DB also has no `source_website_url`, no `normalized_domain`, and no raw `site`, `website`, or `domain` keys across all 280 snapshots.
- Therefore Route B is 0 because no owned website inputs existed to audit and score.

Runtime/isolation:

- PM2 `pipeline`, `dashboard`, and `reply-agent`: online at last check.
- Redis `bull:pipeline:wait`, `active`, `delayed`: 0 at last check.
- Shadow isolation clean: 0 prospects with `lead_id`, 0 joined website previews, 0 joined outreach sends.

## Completed In Previous Session

PR #87 was opened to `dev` and CI passed:

- Dashboard (ESLint + tsc + build): pass
- Python (ruff + mypy + pytest): pass
- Reply Agent (tsc + vitest): pass

Local checks run:

- `npm run test -- ProspectsWorkbench.test.tsx`
- `python -m pytest services/pipeline/tests/test_schema.py`
- `npm run build`

Hosted DB migration `0009_block_incomplete_discovery_runs.sql` was applied and read back. The live index now blocks another discovery run while a tenant has any run in:

`created`, `submitted`, `polling`, `persisted`, `processing`, `review_ready`

PR #87 still needs merge/deploy for the dashboard UI to hide the start button while a run is `review_ready`.

## Next Sequence

### 1. Refresh current state

Use only the fresh worktree. Do not touch the protected dirty main checkout at:

`C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ`

Refresh:

- `git status --short --branch`
- `git fetch origin dev main`
- `gh pr view 87 --json number,title,state,url,baseRefName,headRefName,mergeable,reviewDecision,statusCheckRollup`
- Hosted DB readback of `discovery_runs_one_active_per_tenant_idx`
- Current `/prospects` dashboard state if authenticated

### 2. Merge/deploy PR #87

If PR #87 is still green and mergeable, merge it to `dev` only after confirming the user still wants to proceed.

Then deploy the dashboard fix to production through the repo's normal path. Prior deployments used PRs from `dev` to `main` to trigger production deploy. Check current branch/CI state before choosing the exact path.

After deploy:

- Open authenticated `https://dashboard.presciaiq.com/prospects`.
- Confirm the live run is still `review_ready`.
- Confirm `Start discovery run` is no longer visible while this run is `review_ready`.
- Confirm `Refresh run status` and export remain available.

### 3. Reconcile provider cost

Record actual spend/usage without exposing credentials:

- Outscraper request cost or provider usage for the completed request.
- Apollo credits used for the 146 Route A contact attempts.
- Cost per discovered, usable, routed, and verified prospect.

If provider account UI/API does not expose authoritative spend, mark Issue #78 cost gate incomplete. Do not invent costs.

### 4. Calibrate Route B source strategy

Do not start another 300-500 prospect run yet.

First determine whether Outscraper can return website fields reliably:

- Prefer a no-spend or provider-account inspection if possible.
- If a live test is required, ask for explicit operator approval first.
- Use a tiny capped calibration request only, such as 5-10 records.
- Test omitting the restrictive `fields` selector or requesting all fields.
- Confirm whether `site` or equivalent website fields appear.
- Confirm whether API-supported filters can target listings with websites; do not assume UI quick filters are available through `/google-maps-search`.

Decision point:

- If website fields appear reliably, patch request configuration and run tests before proposing a repeat shadow cohort.
- If website fields do not appear, stop and propose a different source strategy or provider endpoint for Route B.

### 5. Current 40-record sample

The current 40-record sample can be manually reviewed as provider-quality evidence, but it cannot satisfy Issue #78 because Route B sample is 0 and the required sample is 20 Route A, 20 Route B, and 20 healthy/rejected.

Do not mark manual reviews from automated evidence alone. Manual review requires independent evidence from business/profile/website checks.

## Approval Boundaries

The user approved creating a fresh session to continue the sequence.

Still require explicit approval before:

- Starting any new Outscraper request, even a tiny calibration request.
- Spending Apollo credits outside existing run reconciliation.
- Promoting prospects into leads.
- Generating previews.
- Scheduling outreach.
- Calling or configuring Instantly.
- Destructive DB, Redis, storage, or provider cleanup.

Route A remains shadow-only.

## Expected Closeout

Close out the next session with:

- PR/deploy status for #87.
- Browser proof of the updated `/prospects` start-control behavior.
- Provider cost reconciliation result or explicit blocker.
- Route B calibration result or explicit request for provider-spend approval.
- A clear Issue #78 recommendation: still recalibrate-and-repeat, stop, or ready for repeat run approval.

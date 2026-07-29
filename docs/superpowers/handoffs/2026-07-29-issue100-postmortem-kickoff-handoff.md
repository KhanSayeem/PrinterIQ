# Issue #100 postmortem kickoff handoff

## Purpose

Start a fresh PrinterIQ session for GitHub Issue #100:

https://github.com/KhanSayeem/PrinterIQ/issues/100

The task is a no-spend postmortem/calibration investigation for the failed/incomplete Issue #78 shadow pilot gates. The deliverable is an issue comment/report, not a provider rerun.

## Starting state

- Repository: PrinterIQ
- Base branch for this handoff: `codex/issue-100-kickoff-handoff`, created from current `origin/dev`
- Current `origin/dev` includes PR #101:
  - `ddb0e6a328894f9a0152e25de3ce9bb2dc91fab2`
  - PR: https://github.com/KhanSayeem/PrinterIQ/pull/101
  - Dashboard dependencies now use `pnpm@10.18.3`
- Issue #100 state at kickoff: open, labeled `enhancement` and `ready-for-agent`
- Issue #78 is closed as stop/no-go from existing evidence, not as a passed pilot

Use only a fresh worktree. Do not work in, clean, reset, stage, or switch the protected dirty/main checkout:

`C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ`

## Required reading

Read these first:

- `CLAUDE.md`
- `docs/operator-runbook.md`
- `docs/superpowers/specs/2026-07-22-outscraper-a-b-shadow-pilot-design.md`
- `docs/superpowers/handoffs/2026-07-24-issue78-final-run-handoff.md`
- `docs/superpowers/handoffs/2026-07-24-issue78-live-run-review.md`
- `docs/superpowers/handoffs/2026-07-24-issue78-next-sequence-handoff.md`
- `docs/superpowers/handoffs/2026-07-24-prospects-live-run-handoff.md`
- Issue #100 body and comments

If present in the fresh worktree, also read any newer Issue #78 closeout handoffs under `docs/superpowers/handoffs/`.

## Hard boundaries

Do not:

- Start an Outscraper request
- Spend Apollo credits
- Promote prospects into leads
- Generate website previews
- Schedule outreach
- Call, configure, or mutate Instantly
- Run destructive DB, Redis, storage, or provider cleanup
- Close Issue #100 until the requested report is posted and accepted

Use existing evidence only unless the operator explicitly approves a specific provider action with scope and spend ceiling.

## Evidence snapshot to verify

Issue #100 records the existing Issue #78 hosted evidence to analyze:

- Run id: `d8c015a3-f568-43ea-b8da-3c7994cf4acb`
- Status: `review_ready`
- Shadow mode: true
- Discovered: 276
- Usable: 123
- Route A: 47
- Route B: 14
- Verified contacts: 11
- Failure code: `insufficient_sample`
- Validation sample: 54 total, A 20, B 14, healthy/rejected 20
- Manual review rows: 0
- Contact rows: 61 total, 50 no_match, 11 verified, 1 distinct verified email, 0 rows with `credits_consumed`
- Shadow isolation readback: 0 prospect-created leads, 0 promoted prospects, 0 joined website previews, 0 joined outreach sends

Verify these facts from the current hosted DB/dashboard/export state before relying on them. Separate verified facts from inferences in the final issue report.

## Dashboard dependency setup

For the dashboard, use pnpm rather than npm:

```powershell
corepack enable
pnpm config set store-dir C:\Users\Hi\.pnpm-store
cd services/dashboard
pnpm install --frozen-lockfile
```

Do not commit a machine-specific `.npmrc` or store path. The user-level pnpm config is enough.

## Suggested skills

- `diagnose`: use for DB/dashboard/export state discrepancies or unclear failure modes.
- `browser:control-in-app-browser`: use only if live dashboard UI proof is needed.
- `handoff`: use before spawning further fresh sessions or if the investigation cannot be completed in one session.

## Recommended first actions

1. Confirm repo branch, clean worktree state, Issue #100 state, and current `origin/dev` commit.
2. Read the required files above.
3. Query hosted evidence without mutations or provider calls.
4. Analyze gate failures by source data, classifier outcome, Route A/B samples, contact enrichment evidence, and missing cost data.
5. If using the dashboard, perform read-only review/export verification only.
6. Post a report comment on Issue #100 with:
   - no-spend evidence summary
   - gate-by-gate failure analysis
   - recommended query/calibration changes
   - required operator approvals for any future rerun
   - clear recommendation: repeat with calibrated plan, recalibrate further, or stop

## Sensitive information

Dashboard credentials were previously pasted in chat in another session. Do not copy credentials into files, PRs, issue comments, or logs. If browser auth is needed and no session is active, ask the user to sign in manually or provide credentials in the active session, and recommend rotation afterward.

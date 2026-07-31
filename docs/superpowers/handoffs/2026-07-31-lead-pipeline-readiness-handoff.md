# Lead pipeline readiness implementation handoff

## Purpose

Continue PrinterIQ in a fresh GPT-5.5 High session and complete the no-provider-call engineering work required before the controlled Instantly smoke test in GitHub Issue #24.

This handoff is intentionally implementation-focused. Existing architecture, provider pilot evidence, and Instantly QA instructions remain in their source documents and are referenced below rather than duplicated.

## Repository and starting state

- Repository: `PrinterIQ`
- Starting branch: `codex/lead-pipeline-readiness-handoff`
- Base commit before this handoff: `755e6cdb279dc6187a6ac4551df3f84ac2f40e28`
- Protected checkout: do not work in, clean, reset, stage, or switch `C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ`.
- Use only the fresh Codex worktree created for the new session.
- Dashboard dependencies use pnpm. Follow `docs/operator-runbook.md` for the shared pnpm store setup.

## Immediate objective

Make the Apollo CSV lead pipeline internally runnable through qualification without contacting Instantly or replaying production jobs:

1. Repair the missing `score_threshold` payload contract across dashboard import, ingest, enrichment, and qualification.
2. Add cross-stage tests that prove required execution context survives every queue handoff.
3. Verify the no-provider-call workflow locally.
4. Commit, push, open a PR, merge through the repository's normal `dev` to `main` path when CI is green, and verify deployment health.
5. Leave Issue #24 open. It requires the operator's paused dev/test campaign ID and a controlled live Instantly smoke test.

## Verified production evidence on 2026-07-31

Read-only checks found:

- PM2 processes `dashboard`, `pipeline`, and `reply-agent` online with zero restarts since the latest deployment.
- `https://dashboard.presciaiq.com/login` returned HTTP 200.
- Required server configuration is present for the database, Anthropic, Instantly API key, Outscraper, and Apollo.
- `INSTANTLY_CAMPAIGN_ID` is missing or still a placeholder.
- Lead statuses: 31 imported, 2,531 enriched, 1 qualified, 1 contacted, and 1 archived.
- `queue_jobs`: 2,530 dead `qualify_lead` jobs, all with `score_threshold missing from qualify_lead payload`.
- Production has 0 `website_previews`, 0 `outreach_sends`, and 0 stored Instantly lead IDs.
- Production has 0 Outscraper prospects linked to leads.
- Redis pipeline wait, active, delayed, and dead-list counts were all zero.
- The existing `contacted` lead has no `outreach_sends` row and is not end-to-end proof.
- The focused local suite passed: 88 tests across orchestrator, ingest, preview generation, outreach scheduling, and shadow isolation.

Do not repeat production reads unless needed to verify drift. Do not write to production data as part of this work.

## Root cause to fix

The interface contract is documented in `docs/queue-payloads.md`: `score_threshold` must be carried in the queue payload and must not be hardcoded.

Current break:

- `services/dashboard/src/queue/pipeline.ts` creates `ingest_csv` payloads without `score_threshold`.
- `services/dashboard/src/app/api/import-csv/route.ts` has no validated qualification-threshold input/configuration.
- `services/pipeline/src/workers/ingest.py` queues `enrich_lead` without `score_threshold`.
- `services/pipeline/src/workers/enrich.py` queues `qualify_lead` without `score_threshold`.
- `services/pipeline/src/workers/qualify.py` correctly rejects payloads that omit `score_threshold`.
- Existing worker tests supply `score_threshold` directly to qualification and therefore miss the upstream contract failure.

## Implementation requirements

### 1. Define one ingress for the threshold

Use a server-controlled, validated qualification threshold at the dashboard import interface, then carry it explicitly in every queue payload. Preserve the documented invariant that qualification never invents or hardcodes its threshold.

Prefer the smallest interface consistent with existing patterns:

- Add a server-side environment/configuration name such as `QUALIFICATION_SCORE_THRESHOLD` to `.env.example` and the environment loader if appropriate.
- Validate it as an integer in the accepted score range before accepting a real CSV import.
- Return an actionable import error when configuration is absent or invalid; do not enqueue a doomed import.
- Put `score_threshold` on `ingest_csv`, `enrich_lead`, and `qualify_lead` payloads.
- Preserve it through retries and queue-job persistence.
- Do not add the Instantly campaign ID to client-visible form data. The campaign remains server-only configuration.

If current repository conventions support a better server-controlled ingress, use that, but keep the threshold explicit in queue payloads and update `docs/queue-payloads.md`.

### 2. Add contract-level coverage

Add tests that fail against the current implementation and prove:

- Dashboard import rejects absent, malformed, or out-of-range threshold configuration before writing the upload or queueing work.
- `enqueueIngestCsvJob` includes the validated threshold.
- Ingest propagates it to every `enrich_lead` job.
- Enrichment propagates it to `qualify_lead`.
- Qualification still rejects missing thresholds.
- One composed fake pipeline path reaches qualification with the same configured value.
- Dry-run and duplicate-import behavior remain unchanged.
- No test calls Anthropic, Instantly, Outscraper, Apollo, Supabase, Redis, or another hosted provider.

The composed test is essential. Independent worker tests already passed while the production contract was broken.

### 3. Preserve provider and data boundaries

Do not:

- Call, list, configure, or mutate Instantly.
- Start an Outscraper request.
- Spend Apollo credits.
- Run Anthropic qualification or preview generation against production leads.
- Retry, requeue, clean up, delete, or alter the 2,530 historical dead jobs.
- Promote Outscraper prospects into leads.
- Generate production website previews.
- Schedule outreach or add any lead to a campaign.
- Run destructive database, Redis, storage, queue, or provider cleanup.

The code fix may deploy while the campaign ID remains absent. Deployment must not enqueue or replay work by itself.

### 4. Outscraper remains a separate decision

Do not implement prospect promotion in this session. `docs/adr/004-outscraper-shadow-discovery.md` and `docs/superpowers/specs/2026-07-22-outscraper-a-b-shadow-pilot-design.md` intentionally stop the shadow flow before leads, previews, outreach, or Instantly.

Issue #78 closed as stop/no-go and Issue #100 records the calibrated rerun requirements. A future promotion module requires:

- an operator-approved rerun with explicit query scope and spend ceilings,
- passed quality/contact gates,
- a live-outreach/compliance decision,
- an approved promotion interface with deduplication, suppression, provenance, and manual authorization.

This session may document an implementation-ready future issue if a clear untracked gap remains, but must not widen into live promotion.

## Instantly campaign ID gate

GitHub Issue #24 is the only current open issue and remains blocked on a paused dev/test campaign ID plus a controlled test lead.

The operator can obtain the ID without sharing an API key:

1. Sign in to Instantly.
2. Open **Campaigns**.
3. Open the PrinterIQ paused development/test campaign, not a live prospect campaign.
4. Confirm its status is paused and the intended sending accounts are warmed sufficiently for a controlled smoke.
5. Copy the campaign UUID from the campaign page URL or campaign settings/details view.
6. Send only that campaign UUID back to Codex. Do not send the Instantly API key.
7. Also confirm that the campaign must remain paused during the smoke and that only a controlled test email address may be used.

The existing server API key could be used for a one-time read-only campaign-list lookup, but the current operator boundary forbids any Instantly call. Do not perform that lookup unless the operator explicitly authorizes a read-only campaign listing with no mutation or sends.

## Required reading

Read these before editing:

- `AGENTS.md` and `CLAUDE.md`, if present.
- `docs/queue-payloads.md`
- `docs/architecture.md`
- `docs/operator-runbook.md`, especially CSV import, preview campaign QA, and local smoke sections.
- `docs/adr/003-apollo-only.md`
- `docs/adr/004-outscraper-shadow-discovery.md`
- `services/dashboard/src/queue/pipeline.ts`
- `services/dashboard/src/app/api/import-csv/route.ts`
- `services/pipeline/src/workers/ingest.py`
- `services/pipeline/src/workers/enrich.py`
- `services/pipeline/src/workers/qualify.py`
- Relevant dashboard and pipeline tests for those files.
- GitHub Issue #24: <https://github.com/KhanSayeem/PrinterIQ/issues/24>
- Issue #100 report: <https://github.com/KhanSayeem/PrinterIQ/issues/100#issuecomment-5112626462>

## Suggested skills

- `diagnosing-bugs` for the queue payload root cause and regression surface.
- `codebase-design` for keeping the queue payload interface explicit and consistent across modules.
- `github:yeet` when the verified change is ready to commit, push, and publish.
- `github:gh-fix-ci` only if GitHub Actions fail.

## Verification

At minimum run:

```powershell
python -m pytest services/pipeline/tests/test_ingest.py services/pipeline/tests/test_enrich.py services/pipeline/tests/test_qualify.py services/pipeline/tests/test_orchestrator.py -q
python -m ruff check services/pipeline
python -m mypy services/pipeline/src
```

If dashboard code changes, use the pnpm setup from `docs/operator-runbook.md`, then run its focused tests, typecheck, lint, and build.

Also run the broader pipeline test suite before publishing because queue payloads are shared behavior. Confirm `git diff --check` and inspect the complete diff before committing.

After deployment, perform only non-mutating health checks:

- GitHub deployment workflow succeeded at the expected commit.
- PM2 shows dashboard, pipeline, and reply-agent online.
- Dashboard `/login` returns HTTP 200.
- No jobs were unexpectedly queued or replayed by deployment.

Do not treat deployment health as Issue #24 acceptance. Issue #24 closes only after the separately authorized controlled Instantly smoke satisfies every acceptance criterion.

## Completion report

Report:

- the exact payload contract chosen,
- files changed,
- focused and broad verification results,
- PR, merge commits, deployment run, and live health evidence,
- confirmation that no provider calls, spend, job replay, preview generation, promotion, or outreach occurred,
- the remaining operator input for Issue #24.

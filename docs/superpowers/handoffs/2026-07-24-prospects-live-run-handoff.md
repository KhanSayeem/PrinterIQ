# PrinterIQ Prospects Live Run Handoff - 2026-07-24

## Context

Repository worktree: `C:\Users\Hi\.codex\worktrees\b82b\PrinterIQ`

Protected main checkout: `C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ`

Do not work in, clean, reset, stage, or switch the protected dirty main checkout. It was used read-only as the source for runtime `.env` values. Do not print secrets.

This handoff continues the live `/prospects` dashboard rollout after PR #86 promoted `dev` to `main`, hosted migration `0008` was applied, provider keys were copied to the VPS, and the user started a fresh live discovery run.

## Suggested Skills

- `supabase`: use for hosted DB/schema/runtime checks.
- `diagnose`: use if the live run stalls or the dashboard state disagrees with DB/Redis.
- `browser:control-in-app-browser`: use if live dashboard UI proof is needed.
- `handoff`: use again before ending a long continuation.

## What Changed

### Production branch and deploy

PR #86 was created and merged from `dev` to `main` to deploy `/prospects`.

Relevant deployed commits on `main`:

- `422c73bd79f4c5061f017f099032bf445c19ae58` - PR #86 squash deploy.
- `35451c0c58e35676ff5f5dc4b19e24c91e4421f7` - made production deploy idempotent.
- `f838427ac5114c06a93bceed645b94c42c7786ee` - moved pipeline install to repo root venv and PM2 to root venv.
- `961cbcb32f29300d3e44dff4b67d97e51f7f42e4` - installed build dependencies during deploy with `npm ci --include=dev`.
- `ff0cc600a4362840ce5c6452ba3bb2bfd1aa16d7` - widened prospects workbench cards.
- `efed6627e4465ad43a37bdaad8ae22d7696554cf` - changed deploy to reload PM2 from ecosystem with updated env.
- `c2b47e3eb693aad7555c632e03439df72bbed75f` - changed pipeline PM2 script to direct `src/workers/orchestrator.py`.
- `bd8a7e63a4232c55c03d614f525df69ddda5bcfd` - reset PM2 process definitions on deploy before starting ecosystem.

Latest production deploy run was green:

`https://github.com/KhanSayeem/PrinterIQ/actions/runs/30043915845`

### Dev branch alignment

Equivalent commits were applied to remote `dev` through GitHub API because local `git push` failed with a Windows Schannel credential error.

Latest relevant remote `dev` commits/checks:

- `9a17a68c1b939ccac44d203f1b6e922cc61d4d78` - harden production deploy script.
- `9d37d1edcba0a28f7b951a26734563ff9a5a4f8d` - widen prospects workbench cards.
- `c8e279c7b81954f4f630b71380f6943553c3ccf0` - reload PM2 from ecosystem on deploy.
- `caafc3ffb9ed09c67050cc1e18cd35f547f6b897` - run pipeline worker script under PM2.
- `778adadd82c7220285b3edd823ed67b63fef4aeb` - reset PM2 process definitions on deploy.

Latest `dev` CI was green:

`https://github.com/KhanSayeem/PrinterIQ/actions/runs/30043921832`

### Hosted database

Applied `database/migrations/0008_create_prospect_staging.sql` to hosted Postgres after user approval.

Verified created tables:

- `discovery_runs`
- `business_prospects`
- `prospect_assessments`
- `prospect_contacts`

There was no `supabase_migrations.schema_migrations` table in the hosted DB, so no migration history row was updated.

### VPS environment and PM2

The user clarified that `OUTSCRAPER_API_KEY` and `APOLLO_API_KEY` were present in the protected checkout `.env`.

Copied only these two provider keys from:

`C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ\.env`

to:

`/root/printeriq/.env`

on the VPS. Values were not printed. A VPS backup was created:

`/root/printeriq/.env.backup-20260723T210128Z`

PM2 was restarted from `ecosystem.config.js`.

Last verified PM2 state:

- `pipeline`: online, interpreter `/root/printeriq/.venv/bin/python`, script `src/workers/orchestrator.py`, no stale args, restarts 0, uptime about 9 minutes at check time.
- `dashboard`: online after ecosystem restart.
- `reply-agent`: online after ecosystem restart.

Last verified Redis state after the fresh run completed:

- `bull:pipeline:wait`: 0
- `bull:pipeline:active`: 0
- `bull:pipeline:delayed`: 0

## Live Run State

The first run the user started before the provider keys and PM2 fixes was:

`a15d022b-5f98-425c-8cb8-6018bf99f984`

It failed stale without submitting to Outscraper:

- `status`: `failed`
- `failure_code`: `discovery_run_stale_active`
- `submitted_at`: `null`
- no `source_request_id`

The user then started a fresh live run. Latest verified fresh run:

`7468dcbc-7813-4384-8f75-fd5d8f9a44cb`

State at handoff:

- `status`: `review_ready`
- `source_request_id`: present
- `failure_code`: `insufficient_sample`
- `failure_detail`: `Validation sample insufficient for passing gates: A=146, B=0, healthy_rejected=122`
- `discovered_count`: 280
- `usable_count`: 146
- `route_a_count`: 146
- `route_b_count`: 0
- `verified_contact_count`: 33
- `submitted_at`: `2026-07-23T21:06:33.684Z`
- `results_received_at`: `2026-07-23T21:08:10.428Z`
- `review_ready_at`: `2026-07-23T21:09:48.773Z`

Tracked jobs for the fresh run were completed:

- `start_discovery`: completed
- `poll_outscraper`: completed
- `normalize_prospects`: completed
- `assess_prospects`: completed
- `enrich_prospect_contacts`: completed
- `prepare_shadow_review`: completed

## Next Session Focus

Open the live `/prospects` dashboard and review the `review_ready` run.

Likely next analysis:

1. Confirm the dashboard matches the DB counts for run `7468dcbc-7813-4384-8f75-fd5d8f9a44cb`.
2. Explain why the gate failed: Route B sample is 0, despite 146 Route A and 122 healthy/rejected sample records.
3. Inspect sample records and evidence in the dashboard.
4. Decide whether Issue #78 expects a changed preset/query strategy, a manual review pass, or a new targeted run that can produce Route B records.
5. Keep Route A shadow-only. Do not promote prospects into leads, previews, outreach, or Instantly.

Use read-only checks first. Do not manually call Outscraper outside the worker path unless the user explicitly authorizes it.

## Important Boundaries

- Do not print API keys, database URLs, or secrets.
- Do not work in the protected main checkout.
- Do not run live provider requests manually.
- Do not activate lead creation, preview generation, outreach, or Instantly from Route A/shadow processing.
- The `/prospects` flow is shadow-mode only.

## Local Worktree Note

Local `git status -sb` before this handoff showed:

`## dev...origin/dev [ahead 1]`

and modified files:

- `.github/workflows/deploy.yml`
- `ecosystem.config.js`
- `services/dashboard/src/app/globals.css`

This is because changes were committed to remote `main` and `dev` through the GitHub API after local `git push` hit Schannel credential errors. Do not assume these are unshipped changes without comparing against remote commits above.

There is also a recurring warning:

`could not open directory 'services/pipeline/.pytest_cache/': Permission denied`

Ignore unless specifically cleaning local generated files.

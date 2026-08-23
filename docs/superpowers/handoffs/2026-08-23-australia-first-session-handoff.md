# PrinterIQ Handoff: Australia First, and the 900k Database Audit

Date: 2026-08-23
Previous handoff: `docs/superpowers/handoffs/2026-08-13-webhook-outage-and-derived-gate-handoff.md`

## Start Here

**Immediate task: drop `State` from the required-import fields on PR #138.**
Details in "Next Task" below. It is one line plus a preview-page change, and
it multiplies the reach of everything else in that PR by five.

Do not re-run the CSV analysis, the scale audit, or the enrichment. All of it
is recorded here and in the two plan documents. Re-running the enrichment
costs real money and hours.

- Protected checkout, do NOT work in it:
  `C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ`
  Uncommitted work that exists nowhere else. Use a worktree off `origin/dev`.
  Note `dev` is already checked out at `C:\Users\Hi\.codex\worktrees\b82b\PrinterIQ`,
  so `git checkout dev` fails. Branch from `origin/dev` instead.
- SSH works: `ssh -o BatchMode=yes root@170.64.143.200`
- Deploys are automatic on push to `main` via GitHub Actions.

## Verified Production State (2026-08-23)

| Item | Value |
| --- | --- |
| Deployed commit | `fd63b97` |
| PM2 | pipeline, reply-agent, dashboard all online, 0 unstable restarts |
| Leads | archived 2538, imported 31, contacted 4, qualified 1, enriched 1 |
| Enrichments | 2539 `playwright+apollo`, 20 `playwright`, **0 apollo** |
| Threshold | 35 in both env files (was 20 / 40, fixed) |
| Offer price | $1,499 via `OFFER_PRICE_AUD` |
| Supabase | **Pro plan, Micro compute**, ap-southeast-2 |
| Instantly | **Hyper Growth $97/mo: 25,000 contacts, 125,000 emails/month** |
| Main campaign | `e8ef5219-...` "PrinterIQ Dev Preview Smoke", **still the test rig** |
| No-website campaign | `16937ab1-ee11-43f6-857a-71e40ed4424c`, **draft, created this session** |

## Next Task: drop `State` from required import fields

PR #138 removed `Phone` and `Website` from `_missing_required_fields()` in
`services/pipeline/src/workers/ingest.py`. `State` was not in that brief, so
the agent correctly flagged it rather than changing it.

Measured on the real Australian slice, verified twice:

| required fields | imports | of which no-website |
| --- | --- | --- |
| as shipped (State + Industry) | 14,186 | **629** |
| drop State | 22,697 | **3,397** |
| drop State and Industry | 25,558 | 3,448 |

As shipped, the entire no-website effort reaches about 10% of its intended
population.

**Recommendation, already given to the operator: drop `State`, keep
`Industry`.** It follows the same principle applied to phone and website, and
`State` is unreliable data anyway: 497,556 records across the file have a
country name in that column ("germany" appears 105,355 times). Keeping
`Industry` costs only 2,861 more leads and it genuinely feeds the scorer.

**Prerequisite:** apply the `{{#IF_PHONE}}` conditional-block mechanism that
PR #138 already built to `{{CITY}}, {{STATE}}` on the preview templates. Most
rows missing a state are missing a city too, so without it the demo page shows
a stray comma or an empty location line.

TDD is mandatory here (ingest dedup is on the CLAUDE.md list). After the
change, re-run:

```
python -m pytest services/pipeline/tests -q
python -m ruff check services/pipeline
python -m mypy --config-file services/pipeline/pyproject.toml services/pipeline/src
```

## Open PRs, all CI-green and mergeable

| PR | What | Notes |
| --- | --- | --- |
| #136 | reply-agent consumes the `replies` queue | Reviewed. Migration 0012 is dormant but mandatory before the checkout branch is lifted. |
| #137 | Australia-first plan documents | Docs only. |
| #138 | any-business and no-website leads | The `State` change belongs here. |

**#136 review notes worth carrying:** the `send_checkout` override lives in the
worker, not the handler, deliberately. Retries can page the operator more than
once, because `escalate()` sends the SMS then pauses Instantly and a pause
failure throws after the SMS is out. That was a considered trade, not an
oversight. The SQL in migration 0012 has never executed against Postgres.

## Open issues

- **#123** nothing consumed the `replies` queue. PR #136 fixes it. Agreed
  direction is on the issue: human-in-the-loop first, Instantly not Resend for
  delivery, add a checkout idempotency guard.
- **#124** price drift. Charge half fixed; open part is whether to move
  product and price into Stripe.
- **#120** batching. **The advice on this issue was corrected twice.** Do not
  build batching for 28,270 records. Do build it before any large or
  international run. Numbers are in the comment.
- **#127** threshold disagreement. Fixed in production (both files now 35) but
  the issue is still open for the durable fix.

## What was found and fixed this session

All deployed and verified live.

| PR | Defect |
| --- | --- |
| #119 | Weakness gate was model-judged. Also `asyncpg` returns `jsonb` as `str`, so the derived gate would have archived **every** lead while all 371 tests passed. |
| #122 | Every Instantly webhook rejected since June. Replies, bounces and **unsubscribes** all silently dropped. Instantly cannot send custom headers; the routes demanded one. |
| #125 | Checkout charged $1,500 while emails quoted $1,499, on live Stripe keys. |
| #132 | `weakness_label` enum dead-lettered clean sites. Haiku uses several spellings for "nothing". Enum removed; grounding is stronger anyway. |
| #134 | Dead domains and bad certificates crashed the auditor instead of recording an unreachable site. About 1 in 7 leads. |

Also this session, not in a PR:

- **Re-enriched all 2,559 leads** for **$3.67**. The old data was fabricated:
  it claimed 2,521 businesses had no SSL certificate. The true count is
  **zero**. Do not re-run this.
- Sender sign-off now uses `{{sendingAccountFirstName}}` across 20 mailboxes
  instead of a hardcoded "Murphy". Follow-ups, previously unsigned, now sign.
- Follow-up timing corrected from 1 day / 1 day to day 3 / day 6.
- Instantly campaign pool set to the 8 active Prescia mailboxes.
- Account names normalised: `Maca` to `Macauley Burke`, `Alexander` to
  `Alex Cutajar`.
- Stripe migrated to the new account. Keys are in `/root/printeriq/.env` only.
- Neutral business preview template given 8 distinct images. The originals
  were 4 photos across 8 slots, with hero and two projects identical.

## The database: what it actually is

Full analysis in `docs/superpowers/plans/2026-08-23-australia-first-two-phase-plan.md`.
The four facts that matter:

1. **Australia is 3.1%** of the 909,812 records. Germany is 21.1%. About
   704,000 records come from OpenStreetMap. It is a map dump with emails
   attached, not a purchased B2B list.
2. **Only 2.1% have a first name** file-wide, but **51.3% of the Australian
   slice does**, because those came from Apollo and the CRM.
3. **No consent column exists** anywhere in the 70-column schema. ~403,000 EU
   records. That is a GDPR question needing legal advice, not engineering.
4. **The CSV headers use underscores** (`Company_Name`), not spaces. PR #138
   adds an alias map so both work.

Australian slice: 28,270 records, 90.4% with email, 45.8% with phone, 21.3%
(6,011) with no website at all. Top industries are Finance and Accounting
7,480, Construction 3,837, Legal 1,871. **Construction is only 13.6%**, so the
trades assumption had to go even for Australia.

### Corrections to earlier claims

- I reported the `Industry` column contained the literal string `"None"` 4,212
  times. **It does not.** Literal `'None'` appears 0 times; those rows are
  genuinely empty. A duckdb NULL rendered as `None` through a Python `str()`.
- The older handoff said the `/leads` page loads everything and wedges the
  browser. **That is stale.** It paginates server-side at 25 per page. What
  will actually break it at scale is the un-debounced search box firing three
  full table scans per keystroke.

## Hard boundaries, unchanged

- No Outscraper runs, no Apollo credit spend.
- Do not promote prospects, generate previews for live prospects, or schedule
  live outreach without explicit approval.
- Do not activate a campaign, or mutate Instantly settings, without approval.
- No destructive DB, Redis, storage or provider cleanup without an exact
  approved target list.
- **`INSTANTLY_CAMPAIGN_ID` still points at the test campaign**, which is
  Active with an always-open send window. Nothing should run against real
  leads until it is repointed.

## What needs the operator

1. Repoint `INSTANTLY_CAMPAIGN_ID` away from the test rig.
2. Set `INSTANTLY_NO_WEBSITE_CAMPAIGN_ID=16937ab1-ee11-43f6-857a-71e40ed4424c`
   once PR #138 merges. Until then no-website leads fall back to the campaign
   whose opener says "spotted your site", logged as a warning each time.
3. Edit the Instantly greeting to `{{firstName|there}}`. Instantly supports
   pipe fallbacks; verified. Covers the 48.7% with no first name.
4. Team review of the draft no-website campaign copy. It stays in draft until
   they weigh in.
5. **Recalibrate the threshold before any send.** PR #138 introduces
   `qualify-v2`, which invalidates the calibration behind 35. Run
   `workers/shadow_qualify.py`, which scores a sample with Haiku only and
   sends nothing.

## Lessons that keep proving true

**Green tests prove the code does what the test author assumed.** The jsonb
bug had 371 passing tests over it, all injecting the wrong type. A PR this
session shipped a test that passed on Windows and failed on Linux CI.

**Silence is not health.** Several defects presented as "nothing in the logs".
Clean logs meant the code never ran. Prove a path executes before calling it
healthy.

**Check the provider's actual capability.** #104 mandated a header Instantly
cannot send. Instantly also rejects `Australia/Sydney` as a timezone, and its
webhook object has no custom-header field. One API call settles these.

**Verify subagent output, do not relay it.** Every implementation agent this
session produced good work *and* something that needed correcting: a
Windows-only test, unverified image URLs where one 404'd, a `State` field
nobody had scoped.

**Windows to Linux line endings.** Python's default `write_text` produces CRLF
on this machine, and every line of a shell script then fails on the VPS. Use
`newline="\n"`.

## Useful commands

```bash
# analyse the CSV without loading it (duckdb is installed in the scratchpad venv)
python -c "import duckdb; ..."   # see the plan doc for query patterns

# production health
ssh -o BatchMode=yes root@170.64.143.200 "cd /root/printeriq && git rev-parse --short HEAD && pm2 status"

# apply an env change (a plain pm2 restart does NOT re-read .env)
ssh root@170.64.143.200 "cd /root/printeriq && pm2 restart ecosystem.config.js --only <app> --update-env"

# check the Instantly webhooks are alive
# see docs/operator-runbook.md, "Check the Instantly webhooks are alive"
```

# PrinterIQ Handoff: Derived Weakness Gate, Webhook Outage, Price Mismatch

Date: 2026-08-13
Previous handoff: `docs/superpowers/handoffs/2026-08-13-grounded-weakness-gate-handoff.md`

## Start Here

The task this session started with was small: make `has_actionable_weakness`
code-derived. It was done in the first hour. Everything after it came from
verifying rather than trusting, and three of the four findings were defects
already live in production.

Read "What Was Actually Wrong" before planning anything. The theme is that
every one of these failed **silently**, and the system looked healthy in each
case.

- Protected checkout, do NOT work in it:
  `C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ`
  It sits on `feat/issue-33-import-csv` with uncommitted work that exists
  nowhere else. Use a worktree off `origin/dev`.
- SSH works: `ssh -o BatchMode=yes root@170.64.143.200`
- Deploys are automatic on push to `main` via GitHub Actions.

## Verified Production State (2026-08-13)

| Item | Value |
| --- | --- |
| Deployed commit | `7535817` |
| PM2 | `pipeline`, `dashboard`, `reply-agent` online, 0 restarts |
| Lead statuses | enriched 2531, imported 31, archived 8, contacted 4, qualified 1 |
| Instantly campaign | `e8ef5219-…` "PrinterIQ Dev Preview Smoke", **Active** |
| Campaign sequence | day 0 / day 3 / day 6 (was 1/1, fixed this session) |
| Send window | "On any day, any time", schedule *named* "Office hours" |
| Sending account | `murphy@presciastudio.com`, 30/day |
| Offer price | $1,499 everywhere, via `OFFER_PRICE_AUD` |
| Threshold | dashboard `.env.production` 40; pipeline `.env` **20** (see #127) |

Numbers were re-derived from the database, not carried over from the previous
handoff. Several of that handoff's figures had drifted.

## What Was Actually Wrong

### 1. asyncpg returns jsonb as `str`, so the new gate would have archived everything

Caught in code review, not by tests. `enrichments.weaknesses` is `jsonb`, and
asyncpg returns json/jsonb as a raw string unless a codec is registered. None
was: the pool is created bare in `workers/orchestrator.py`.

Verified against production: `SELECT weaknesses …` returned the **string**
`'["no_ssl"]'`. So `isinstance(_, list)` was False, `grounded_weaknesses`
became `[]`, and `bool([])` is False. The derived gate would have evaluated
`False` for every lead while the whole suite stayed green, because every test
injects a real Python list through a fake fetcher.

This also means the `weakness_label` grounding check from PR #115 **never
worked in production**: `weakness_label not in []` is always true. It went
unnoticed because every lead archived on the gate before reaching it, which is
why the pipeline logs contain no grounding warnings and no dead-letters.

Fixed by decoding at the read (`get_enrichment_by_lead_id`), not pool-wide.
`set_type_codec` registers an encoder too, and every jsonb write already passes
a `json.dumps()` string into a `$n::jsonb` parameter, so a pool-level codec
would double-encode and corrupt enrichment and prospect writes.

### 2. Every Instantly webhook had been rejected for two months

PR #104 hardened the webhook routes to header-only auth and made
`/instantly/<event>/:webhookId` return 400 unconditionally.

**Instantly cannot send custom headers.** Its webhook object exposes only
`target_hook_url`, `name`, `event_type`, `status`. All three webhooks are
registered against the path form, and each URL's trailing id is exactly the
matching `INSTANTLY_WEBHOOK_ID_*` value. Path auth was the original design,
which is what the variable naming always implied.

Consequences, all silent:

- replies never recorded (a real positive reply arrived while the dashboard
  showed `Replied 0`)
- bounces never recorded (a lead on a domain with no MX/A/NS shows
  `bounced = false`)
- **unsubscribes never recorded**, so suppression requests were not honoured

Fixed in #122: accept the secret from header or path, timing-safe compare.
Rejections now log at warn. The absence of that log is *why* this survived:
Fastify runs `logger: false` and nginx sets `access_log off` on
`/instantly/`, so a 400 storm produced no signal anywhere.

### 3. Checkout charged $1,500 while the emails quoted $1,499

`STRIPE_MODE=live`. Latent only because no checkout link can be delivered at
all (#123). The price lived in four places that drifted; it now comes from one
`OFFER_PRICE_AUD` value (#125). The Instantly templates remain manual.

### 4. 2530 enrichment rows contain fabricated data

Every `tech_source = 'apollo'` row has `load_ms` and `has_h1` NULL, and 2521
are flagged `has_ssl = FALSE` while their `website_url` starts with
`https://`. Confirmed from the other direction: nine real trades businesses
freshly audited all measured `has_ssl = true`.

These rows pass the gate *and* the grounding check, because `no_ssl` genuinely
is in the stored array. The array is simply wrong. Copy would tell businesses
with valid certificates that they have none. The pool must be re-enriched
before use.

## Shipped

- **#119**: `has_actionable_weakness` derived from the enrichment weaknesses
  array; prompt paragraph removed; jsonb decode at the query boundary.
- **#122**: Instantly webhook path-secret auth, plus rejection logging.
  Security-reviewed adversarially.
- **#125**: `OFFER_PRICE_AUD` as the single source for checkout and both
  prompts.
- **#121, #126**: promotions to `main`.
- Instantly follow-up timing corrected from 1 day / 1 day to day 3 / day 6.
- Runbook: webhook liveness checks, price-change procedure, enrichment data
  quality.

## Open Issues

- **#123**: nothing consumes the `send_reply` queue; no reply or checkout
  link is ever sent. Agreed direction is on the issue: human-in-the-loop
  first, Instantly (not Resend) for delivery later, and add a checkout
  idempotency guard.
- **#124**: price drift; the charge half is fixed, the open part is whether
  to move product/price into Stripe.
- **#120**: costed with real data. Recommendation is **do not build
  batching**: re-enriching all 2531 costs about $5 and takes 1 to 1.5 hours.
  See the comment.
- **#127**: threshold is 20 in the pipeline env and 40 in the dashboard env,
  and duplicated.

## The Deliverability Test

Nine real trades businesses were imported with operator-controlled test
mailboxes as recipients, so real copy and real previews were exercised without
contacting any real owner.

Result: **7 of 9 archived** because their sites are genuinely fine (valid SSL,
H1 present, sub-5s load). Two qualified and were emailed:

- `slow_load` 7664ms → "your site takes over 7 seconds to load, meaning most
  visitors leave before it even finishes and never get to call you"
- `no_h1` → "your site has no main heading, so Google struggles to understand
  what you do"

One reply came back. **Inbox-versus-spam placement was never established**:
only two emails sent, and no Microsoft data point, because the mailbox
assigned to a Microsoft address drew a business whose site was clean. If
placement matters, pre-screen candidate sites for a missing H1 or slow load so
each target mailbox is guaranteed a send.

A 22% qualify rate on real audits (n=9) also means the addressable pool is far
smaller than the import: ~278 of 2531, or about 9 days of sending at 30/day.

## Lessons Worth Keeping

**Green tests prove the code does what the test author assumed.** The jsonb bug
had 371 passing tests over it. The tests all injected the wrong type.

**Silence is not health.** Three of the four defects presented as "nothing in
the logs". Clean logs meant the code never ran, not that it ran fine. When a
log is empty, prove the path executes before concluding it is healthy.

**Check the provider's actual capability before designing auth around it.**
#104 mandated a header the provider cannot send. One API call would have
caught it.

**Ask what the user is really testing.** The original request was to email nine
test mailboxes. Those mailboxes' own businesses were not representative; using
real businesses with redirected delivery tested the actual pipeline.

## Hard Boundaries

Unchanged from the previous handoff, and still in force.

- No Outscraper runs, no Apollo credit spend.
- Do not promote prospects, generate previews for live prospects, or schedule
  live outreach.
- Do not activate campaigns or mutate Instantly without explicit approval.
- No destructive DB, Redis, storage or provider cleanup without an exact
  approved target list.
- **`INSTANTLY_CAMPAIGN_ID` still points at the test campaign**, which is
  Active with an always-open window. Any lead reaching `schedule_outreach`
  lands there. The durable fix is a separate production campaign with the env
  var repointed.
- The send window is named "Office hours" but set to "any day, any time".
  Revert before real outreach.

## Immediate Next Task

Re-enrich the 2531 `tech_source = 'apollo'` leads so their weakness data is
real. It is ~$5 and ~1, 1.5 hours, needs no batching infrastructure, and every
downstream decision depends on it. Nothing should be emailed from that pool
until it is done.

Confirm the operator wants it before starting: it re-audits 2531 live websites
and spends Anthropic budget, both of which are provider-touching.

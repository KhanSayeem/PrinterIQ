# Australia First: Two-Phase Plan for the 909,812-Record Database

Date: 2026-08-23
Shareable version: published as an Artifact for the team
Companion plan: `2026-08-23-any-business-and-no-website-leads.md`

## Purpose of this document

This records every finding, fix, and recommendation produced while auditing the
new 909,812-record master file, so the analysis never has to be run again.

Phase 1 is what we do now. Phase 2 is the recorded audit we will need if and
when we go international.

## The decision

Run production on the 28,270 Australian records first. Prove the machine earns
money. Use those findings to decide whether to go international, and treat that
as a separate business decision with its own budget.

## What the file actually is

Every published headline number was verified directly and was accurate. What
nobody had checked was geography.

| Country | Records | Share |
| --- | --- | --- |
| Germany | 191,750 | 21.1% |
| United States | 84,559 | 9.3% |
| France | 53,419 | 5.9% |
| Netherlands | 49,173 | 5.4% |
| Poland | 38,355 | 4.2% |
| Austria | 35,876 | 3.9% |
| Spain | 34,555 | 3.8% |
| United Kingdom | 33,482 | 3.7% |
| **Australia** | **28,270** | **3.1%** |

Roughly 704,000 records originate from OpenStreetMap, a public map database.
About 16,000 came from Apollo and about 7,000 from a CRM export. It is a map
dump with emails attached, not a purchased B2B list.

Consequences:

- The offer is priced at $1,499 AUD. Most of the file cannot be billed that way.
- Copy is English in a casual Australian voice. About 80% of the file is in a
  country where English is not the first language.
- Only 2.1% of records carry a first name (19,010 of 909,812). `{{firstName}}`
  renders empty for 890,802 of them. `Company_Name` is 100% filled.
- The 70-column schema contains **no consent, opt-in, or prior-contact column**.
  Around 403,000 records are in EU countries. That is a GDPR question requiring
  legal advice, not an engineering decision.

## Why Australia is the right first move

| Measure | Australia | Whole file |
| --- | --- | --- |
| Records | 28,270 | 909,812 |
| Has a first name | 51.3% | 2.1% |
| Has an email | 90.4% | 99.7% |
| Has a phone | 45.8% | not measured globally |
| No website at all | 6,011 (21.3%) | 165,664 |

The Australian records carry first names because they came from Apollo and the
CRM rather than the map dump.

Australia removes: translation, second currency, GDPR exposure, the large-file
import problem, batching infrastructure, and database scaling work.

Top Australian industries: Finance and Accounting 7,480, Construction 3,837,
Legal Services 1,871, Retail 1,375, Hospitality and Food 1,369. Construction is
13.6%, so the trades-only assumption still has to go even for Australia.

## Phase 1: Australia (28,270 records, 22,697 importable)

Correctness work only. No scale work needed.

| Status | Item | Why |
| --- | --- | --- |
| Blocker | Column names do not match | File uses `Company_Name`; importer expects `Company Name`. Every row rejects. |
| Blocker | Phone is a required field | Only 45.8% of AU records have one. Rejects 15,327 of 28,270. |
| Blocker | Blank website rejects the row | `ingest.py` `_missing_required_fields()` lists `Website`. The 6,011 best prospects never enter the database. |
| Fix | Scorer rejects non-trades | `prompts/qualify-v1.txt` scores down "not a tradie business". Most of the AU list is finance, legal, retail, hospitality. |
| Fix | Demo website is a trades template | `templates/previews/general.html` says "Fully Licensed", "Free Quotes". An accountant receives a tradesman's site as their demo. |
| Fix | No pitch for no-website businesses | All copy says "I had a look at your site". Nonsense for 6,011 leads. |
| Fix | Greeting breaks without a first name | Works for 51%. The rest need company name fallback. |
| Fix | Campaign points at the test rig | `INSTANTLY_CAMPAIGN_ID` still targets "PrinterIQ Dev Preview Smoke", Active with an always-open send window. |
| Fix | Category delimiter bug | Classifier reads `amenity=cafe` but not `amenity:cafe`. Fixing recovers 151,203 records from "Other", including 9,816 tagged plumber, electrician, carpenter, roofer, tiler. |

## Phase 2: International (881,542 records)

Not needed for Australia. All needed before a large or overseas launch.

| Status | Item | Detail |
| --- | --- | --- |
| Blocker | GDPR legal advice | ~403,000 EU records, no consent record in the file. |
| Blocker | File cannot be uploaded | Limit is 50MB (`NEXT_PUBLIC_DASHBOARD_MAX_CSV_UPLOAD_MB`, `DASHBOARD_MAX_CSV_UPLOAD_BYTES`, nginx `client_max_body_size 75m`). File is 868MB. Raising limits does not help: `route.ts:198` buffers the whole file; 3.8GB RAM, no swap, OOM. Needs a CLI import path. `parse_ingest_args` exists at `ingest.py:39` but has no `main`. |
| Blocker | Dedup does a sequential scan | Verified with EXPLAIN ANALYZE on production. `lower(email)` cannot use the plain btree on `email`. ~5.7 days of duplicate checking alone. Fix: `CREATE INDEX CONCURRENTLY idx_leads_tenant_lower_email ON leads (tenant_id, lower(email)) WHERE is_deleted = false;` |
| Blocker | One repeated Apollo ID kills the import | Verified: `leads_apollo_contact_id_key UNIQUE (apollo_contact_id)` is global, not tenant-scoped. |
| Blocker | Import cannot resume | A failure at row 800,000 restarts from row 0. Three attempts, then dead. No checkpoint. |
| Fix | Translation and local pricing | Copy, offer, currency and reply agent all assume English and AUD. |
| Fix | Leads page fails at scale | No debounce on search; each keystroke triggers three full table scans. `getLeadFilterCounts` ignores filters and always aggregates the whole tenant. Degrades around 100,000 to 200,000 records. Needs indexes on `(tenant_id, updated_at DESC)`, `pg_trgm` for search, and a debounce. |
| Fix | Batching to sending capacity | See below. |
| Fix | Throughput limits hard-coded | `PIPELINE_CONCURRENCY = 5` and `CLAUDE_RATE_LIMIT_PER_MINUTE = 50` in `orchestrator.py:58-60` must become env vars. Playwright at concurrency 5 is the bottleneck, not Claude. |
| Later | Database housekeeping | `queue_jobs` never pruned, would reach 1.8M rows. PM2 log rotation not installed. Uploaded CSVs never deleted on success. |
| Later | Entity duplicates | Zero duplicate emails, but 49,086 records sit on shared government, education and franchise domains representing a few hundred organisations. |
| Later | ~8% is not a commercial prospect | 77,884 schools, kindergartens, places of worship, town halls, libraries, fire stations. |

### Verified as fine

- Redis will not silently drop jobs. `maxmemory 0`, `maxmemory-policy noeviction`.
  900k queued jobs is ~130-160MB against 3.0GB available.
- Zero duplicate emails (906,808 emails, 906,808 distinct) and zero duplicate rows.
- Only 1.25% of website URLs are junk (builder subdomains, social profiles, malformed).
- The leads page does paginate server-side. The older handoff claim that it loads
  everything is stale and no longer true.

### Verified after the audit

**Supabase: Pro plan, Micro compute, ap-southeast-2.** Storage is not the
problem: Pro includes 8GB and the full file needs ~4GB. Memory is. Micro gives
`shared_buffers` 256MB and `effective_cache_size` 768MB, measured on the live
database. Australia at ~90MB sits entirely in cache. The full file at ~4GB is
five times the cache, so nearly every query would read from disk. Phase 2 needs
a bigger compute size, not a bigger plan.

**Instantly: Hyper Growth, $97/month. 25,000 total contacts, 125,000 emails per
month.** See the sending ladder below.

### Could not verify

- Email deliverability. No network calls were made against the list.

## The sending ladder

Four limits stack. Only the tightest one matters, and it is not the one people
assume.

| Limit | Per day | Per month | Source |
| --- | --- | --- | --- |
| **Campaign daily_limit (current)** | **30** | ~900 | Instantly campaign setting |
| 8 active Prescia mailboxes | 155 | ~4,650 | Sum of per-account daily limits |
| Instantly plan | ~4,100 | 125,000 | Hyper Growth |
| Instantly contact ceiling | n/a | 25,000 total | Hyper Growth |

**The Instantly plan is not the constraint.** It is roughly 27 times larger than
the mailboxes can use. Upgrading the plan changes nothing. Only more domains and
mailboxes increase sending.

The binding limit today is the campaign setting of 30 per day, left low so the
eight mailboxes ramp gently. Raising it once they have sent cleanly for a week or
two is the single biggest lever on how fast Australia pays back.

### What this means per phase

**Australia.** 28,270 Australian records exist in the file, but **22,697 are
what actually import.** The other 5,573 fail the required-field check: 2,712
carry no email address, 4,212 carry no industry, and 1,351 are missing both.
A row with no email cannot be contacted at all, and industry is what the
scorer reasons over.

Of those 22,697 we push only qualified leads into Instantly, roughly 3,200 to
5,700 depending on where the threshold lands. That is well inside the 25,000
contact ceiling. At 30 per day it is about 4 to 6 months of sending; at 155 per
day about 21 to 37 days.

**International.** The 25,000 contact ceiling is a wall. The full file would
produce roughly 130,000 email-ready leads. The next plan up, Light Speed at $358
per month, allows 100,000 contacts and is still short. It also would not help,
because mailboxes are the bottleneck, not the plan. An international launch needs
a materially larger sending estate: many more domains and mailboxes, with the
warm-up time and cost that implies. That belongs in the Phase 2 budget.

## Batching to sending capacity

Eight active Prescia mailboxes send about 150 emails per day combined. That
number, not the lead count, sets the pace of the business.

Processing all 909,812 records yields roughly 130,000 email-ready leads. At 150
per day that is 2.4 years of sending.

| | Batch monthly | All at once |
| --- | --- | --- |
| Records processed per month | ~31,500 | 909,812 once |
| Emails sent per month | ~4,500 | ~4,500 |
| Cost per month | ~$71 | $2,060 up front |
| Processing time | ~23 hours | ~27 days |
| Data age when emailed | days | up to 2.4 years |

The same number of emails go out either way. Batching costs about 96% less per
month and keeps the audit data fresh. A website audited 18 months before the
email is sent may name a fault the business has since fixed.

This supersedes the earlier advice on issue #120, which recommended against
batching. That was correct for 2,559 leads at $5 and 1.5 hours. It does not hold
at 909,812.

## Cost to run

The website audit is free. Playwright opens the page and measures it; no model
runs. Cost comes from scoring every lead (Haiku) and writing copy for those that
pass (Sonnet). Both figures below are measured from a real run of 2,559 leads.

Per-lead measured cost: $0.001272 Haiku only, $0.008220 Haiku plus Sonnet.

| Scope | Score every lead | Write emails | Total | Time |
| --- | --- | --- | --- | --- |
| Australia (22,697 importable) | $29 | $22 to $39 | $51 to $68 | ~17 hours |
| Whole file (909,812) | $1,306 | $1,350 to $5,700 | $2,650 to $7,000 | 22 to 27 days |

The Australian row costs less than an earlier draft of this table showed. That
draft costed 28,270 records, which is the number of Australian rows in the
file rather than the number that clear the importer. Paying to score 5,573
rows that never enter the database was never going to happen.

A cost risk was raised about 2,530 dead qualification jobs potentially tripling
the bill. This was checked and dismissed: all 2,530 are dated 2026-06-12 and are
historical. Only 17 failures occurred in the last 7 days, all from re-enrichment
pilots that are now fixed.

### On cheaper models

The audit uses no AI model and is already free, so there is nothing to save
there. A cheaper model could do the scoring pass, but under batching that pass
costs about $71 per month. The saving does not justify the reliability risk:
the scorer must return strict JSON and pass a grounding check, and we spent time
this week fixing dead-lettered leads caused by Haiku returning three different
words for "nothing". Self-hosting is not viable on a droplet with no GPU, where
throughput is already the bottleneck. Do not downgrade the copywriting model,
which produces customer-facing text. Revisit if volume grows tenfold.

## Defects found and fixed in production this session

| Issue | What was wrong |
| --- | --- |
| #119 | Weakness gate was model-judged; also `asyncpg` returns `jsonb` as `str`, so the derived gate would have archived every lead while all tests passed. |
| #122 | Every Instantly webhook rejected since June. Replies, bounces and unsubscribes all silently dropped. Instantly cannot send custom headers; the routes demanded one. |
| #125 | Checkout charged $1,500 while emails quoted $1,499, on live Stripe keys. Price now derives from one `OFFER_PRICE_AUD` value. |
| #132 | `weakness_label` enum dead-lettered clean sites; Haiku uses several spellings for "nothing". |
| #134 | Dead domains and bad certificates crashed the auditor instead of recording an unreachable site. About 1 in 7 leads. |
| #136 | Nothing consumed the replies queue, so classification, escalation and suppression were all dead code. |

Also corrected: 2,530 of 2,559 enrichment records held fabricated data claiming
2,521 businesses had no SSL certificate. Re-audited: the true count is zero. All
2,559 re-enriched for $3.67. Sender sign-off now matches the sending mailbox
across 20 accounts instead of always saying "Murphy". Follow-up emails, which
were unsigned, now carry a signature. Follow-up timing corrected from 1 day and
1 day to day 3 and day 6.

## Decisions needed from the team

1. Agree the Australia-first sequence.
2. Decide who takes legal advice on GDPR before Phase 2 is planned.
3. Decide when to raise the campaign daily limit from 30. This controls how fast
   Australia pays back, and is worth revisiting after a week of clean sending.
4. Note for Phase 2 planning: the sending estate, not the Instantly plan, is the
   cost line. Budget for domains, mailboxes and warm-up time.

Both open checks from the first draft are now answered: Supabase is Pro with
Micro compute, and Instantly is Hyper Growth with a 25,000 contact ceiling.

## What the Australian run should prove

Three things currently guessed at: how many leads actually pass the quality bar,
whether email reaches the inbox or the spam folder, and what a reply is worth.
All three are needed before committing thousands to an international launch.

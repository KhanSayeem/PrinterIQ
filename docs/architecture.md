# PrinterIQ Architecture

> Summarised from PRD Section 3. Authoritative source: `PrinterIQ_PRD_v1.0.md`.

## Three services, one VPS

All services run on a single DigitalOcean VPS (Sydney, 4GB/2vCPU) managed by PM2.
They share a Supabase Postgres database (AP Sydney) and a local Redis instance for BullMQ queues.

```
VPS (170.64.143.200)
├── services/pipeline/        Python 3.12 workers — PM2 process "pipeline"
├── services/reply-agent/     Node.js/TypeScript — PM2 process "reply-agent" on :3001
├── services/dashboard/       Next.js — PM2 process "dashboard" on :3000
├── Redis                     BullMQ queues
└── Nginx                     Reverse proxy + SSL (Let's Encrypt)

Supabase (AP Sydney)
└── Postgres — single source of truth for all data

Third-party APIs
├── Outscraper  — bounded Google Maps discovery for staged shadow prospects
├── Apollo      — verified business-email resolution for staged prospects
├── Instantly   — cold email sending, inbox rotation, reply webhooks
├── ClickSend   — SMS (AU sender IDs)
├── Anthropic   — Claude Haiku (bulk scoring) + Claude Sonnet (personalisation + replies)
├── Stripe      — hosted checkout, payment webhooks
└── Resend      — transactional email (welcome emails, operator alerts)
```

## Nginx routing

| Host                            | Destination              |
|---------------------------------|--------------------------|
| `dashboard.presciaiq.com`       | Next.js on port 3000     |
| `webhooks.presciaiq.com/instantly/reply` | Reply agent on port 3001; requires `X-Instantly-Secret` |
| `webhooks.presciaiq.com/instantly/bounced` | Reply agent on port 3001; requires `X-Instantly-Secret` |
| `webhooks.presciaiq.com/instantly/unsubbed` | Reply agent on port 3001; requires `X-Instantly-Secret` |
| `webhooks.presciaiq.com/sms`    | Reply agent on port 3001 |
| `webhooks.presciaiq.com/stripe` | Reply agent on port 3001 |

## Service boundaries — STRICT

These are invariants enforced in code and in code review. Violating them creates implicit coupling that breaks the ability to reason about each service independently.

| Rule | Why |
|---|---|
| Pipeline workers never call Instantly or ClickSend send APIs | Sending is the reply agent's concern; pipeline only adds leads to campaigns |
| Reply agent never modifies enrichment or qualification records | Those are write-once by the pipeline |
| Dashboard never writes directly to `outreach_sends` or `conversations` | All outreach goes through Instantly API; notes/overrides use defined insert patterns only |
| All Claude calls go through `claude_client.py` or `claude_agent.ts` | Centralised retry, cost logging, prompt versioning |

## Queue layout

| Queue name | Workers | Concurrency |
|---|---|---|
| `pipeline` | ingest, enrich, qualify, schedule_outreach | 5 max |
| `replies` | process_reply, send_reply, retry_checkout | 10 max |

Separate queues ensure the reply agent is never starved by enrichment batch jobs.

## Data flow

```
Apollo CSV
  → ingest.py        (leads table, status=imported)
  → enrich.py        (enrichments table, status=enriched)
  → qualify.py       (qualifications table, status=qualified|archived)
  → schedule_outreach.py (outreach_sends table, status=contacted)
  → Instantly sends email sequence

Outscraper shadow discovery (ADR 004)
  → discovery_runs / business_prospects (raw tenant-scoped snapshots)
  → deterministic Route A/B assessment
  → Apollo verified-business-email resolution
  → authenticated Prospects review area
  → STOP (no leads, previews, outreach sends, or Instantly requests)

Instantly reply webhook
  → webhook.ts       (URL-token auth, queues process_reply job)
  → handler.ts       (conversations table, Claude classification)
  → send_reply       (conversations table, Instantly send)
  → stripe.ts        (payments table on checkout.session.completed)

Instantly bounced/unsubscribed webhooks
  → webhook.ts       (URL-token auth)
  → db/queries.ts    (marks outreach_sends event flag, archives eligible lead)
```

The shadow flow is isolated from the production lead pipeline. Provider results are persisted before transformation, and replay uses the tenant, run, source, and provider business identity. No staged prospect may enter the lead status state machine without a later architectural decision and compliance review.

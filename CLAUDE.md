# PrinterIQ — Global Agent Rules

Read this before writing any code. These rules apply to all three services.

## What this system is

PrinterIQ is an automated sales pipeline for Australian tradies websites. It is NOT a web app. There is no public UI. Three services share one Postgres DB:

- `services/pipeline/` — Python 3.12 workers (ingest → enrich → qualify → outreach)
- `services/reply-agent/` — Node.js/TypeScript Fastify webhook + Claude reply handler + Stripe + ClickSend
- `services/dashboard/` — Next.js App Router operator UI (port 3000, Macauley only)

Shared: Supabase Postgres (AP Sydney), Redis/BullMQ queues, PM2 on a single DigitalOcean VPS.

## Authoritative source

`PrinterIQ_PRD_v1.0.md` is the source of truth for every architectural decision. Read it before implementing any module. Do not invent alternatives.

## Service boundaries — NEVER violate

- Python pipeline workers **never** call Instantly or ClickSend send APIs directly
- Reply agent **never** modifies enrichment or qualification records
- Dashboard **never** writes directly to `outreach_sends` or `conversations` (except note/override patterns)
- All Claude API calls go through service-specific wrappers: `claude_client.py` (Python) or `claude_agent.ts` (Node.js) — **never inline**

## Lead status state machine — enforced in code

```
imported → enriched → qualified → contacted → replied → paid
                           ↓
                        archived  (score < threshold OR unsubscribe)
```

Status only advances forward. Never skip stages. Never go backward.

## Database rules

- Every DB write **must** include `tenant_id`
- All reads **must** be scoped by `tenant_id`
- All DB access goes through `db/queries.py` (Python) or `db/queries.ts` (Node.js) — never scatter raw queries
- Invoke `.claude/agents/db-reviewer.md` after writing any query

## TDD — mandatory for these paths

- Ingest deduplication
- Qualifier logic (threshold gating, bad-JSON retry)
- Stripe webhook idempotency (`onboarding_triggered` guard)
- Reply intent classification and escalation triggers
- Suppression flow (unsubscribe → archived, no message sent)

## Security

- Stripe webhooks: always verify signature via `stripe.webhooks.constructEvent`
- Instantly webhooks: always verify `X-Instantly-Secret` header
- No PII in logs — mask emails: `u***@domain.com`
- All secrets in env vars — never in source code
- Invoke `.claude/agents/security-reviewer.md` after any auth/payment/webhook code

## Prompts

- All prompt text lives in `prompts/*.txt` — never inline in code
- Filename encodes version: `qualify-v1.txt` → `prompt_version = 'qualify-v1'`
- Log `prompt_version` to `qualifications.prompt_version` or `conversations.prompt_version` on every Claude call

## Git workflow

- Feature branches target `dev`, not `main`
- `main` only receives merges after a full sub-plan is verified end-to-end
- Use `.claude/commands/fix-issue.md` to work an issue from start to PR

# Instantly Webhook URL Token Implementation Plan

> **For agentic workers:** Use executing-plans or dispatching-parallel-agents to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unsupported `X-Instantly-Secret` webhook contract with URL-token routes and implement reply, bounced, and unsubscribed Instantly webhook handling.

**Architecture:** `services/reply-agent/src/webhook.ts` owns HTTP routing and URL-token validation. Reply events continue to enqueue `process_reply`; bounced and unsubscribed events call tenant-scoped DB query helpers in `services/reply-agent/src/db/queries.ts` and return only after the durable mutation succeeds.

**Tech Stack:** Fastify, TypeScript, Vitest, Postgres through `pg`.

---

### Task 1: URL-token route tests

**Files:**
- Modify: `services/reply-agent/tests/webhook.test.ts`

- [x] Replace header-secret tests with failing tests for `/instantly/reply/:webhookId`.
- [x] Add failing tests that wrong tokens return `400` before JSON parsing.
- [x] Add failing tests that `/instantly` returns `400`.
- [x] Add failing tests for `/instantly/bounced/:webhookId` and `/instantly/unsubbed/:webhookId`.
- [x] Run: `npm run test -- tests/webhook.test.ts`
- [x] Expected before implementation: route/config tests fail because the current server only supports `/instantly` plus `X-Instantly-Secret`.

### Task 2: Tenant-scoped bounced/unsubscribed DB tests

**Files:**
- Modify: `services/reply-agent/tests/db_queries.test.ts`

- [x] Add failing tests for `recordInstantlyBounce(tenantId, leadId, instantlyLeadId, client)`.
- [x] Add failing tests for `recordInstantlyUnsubscribe(tenantId, leadId, instantlyLeadId, client)`.
- [x] Assert each query scopes both `leads` and `outreach_sends` by `tenant_id`.
- [x] Assert each query archives only valid pre-payment lead states.
- [x] Run: `npm run test -- tests/db_queries.test.ts`
- [x] Expected before implementation: imports fail because the query helpers do not exist.

### Task 3: Implement DB helpers

**Files:**
- Modify: `services/reply-agent/src/db/queries.ts`

- [x] Add `recordInstantlyBounce`.
- [x] Add `recordInstantlyUnsubscribe`.
- [x] Each helper updates the matching `outreach_sends` row by `tenant_id`, `lead_id`, and `instantly_lead_id`.
- [x] Each helper archives the matching lead through the same tenant-scoped statement.
- [x] Export helpers from `queries`.
- [x] Run: `npm run test -- tests/db_queries.test.ts`
- [x] Expected after implementation: DB query tests pass.

### Task 4: Implement webhook contract

**Files:**
- Modify: `services/reply-agent/src/webhook.ts`
- Modify: `services/reply-agent/tests/stripe.test.ts`
- Modify: `.env.example`
- Modify: `.env.test.example`
- Modify: `docs/architecture.md`
- Modify: `nginx.conf`

- [x] Replace `instantlySecret` server option with `instantlyWebhookIds`.
- [x] Register `POST /instantly/reply/:webhookId` for `process_reply`.
- [x] Register `POST /instantly/bounced/:webhookId` for bounce mutation.
- [x] Register `POST /instantly/unsubbed/:webhookId` for unsubscribe mutation.
- [x] Keep `POST /instantly` rejected with clear `400`.
- [x] Make `main()` require `INSTANTLY_WEBHOOK_ID_REPLY`, `INSTANTLY_WEBHOOK_ID_BOUNCED`, and `INSTANTLY_WEBHOOK_ID_UNSUBBED`.
- [x] Update Stripe tests to pass the new server options.
- [x] Replace env examples and docs that mention `INSTANTLY_WEBHOOK_SECRET`.
- [x] Run: `npm run test -- tests/webhook.test.ts tests/stripe.test.ts`
- [x] Expected after implementation: route and Stripe webhook tests pass.

### Task 5: Review and verification gates

**Files:**
- Review changed files only.

- [x] Invoke `db-reviewer` for `services/reply-agent/src/db/queries.ts`.
- [x] Invoke `security-reviewer` for `services/reply-agent/src/webhook.ts` and env contract changes.
- [x] Run: `npm run test`
- [x] Run: `npm run build`
- [x] Run: `git diff --check -- services/reply-agent/src/webhook.ts services/reply-agent/src/db/queries.ts services/reply-agent/tests/webhook.test.ts services/reply-agent/tests/db_queries.test.ts services/reply-agent/tests/stripe.test.ts .env.example .env.test.example docs/architecture.md nginx.conf docs/superpowers/plans/2026-06-06-instantly-webhook-url-token.md`
- [x] Summarize any deploy follow-up separately if remote deployment is not performed in this turn.

# Dashboard D3 Operator Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the three lead detail operator actions for Issue #14: add note, override reply, and pause lead.

**Architecture:** Keep all database mutations in `services/dashboard/src/db/queries.ts`; keep Instantly API calls in a dashboard server-side client; expose the behavior through `services/dashboard/src/app/actions/lead-actions.ts` Server Actions. The lead detail UI passes tenant and lead context into `OperatorActionButtons`, which uses action state and local optimistic conversation rendering so notes and override replies appear without a full page reload.

**Tech Stack:** Next.js App Router Server Actions, React 19 client components, Drizzle ORM, Vitest, Testing Library, Instantly API over `fetch`.

---

### Task 1: DB Write Helpers

**Files:**
- Modify: `services/dashboard/src/db/queries.ts`
- Test: `services/dashboard/src/db/queries.test.ts`

- [ ] Add failing tests proving note/override inserts include `tenant_id`, `lead_id`, `direction`, `channel`, `body`, and `operator_override`, and that status updates only target the tenant-scoped lead.
- [ ] Implement `buildInsertOperatorConversationQuery`, `insertOperatorConversation`, `buildUpdateLeadStatusQuery`, and `updateLeadStatus`.
- [ ] Run `npm run test -- src/db/queries.test.ts`.

### Task 2: Instantly Client

**Files:**
- Create: `services/dashboard/src/clients/instantly.ts`
- Test: `services/dashboard/src/clients/instantly.test.ts`

- [ ] Add failing tests for missing API key, pause PATCH payload, and reply POST payload.
- [ ] Implement `InstantlyHttpClient` with `pauseLead` and `sendReply` methods.
- [ ] Run `npm run test -- src/clients/instantly.test.ts`.

### Task 3: Server Actions

**Files:**
- Modify: `services/dashboard/src/app/actions/lead-actions.ts`
- Test: `services/dashboard/src/app/actions/lead-actions.test.ts`

- [ ] Add failing tests for validation, add-note insert, override insert plus Instantly send plus replied status update, and pause Instantly call plus archived badge status update.
- [ ] Implement typed action state returns and dependency injection for tests.
- [ ] Run `npm run test -- src/app/actions/lead-actions.test.ts`.

### Task 4: Lead Detail UI

**Files:**
- Modify: `services/dashboard/src/app/(app)/leads/[id]/page.tsx`
- Modify: `services/dashboard/src/components/OperatorActionButtons.tsx`
- Modify: `services/dashboard/src/components/OperatorActionButtons.test.tsx`

- [ ] Add failing UI tests showing the buttons are enabled, textarea validation is visible, success state appears, and local conversation items render immediately.
- [ ] Wire `OperatorActionButtons` with forms, confirmation state, and status badge preview.
- [ ] Pass `tenantId`, `leadId`, current status, and conversations from the page.
- [ ] Run `npm run test -- src/components/OperatorActionButtons.test.tsx`.

### Task 5: Verification

**Files:**
- Review: all changed files

- [ ] Run targeted D3 tests.
- [ ] Run `npm run test`.
- [ ] Run `npm run build`.
- [ ] Invoke db/security review paths for DB writes and Server Actions before PR work.

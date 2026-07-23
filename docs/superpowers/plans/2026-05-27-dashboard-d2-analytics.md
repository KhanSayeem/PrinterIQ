# Dashboard D2 Analytics Implementation Plan

> **For agentic workers:** Use executing-plans or dispatching-parallel-agents to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build read-only `/pipeline` and `/revenue` analytics views for Issue #13 using real tenant-scoped dashboard data.

**Architecture:** Add all Drizzle query builders and normalization in `services/dashboard/src/db/queries.ts`, then render the analytics from authenticated App Router server components under `services/dashboard/src/app/(app)/`. Keep the funnel visualization in a reusable server-safe component and reuse locked dashboard CSS tokens from `docs/design/printeriq-dashboard.html`.

**Tech Stack:** Next.js App Router server components, TypeScript, Drizzle ORM, postgres-js, Vitest, React Testing Library.

---

## File Map

- Modify `services/dashboard/src/db/queries.ts`: add tenant-scoped pipeline and revenue query builders, public fetch functions, period helpers, and conversion math.
- Modify `services/dashboard/src/db/queries.test.ts`: add SQL-scope and conversion tests before implementation.
- Create `services/dashboard/src/components/PipelineFunnel.tsx`: render stage cards and conversion bars from typed data.
- Create `services/dashboard/src/components/PipelineFunnel.test.tsx`: verify zero-count stages and no-prior-stage copy.
- Create `services/dashboard/src/app/(app)/pipeline/page.tsx`: server component that loads pipeline data and renders real empty/error states.
- Create `services/dashboard/src/app/(app)/pipeline/loading.tsx`: skeleton matching the funnel layout.
- Create `services/dashboard/src/app/(app)/pipeline/error.tsx`: route error boundary copy.
- Create `services/dashboard/src/app/(app)/revenue/page.tsx`: server component with query-string period tabs and real revenue/AI-cost states.
- Create `services/dashboard/src/app/(app)/revenue/loading.tsx`: skeleton matching metric cards and AI cost card.
- Create `services/dashboard/src/app/(app)/revenue/error.tsx`: route error boundary copy.
- Modify `services/dashboard/src/app/globals.css`: add funnel, revenue, period tab, and analytics skeleton styles from the locked reference.

## Task 1: Query Tests First

- [ ] Add failing tests for `buildPipelineStatusCountsQuery()` proving it filters by `leads.tenant_id` and `leads.is_deleted = false`.
- [ ] Add failing tests for `buildRevenuePaymentsSummaryQuery()` proving it filters by `payments.tenant_id`, paid payments, and a period start.
- [ ] Add failing tests for `buildAiCostByModelQuery()` proving it filters by `qualifications.tenant_id` and a period start.
- [ ] Add pure helper tests for fixed pipeline status order, zero-filled missing statuses, consecutive conversion rates, and divide-by-zero fallback.
- [ ] Run `npm run test -- src/db/queries.test.ts` from `services/dashboard` and confirm the new tests fail for missing exports.

## Task 2: Query Implementation

- [ ] Add `PIPELINE_STATUSES` and `REVENUE_PERIODS` constants in `queries.ts`.
- [ ] Implement the D2 query builders in `queries.ts` using Drizzle aggregations and `tenant_id` scope only through `db/queries.ts`.
- [ ] Implement normalization helpers that coerce numeric strings from Postgres into numbers.
- [ ] Implement `getPipelineAnalytics({ tenantId })` returning zero-filled stage rows plus conversion rows.
- [ ] Implement `getRevenueAnalytics({ tenantId, period })` returning period metadata, total revenue, paid/imported conversion, payment count, and AI model costs.
- [ ] Run the query test file and fix until green.

## Task 3: Pipeline View

- [ ] Add failing component tests for `PipelineFunnel` showing all seven statuses, zero counts for missing stages, and `--` when the previous stage count is zero.
- [ ] Implement `PipelineFunnel.tsx` as a server-safe presentational component.
- [ ] Create `/pipeline` page as a server component that calls `getPipelineAnalytics()`, catches DB errors, and renders the real empty state `"No pipeline data. Import leads first."`.
- [ ] Add `/pipeline/loading.tsx` and `/pipeline/error.tsx`.
- [ ] Run component and query tests.

## Task 4: Revenue View

- [ ] Create `/revenue` page as a server component using `searchParams.period` with allowed values `today`, `week`, and `month`.
- [ ] Render period links via query string, not client state.
- [ ] Render total revenue, paid/imported conversion, paid payment count, and total AI spend from real query results.
- [ ] Render `"No payments recorded yet."` and `"No AI spend recorded yet."` for empty sections.
- [ ] Add `/revenue/loading.tsx` and `/revenue/error.tsx`.
- [ ] Run dashboard tests.

## Task 5: Styling

- [ ] Add CSS for funnel cards, conversion bars, revenue tabs, metric cards, AI cost rows, and skeletons based on the locked design reference.
- [ ] Keep text compact and responsive; ensure no mock values from `printeriq-dashboard.html` are copied into production components.
- [ ] Run `npm run build` to catch TypeScript and Next.js route issues.

## Task 6: Required Review And Verification

- [ ] Invoke or manually apply `.codex/agents/db-reviewer` after adding D2 queries.
- [ ] Run `npm run test` from `services/dashboard`.
- [ ] Run `npm run build` from `services/dashboard`.
- [ ] If local DB credentials are available, run a read-only live data check against `.env.local` for `/pipeline` and `/revenue` query outputs.
- [ ] Summarize changed files, verification results, and any gaps without opening a PR unless explicitly requested.

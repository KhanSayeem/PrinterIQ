# Dashboard D1 Implementation Plan

> **For agentic workers:** Use executing-plans or dispatching-parallel-agents to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the private Next.js operator dashboard with Supabase Auth, tenant-scoped Drizzle reads, a reference-matched leads list, and a full lead detail page.

**Architecture:** Scaffold `services/dashboard` fresh, then keep auth, DB reads, app shell, and route UI in separate modules. Pages remain Server Components for data fetching; client components are limited to login, sidebar state, row selection, and tabs.

**Tech Stack:** Next.js App Router, TypeScript, Tailwind, Supabase Auth, Drizzle ORM, Postgres, Vitest/Testing Library where practical, plain CSS/Tailwind with no shadcn and no Radix.

---

## File Structure

- Create: `services/dashboard/package.json` and scaffolded Next.js config files.
- Create: `services/dashboard/src/app/globals.css` with tokens copied from `docs/design/printeriq-dashboard.html`.
- Create: `services/dashboard/src/app/layout.tsx` for root metadata/font wiring.
- Create: `services/dashboard/src/app/login/page.tsx` and `services/dashboard/src/components/LoginForm.tsx`.
- Create: `services/dashboard/src/middleware.ts` for auth redirect behavior required by Issue #12.
- Create: `services/dashboard/src/auth/server.ts` and `services/dashboard/src/auth/client.ts`.
- Create: `services/dashboard/src/db/schema.ts`, `services/dashboard/src/db/client.ts`, and `services/dashboard/src/db/queries.ts`.
- Create: `services/dashboard/src/app/(app)/layout.tsx`, `services/dashboard/src/components/AppShell.tsx`, and `services/dashboard/src/components/Sidebar.tsx`.
- Create: `services/dashboard/src/app/(app)/leads/page.tsx`, `services/dashboard/src/components/LeadTable.tsx`, `services/dashboard/src/components/LeadQuickPanel.tsx`, and `services/dashboard/src/components/LeadStatusBadge.tsx`.
- Create: `services/dashboard/src/app/(app)/leads/[id]/page.tsx`, `services/dashboard/src/components/LeadDetailTabs.tsx`, and `services/dashboard/src/components/ConversationThread.tsx`.

## Task 1: Fresh Dashboard Scaffold

- [ ] **Step 1: Confirm the folder is still scaffold-only**

Run: `rg --files services/dashboard`

Expected: only `.gitkeep` placeholder paths are present.

- [ ] **Step 2: Scaffold the dashboard**

Run from repo root:

```powershell
npx create-next-app@15.5.7 services/dashboard --yes --force --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm
```

Expected: `services/dashboard/package.json` exists and the app uses the App Router under `src/app`.

- [ ] **Step 3: Add dashboard dependencies**

Run:

```powershell
Set-Location services/dashboard
npm install @supabase/ssr @supabase/supabase-js drizzle-orm postgres lucide-react
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
```

Expected: dependencies install without modifying protected root files.

- [ ] **Step 4: Commit scaffold**

```powershell
git add services/dashboard
git commit -m "chore(dashboard): scaffold next app"
```

## Task 2: Auth Foundation

- [ ] **Step 1: Write failing auth middleware tests**

Create `services/dashboard/src/auth/middleware.test.ts` with tests for unauthenticated `/leads` redirecting to `/login` and `/login` being public.

- [ ] **Step 2: Run red test**

Run: `npm run test -- src/auth/middleware.test.ts`

Expected: failure because auth middleware helpers do not exist yet.

- [ ] **Step 3: Implement auth helpers and middleware**

Create:

- `src/auth/server.ts` with server-side Supabase cookie client helpers.
- `src/auth/client.ts` with browser Supabase client helpers.
- `src/middleware.ts` that allows `/login` and redirects other unauthenticated routes to `/login`.

Do not expose service-role credentials to client code.

- [ ] **Step 4: Run green test**

Run: `npm run test -- src/auth/middleware.test.ts`

Expected: tests pass.

- [ ] **Step 5: Invoke security reviewer**

Use `security-reviewer` because auth and middleware code changed.

- [ ] **Step 6: Commit auth foundation**

```powershell
git add services/dashboard/src/auth services/dashboard/src/middleware.ts services/dashboard/src/auth/middleware.test.ts
git commit -m "feat(dashboard): add supabase auth guard"
```

## Task 3: Drizzle Schema And Tenant-Scoped Queries

- [ ] **Step 1: Write failing query tests**

Create tests proving:

- lead list query includes `tenant_id`
- lead detail query includes `tenant_id` and `lead_id`
- conversation, outreach, and payment reads are scoped by the same `tenant_id`

- [ ] **Step 2: Run red tests**

Run: `npm run test -- src/db/queries.test.ts`

Expected: failure because query functions do not exist yet.

- [ ] **Step 3: Implement DB modules**

Create:

- `src/db/schema.ts` matching the current `database/schema.sql` tables needed by Dashboard D1.
- `src/db/client.ts` with lazy Drizzle initialization from server-only `DATABASE_URL`.
- `src/db/queries.ts` with `getLeadList`, `getLeadDetail`, and supporting typed return shapes.

Every query must include `tenantId` in its conditions.

- [ ] **Step 4: Run green query tests**

Run: `npm run test -- src/db/queries.test.ts`

Expected: tests pass.

- [ ] **Step 5: Invoke db reviewer**

Use `db-reviewer` because `src/db/queries.ts` contains new database queries.

- [ ] **Step 6: Commit DB layer**

```powershell
git add services/dashboard/src/db
git commit -m "feat(dashboard): add tenant scoped lead queries"
```

## Task 4: Reference-Matched App Shell

- [ ] **Step 1: Copy design tokens**

Move the CSS variable system, Geist font assumptions, sidebar dimensions, badge colors, table spacing, detail panel styles, and tab styles from `docs/design/printeriq-dashboard.html` into `services/dashboard/src/app/globals.css`.

- [ ] **Step 2: Implement shell components**

Create:

- `src/components/AppShell.tsx`
- `src/components/Sidebar.tsx`
- `src/app/(app)/layout.tsx`

The sidebar must collapse to 52px, expand to 216px on hover, and support pin locking.

- [ ] **Step 3: Verify shell build**

Run: `npm run build`

Expected: build passes.

- [ ] **Step 4: Commit app shell**

```powershell
git add services/dashboard/src/app services/dashboard/src/components/AppShell.tsx services/dashboard/src/components/Sidebar.tsx
git commit -m "feat(dashboard): add reference matched app shell"
```

## Task 5: Login Page

- [ ] **Step 1: Write failing login form test**

Test that the login form renders email and password fields and calls Supabase password sign-in on submit.

- [ ] **Step 2: Implement login route**

Create `src/app/login/page.tsx` and `src/components/LoginForm.tsx`, matching the reference visual style and redirecting successful login to `/leads`.

- [ ] **Step 3: Run login tests and build**

Run:

```powershell
npm run test -- src/components/LoginForm.test.tsx
npm run build
```

- [ ] **Step 4: Commit login**

```powershell
git add services/dashboard/src/app/login services/dashboard/src/components/LoginForm.tsx services/dashboard/src/components/LoginForm.test.tsx
git commit -m "feat(dashboard): add login page"
```

## Task 6: Leads List And Quick Panel

- [ ] **Step 1: Write failing component tests**

Test `LeadStatusBadge` class mapping and quick-panel external link target `/leads/[id]`.

- [ ] **Step 2: Implement list route and components**

Create:

- `src/app/(app)/leads/page.tsx`
- `src/components/LeadTable.tsx`
- `src/components/LeadQuickPanel.tsx`
- `src/components/LeadStatusBadge.tsx`

The page reads filters from `searchParams`: `status`, `state`, `trade_type`, `score_min`, `score_max`, and `page`.

- [ ] **Step 3: Run tests and build**

Run:

```powershell
npm run test -- src/components/LeadStatusBadge.test.tsx src/components/LeadQuickPanel.test.tsx
npm run build
```

- [ ] **Step 4: Commit leads list**

```powershell
git add services/dashboard/src/app/(app)/leads services/dashboard/src/components/LeadTable.tsx services/dashboard/src/components/LeadQuickPanel.tsx services/dashboard/src/components/LeadStatusBadge.tsx
git commit -m "feat(dashboard): add leads list"
```

## Task 7: Lead Detail Page

- [ ] **Step 1: Write failing tab/thread tests**

Test that detail tabs expose `Overview`, `Conversation`, `Outreach`, and `Payment`, and that conversation directions map to outbound/inbound/note styles.

- [ ] **Step 2: Implement detail route and components**

Create:

- `src/app/(app)/leads/[id]/page.tsx`
- `src/components/LeadDetailTabs.tsx`
- `src/components/ConversationThread.tsx`

The route must return not found when the lead is absent for the current tenant.

- [ ] **Step 3: Run tests and build**

Run:

```powershell
npm run test -- src/components/LeadDetailTabs.test.tsx src/components/ConversationThread.test.tsx
npm run build
```

- [ ] **Step 4: Commit lead detail**

```powershell
git add services/dashboard/src/app/(app)/leads/[id] services/dashboard/src/components/LeadDetailTabs.tsx services/dashboard/src/components/ConversationThread.tsx
git commit -m "feat(dashboard): add lead detail"
```

## Task 8: Final Verification

- [ ] **Step 1: Run full dashboard verification**

Run from `services/dashboard`:

```powershell
npm run test
npm run build
```

Expected: zero TypeScript and ESLint errors.

- [ ] **Step 2: Run local server**

Run: `npm run dev`

Expected: dashboard starts on port 3000 or the next available port if 3000 is occupied.

- [ ] **Step 3: Manual auth verification**

Verify:

- unauthenticated `/leads` redirects to `/login`
- authenticated `/leads` loads live data

- [ ] **Step 4: Visual verification**

Compare browser screenshots against `docs/design/printeriq-dashboard.html` for:

- collapsed and pinned sidebar widths
- status badge colors
- lead table density
- quick-glance detail panel scope
- `/leads/[id]` four-tab layout

- [ ] **Step 5: Final reviewers**

Run `db-reviewer` again if any query changed after its first review. Run `security-reviewer` again if auth/middleware changed after its first review.

- [ ] **Step 6: Commit final fixes**

```powershell
git status --short
git add services/dashboard
git commit -m "test(dashboard): verify dashboard d1"
```

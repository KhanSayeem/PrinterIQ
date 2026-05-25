# Dashboard D1 Design

## Goal

Build the private operator dashboard in `services/dashboard/` as a fresh Next.js App Router service on port 3000. The dashboard is for Macauley only, uses Supabase Auth, and reads PrinterIQ lead data from Supabase Postgres through Drizzle with every query scoped by `tenant_id`.

## Confirmed Starting State

- Branch: `feat/dashboard-d1`, created from current `dev` after `git pull --ff-only origin dev` reported up to date.
- Live Issue #12 is open: `[Dashboard D1] Supabase Auth shell + leads list + lead detail`.
- Live Issue #1 is closed. A read-only Supabase REST check using local `.env` credentials confirmed all eight public tables respond: `tenants`, `leads`, `enrichments`, `qualifications`, `outreach_sends`, `conversations`, `payments`, and `queue_jobs`.
- `services/dashboard/` has only placeholder `.gitkeep` files and no `package.json`, so this starts from a fresh scaffold.
- The requested `docs/design/dashboard-reference.html` does not exist. The repo contains `docs/design/printeriq-dashboard.html`, which is treated as the locked UI reference.

## Locked Visual Contract

The implementation must match `docs/design/printeriq-dashboard.html` rather than inventing a new design.

- Fonts: Geist and Geist Mono.
- CSS variables copied into `services/dashboard/src/app/globals.css`, including the exact status badge classes:
  - `imported`: `#f4f4f2` / `#57564f`
  - `enriched`: `#eff6ff` / `#1e40af`
  - `qualified`: `#f3f0ff` / `#5b21b6`
  - `contacted`: `#fffbeb` / `#92400e`
  - `replied`: `#f0fdf4` / `#166534`
  - `paid`: `#ecfdf5` / `#065f46`
  - `archived`: `#fff1f2` / `#9f1239`
- Sidebar: 52px collapsed icon rail, 216px on hover, pin toggle to lock expanded.
- Leads view: table-led layout with filters and a quick-glance detail panel.
- Detail panel: quick glance only. Its external/open action navigates to `/leads/[id]`.
- Lead detail route: full page with four tabs: `Overview`, `Conversation`, `Outreach`, `Payment`.
- UI stack: plain Tailwind/CSS modules as needed. No shadcn and no Radix.

## Architecture

Scaffold `services/dashboard` fresh with create-next-app, then keep the dashboard code small and route-oriented:

- App shell in `src/app/(app)/layout.tsx` renders the auth-gated sidebar/top-level frame.
- `/login` stays outside the app shell.
- `/leads` is a Server Component that fetches a tenant-scoped paginated lead list with filters.
- `/leads/[id]` is a Server Component that fetches one tenant-scoped lead detail bundle.
- Small client components provide interaction only where needed: sidebar pin/hover, login form, lead-row detail selection, and tabs.
- Database access lives under `src/db/`, with Drizzle schema and query functions. Route components call query functions only; no raw queries in page/component files.
- Supabase Auth code lives under `src/auth/` and `src/middleware.ts`.

## Security And Data Rules

- Supabase service role key is server-only and never exposed through `NEXT_PUBLIC_`.
- Browser auth uses publishable/anon Supabase credentials only.
- `src/middleware.ts` redirects unauthenticated requests to `/login`, and server routes/pages also re-check the session before reading data.
- Every dashboard DB read accepts `tenantId` and includes it in the Drizzle `where` clause.
- Dashboard D1 is read-only for lead data. It does not write to `outreach_sends` or `conversations`.
- Invoke `db-reviewer` after Drizzle query code is written.
- Invoke `security-reviewer` after auth and middleware code is written.

## Testing And Verification

- Use TDD for query behavior and auth guard behavior: write tests first, watch them fail, then implement.
- Run `npm run build` in `services/dashboard`.
- Manually verify unauthenticated `/leads` redirects to `/login`.
- Manually verify authenticated `/leads` loads live data.
- Run browser visual checks against `docs/design/printeriq-dashboard.html` for desktop and mobile layout fidelity before claiming completion.

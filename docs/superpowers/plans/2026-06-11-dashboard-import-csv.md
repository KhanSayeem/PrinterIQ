# Dashboard Import CSV Implementation Plan

> **For agentic workers:** Use executing-plans or dispatching-parallel-agents to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the dashboard Leads page to upload an Apollo CSV and queue the existing `ingest_csv` pipeline worker.

**Architecture:** The dashboard owns only upload validation, server-side file persistence, and Redis/BullMQ enqueueing. The existing Python pipeline remains responsible for consuming the `pipeline` queue, creating/leasing `queue_jobs`, parsing Apollo CSV rows, deduplication, inserts, and fan-out to enrichment.

**Tech Stack:** Next.js App Router, React, Vitest, BullMQ/Redis, Node `fs/promises`, existing Python pipeline worker.

---

### Task 1: Import Queue Enqueue Helper

**Files:**
- Create: `services/dashboard/src/queue/pipeline.ts`
- Test: `services/dashboard/src/queue/pipeline.test.ts`
- Modify: `services/dashboard/package.json`
- Modify: `services/dashboard/package-lock.json`

- [x] Add dashboard `bullmq` runtime dependency.
- [x] Add `enqueueIngestCsvJob` that writes an `ingest_csv` payload to Redis/BullMQ queue `pipeline`.
- [x] Use a deterministic tenant import job id to block duplicate waiting/active imports.
- [x] Verify the helper emits `tenant_id`, `job_type = "ingest_csv"`, `file_path`, `source_file`, `vertical = "tradies"`, and `dry_run = false`, with no client-supplied tenant.
- [x] Do not insert dashboard rows into `queue_jobs`; the Python pipeline worker owns that tracking ledger after it pops Redis jobs.

### Task 2: Import API Route

**Files:**
- Create: `services/dashboard/src/app/api/import-csv/route.ts`
- Create: `services/dashboard/src/app/api/import-csv/route.test.ts`

- [x] Add tests for unauthenticated, forbidden, missing tenant, missing file, non-CSV file, successful upload, and route failure.
- [x] Implement `POST /api/import-csv` using the same operator auth and tenant resolution pattern as `/api/leads`.
- [x] Return JSON for all validation and application errors.
- [x] Save valid files under `DASHBOARD_UPLOAD_DIR` or `uploads/dashboard-imports`.
- [x] Queue the existing `ingest_csv` payload to Redis/BullMQ with `vertical = "tradies"` and `dry_run = false`.

### Task 3: Leads Upload UI

**Files:**
- Modify: `services/dashboard/src/components/LeadsWorkbench.tsx`
- Modify: `services/dashboard/src/components/LeadsWorkbench.test.tsx`
- Modify: `services/dashboard/src/app/globals.css`

- [x] Add tests for enabled Import CSV file selection, success message, validation error, and loading state.
- [x] Replace the disabled button with a file picker label styled as the existing primary button.
- [x] POST selected CSV files to `/api/import-csv` as `FormData`.
- [x] Show explicit loading, success, and error states without faking imported lead counts.

### Task 4: Verification

**Files:**
- All touched files

- [x] Run focused dashboard tests for the queue helper, import route, auth middleware, and workbench.
- [x] Run full `npm run test` in `services/dashboard`.
- [x] Run `npm run build` in `services/dashboard`.
- [x] Invoke `db-reviewer` to confirm the final dashboard path does not add DB writes and preserves tenant/queue ownership.
- [x] Invoke `security-reviewer` for the new authenticated upload route.

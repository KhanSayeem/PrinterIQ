# High Entropy Preview URLs Implementation Plan

> **For agentic workers:** Use executing-plans or dispatching-parallel-agents to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace tenant/lead-derived public preview URLs with high-entropy slug URLs while keeping every lookup tenant-scoped.

**Architecture:** `website_previews` stores a unique `preview_slug` used for the public URL and filesystem path. `generate_preview` creates or reuses the slug for the tenant lead, and `schedule_outreach` validates any supplied preview URL against the tenant-scoped row instead of deriving it from public IDs.

**Tech Stack:** Python 3.12, async protocol fakes, Postgres migrations, pytest, ruff, mypy.

---

### Task 1: Schema and query contract

**Files:**
- Create: `database/migrations/0007_add_website_preview_slug.sql`
- Modify: `database/schema.sql`
- Modify: `services/pipeline/src/db/queries.py`
- Test: `services/pipeline/tests/test_schema.py`
- Test: `services/pipeline/tests/test_outreach_queries.py`

- [ ] Add a failing schema/query test requiring `preview_slug TEXT NOT NULL UNIQUE` and migration `0007`.
- [ ] Run the focused tests and confirm they fail because `preview_slug` is missing.
- [ ] Add migration `0007` and canonical schema support.
- [ ] Add `preview_slug` to `WebsitePreviewInsert`, insert/update SQL, and selected preview rows.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Preview generation contract

**Files:**
- Modify: `services/pipeline/src/workers/generate_preview.py`
- Test: `services/pipeline/tests/test_generate_preview.py`

- [ ] Add failing tests requiring preview URLs and files to use `/p/{slug}/`, not `{tenant_id}/{lead_id}`.
- [ ] Run the focused tests and confirm they fail.
- [ ] Generate URL-safe high-entropy slugs for new previews and reuse stored slugs on replay.
- [ ] Write preview HTML under the slug path and enqueue the slug URL downstream.
- [ ] Run the focused tests and confirm they pass.

### Task 3: Outreach validation contract

**Files:**
- Modify: `services/pipeline/src/workers/schedule_outreach.py`
- Test: `services/pipeline/tests/test_schedule_outreach.py`

- [ ] Add failing tests requiring schedule outreach to compare payload `preview_url` to the tenant-scoped stored preview row.
- [ ] Run the focused tests and confirm they fail.
- [ ] Add tenant-scoped preview lookup to the outreach repository protocol and validation flow.
- [ ] Run the focused tests and confirm they pass.

### Task 4: Review and verification

**Files:**
- Review only the changed preview/schema/query files.

- [ ] Invoke `db-reviewer` for DB schema/query changes.
- [ ] Invoke `security-reviewer` for public preview URL exposure changes.
- [ ] Run `python -m pytest services/pipeline/tests -q`.
- [ ] Run `python -m ruff check services/pipeline/src services/pipeline/tests`.
- [ ] Run `python -m mypy src` from `services/pipeline`.
- [ ] Run `git diff --check` on the changed files.

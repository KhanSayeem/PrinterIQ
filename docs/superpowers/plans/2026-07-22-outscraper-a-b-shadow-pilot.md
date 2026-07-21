# Outscraper A/B Shadow Pilot Implementation Plan

> **For agentic workers:** Use executing-plans or dispatching-parallel-agents to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tenant-scoped Outscraper discovery and deterministic A/B scoring layer that resolves Apollo-verified contacts and stops in an auditable dashboard shadow review queue.

**Architecture:** Outscraper runs are isolated in four prospect-staging tables and processed as run-level Python queue jobs. The existing `leads` pipeline is not called. The authenticated Next.js dashboard creates a fixed Greater Brisbane plumbing run, displays deterministic evidence, records manual assessments, and exposes validation metrics and export without promotion or outreach controls.

**Tech Stack:** PostgreSQL/Supabase migrations, Python 3.12, asyncpg, httpx, Playwright, Redis/BullMQ-compatible queue transport, Next.js App Router, TypeScript, Drizzle ORM, Vitest, Testing Library, pytest.

**Design spec:** `docs/superpowers/specs/2026-07-22-outscraper-a-b-shadow-pilot-design.md`

---

## Execution Rules

- Start from a fresh worktree based on the latest `origin/dev`; do not reuse the dirty root checkout.
- Keep one commit per task. Do not combine unrelated cleanup or existing pipeline bug fixes with this feature.
- Migration `0008` is the next number on the current design baseline. If rebasing introduces `0008`, rename this feature migration to the next sequential number and update schema tests in the same task.
- Every database read and write includes `tenant_id`. Invoke `db-reviewer` after every task that changes a query or migration.
- Invoke `security-reviewer` after adding the authenticated prospect API routes and server actions.
- Provider tests use injected `httpx` transports or fakes. Automated tests never spend Outscraper or Apollo credits.
- V1 must contain no import from `workers.ingest`, no `insert_lead`, no lead-status transition, no preview generation, and no Instantly call in any prospect module.
- Leave `ai_summary` and `prompt_version` null in V1. Deterministic evidence is sufficient for the shadow pilot; AI outreach summaries belong to a later live-outreach design.

## File Map

**Database and shared contracts**

- Create `database/migrations/0008_create_prospect_staging.sql`
- Modify `database/schema.sql`
- Modify `services/pipeline/src/db/queries.py`
- Modify `services/pipeline/tests/test_schema.py`
- Modify `services/pipeline/tests/test_queries.py`
- Modify `services/dashboard/src/db/schema.ts`
- Modify `services/dashboard/src/db/schema.test.ts`
- Modify `services/dashboard/src/db/queries.ts`
- Modify `services/dashboard/src/db/queries.test.ts`

**Pipeline**

- Create `services/pipeline/src/clients/outscraper_client.py`
- Create `services/pipeline/src/clients/apollo_client.py`
- Create `services/pipeline/src/clients/prospect_website_audit.py`
- Create `services/pipeline/src/prospects/normalization.py`
- Create `services/pipeline/src/prospects/website_scoring.py`
- Create `services/pipeline/src/prospects/sampling.py`
- Create `services/pipeline/src/workers/discover_prospects.py`
- Create `services/pipeline/src/workers/normalize_prospects.py`
- Create `services/pipeline/src/workers/assess_prospects.py`
- Create `services/pipeline/src/workers/enrich_prospect_contacts.py`
- Create `services/pipeline/src/workers/prepare_shadow_review.py`
- Create `services/pipeline/src/workers/purge_prospect_data.py`
- Modify `services/pipeline/src/pipeline_queue/definitions.py`
- Modify `services/pipeline/src/workers/orchestrator.py`
- Add corresponding tests under `services/pipeline/tests/`

**Dashboard**

- Create `services/dashboard/src/app/(app)/prospects/page.tsx`
- Create `services/dashboard/src/app/(app)/prospects/loading.tsx`
- Create `services/dashboard/src/app/(app)/prospects/error.tsx`
- Create `services/dashboard/src/app/api/prospects/route.ts`
- Create `services/dashboard/src/app/api/prospects/export/route.ts`
- Create `services/dashboard/src/app/actions/prospect-run-actions.ts`
- Create `services/dashboard/src/app/actions/prospect-run-actions-core.ts`
- Create `services/dashboard/src/app/actions/prospect-review-actions.ts`
- Create `services/dashboard/src/app/actions/prospect-review-actions-core.ts`
- Create `services/dashboard/src/lib/prospect-list-params.ts`
- Create `services/dashboard/src/components/ProspectsWorkbench.tsx`
- Create `services/dashboard/src/components/ProspectFilters.tsx`
- Create `services/dashboard/src/components/ProspectTable.tsx`
- Create `services/dashboard/src/components/ProspectQuickPanel.tsx`
- Create `services/dashboard/src/components/ProspectRunSummary.tsx`
- Create `services/dashboard/src/components/ShadowModeBanner.tsx`
- Add corresponding tests beside each route, action, helper, and component
- Modify `services/dashboard/src/components/Sidebar.tsx`
- Modify `services/dashboard/src/auth/middleware.ts`
- Modify `services/dashboard/src/queue/pipeline.ts`
- Modify `services/dashboard/src/app/globals.css`

**Documentation and configuration**

- Create `docs/adr/004-outscraper-shadow-discovery.md`
- Modify `docs/architecture.md`
- Modify `docs/queue-payloads.md`
- Modify `docs/operator-runbook.md`
- Modify `.env.example`

---

### Task 1: Supersede Apollo-Only Governance For A Shadow Pilot

**Files:**
- Create: `docs/adr/004-outscraper-shadow-discovery.md`
- Modify: `docs/architecture.md`
- Modify: `docs/queue-payloads.md`
- Modify: `.env.example`

- [ ] **Step 1: Write ADR 004**

Use this decision contract:

```markdown
# ADR 004 - Outscraper Shadow Discovery Before Apollo

## Status
Accepted for the bounded A/B shadow pilot. Supersedes ADR 003 only for staged shadow discovery.

## Context
ADR 003 intentionally limited Phase 1 to one Apollo CSV. PrinterIQ now needs to test discovery of Greater Brisbane plumbing businesses with missing or weak websites without changing the production lead pipeline.

## Decision
Outscraper may populate tenant-scoped prospect staging for a 300-500 business shadow run. Staged prospects cannot create leads or outreach. Apollo remains the contact resolver and requires a verified business email. Live sending requires a separate ADR and compliance review.

## Consequences
Provider terms, Australian privacy obligations, data retention, API spend, and lower Route A contact-match rates are explicit pilot risks. The existing Apollo CSV path remains unchanged.
```

- [ ] **Step 2: Document the isolated flow and queue payloads**

Add the staging flow to `docs/architecture.md` and document these payloads in `docs/queue-payloads.md`:

```json
{"job_type":"start_discovery","tenant_id":"10000000-0000-0000-0000-000000000001","discovery_run_id":"20000000-0000-0000-0000-000000000001"}
{"job_type":"poll_outscraper","tenant_id":"10000000-0000-0000-0000-000000000001","discovery_run_id":"20000000-0000-0000-0000-000000000001","poll_count":1}
{"job_type":"normalize_prospects","tenant_id":"10000000-0000-0000-0000-000000000001","discovery_run_id":"20000000-0000-0000-0000-000000000001"}
{"job_type":"assess_prospects","tenant_id":"10000000-0000-0000-0000-000000000001","discovery_run_id":"20000000-0000-0000-0000-000000000001"}
{"job_type":"enrich_prospect_contacts","tenant_id":"10000000-0000-0000-0000-000000000001","discovery_run_id":"20000000-0000-0000-0000-000000000001"}
{"job_type":"prepare_shadow_review","tenant_id":"10000000-0000-0000-0000-000000000001","discovery_run_id":"20000000-0000-0000-0000-000000000001"}
{"job_type":"purge_prospect_data","tenant_id":"10000000-0000-0000-0000-000000000001"}
```

Replace the UUID placeholders with the existing documentation convention if that file uses named example UUIDs. Also add the already-implemented `generate_preview` payload that the queue map currently omits.

- [ ] **Step 3: Add server-only configuration names**

Add this section to `.env.example` without real values:

```dotenv
# -- Prospect discovery -----------------------------------------------------
OUTSCRAPER_API_KEY=
APOLLO_API_KEY=
PROSPECT_DISCOVERY_TOTAL_LIMIT=500
PROSPECT_DISCOVERY_POLL_SECONDS=30
PROSPECT_RAW_RETENTION_DAYS=30
PROSPECT_RECORD_RETENTION_DAYS=90
```

- [ ] **Step 4: Verify governance references**

Run:

```powershell
rg -n "ADR 004|shadow|start_discovery|generate_preview|OUTSCRAPER_API_KEY|APOLLO_API_KEY" docs .env.example
```

Expected: ADR, architecture, queue payload, and environment references are present; no document claims Outscraper can send outreach.

- [ ] **Step 5: Commit**

```powershell
git add docs/adr/004-outscraper-shadow-discovery.md docs/architecture.md docs/queue-payloads.md .env.example
git commit -m "docs: authorize Outscraper shadow discovery"
```

---

### Task 2: Add Tenant-Scoped Prospect Staging

**Files:**
- Create: `database/migrations/0008_create_prospect_staging.sql`
- Modify: `database/schema.sql`
- Modify: `services/pipeline/tests/test_schema.py`
- Modify: `services/dashboard/src/db/schema.ts`
- Modify: `services/dashboard/src/db/schema.test.ts`

- [ ] **Step 1: Write failing canonical-schema tests**

Add assertions covering all four tables and composite tenant foreign keys:

```python
def test_canonical_schema_includes_prospect_staging_contract() -> None:
    schema = (REPO_ROOT / "database" / "schema.sql").read_text()
    migration = REPO_ROOT / "database" / "migrations" / "0008_create_prospect_staging.sql"

    assert migration.exists()
    for table in (
        "discovery_runs",
        "business_prospects",
        "prospect_assessments",
        "prospect_contacts",
    ):
        assert f"CREATE TABLE {table}" in schema
    assert "discovery_runs_one_active_per_tenant_idx" in schema
    assert "business_prospects_source_identity_key" in schema
    assert "business_prospects_tenant_run_id_key" in schema
    assert "FOREIGN KEY (tenant_id, discovery_run_id)" in schema
    assert "FOREIGN KEY (tenant_id, discovery_run_id, prospect_id)" in schema
    assert "prospect_manual_assessment_idempotency_idx" in schema
```

Extend `schema.test.ts` so Drizzle exports and maps the four table contracts.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
python -m pytest services/pipeline/tests/test_schema.py -q
Set-Location services/dashboard; npm test -- src/db/schema.test.ts
```

Expected: FAIL because the migration, SQL tables, and Drizzle mappings do not exist.

- [ ] **Step 3: Create the migration and canonical schema**

Implement four tables with these non-negotiable constraints:

```sql
CREATE TABLE discovery_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
  source TEXT NOT NULL CHECK (source = 'outscraper'),
  source_request_id TEXT,
  query_spec JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created','submitted','polling','persisted','processing','review_ready','completed','failed'
  )),
  shadow_mode BOOLEAN NOT NULL DEFAULT TRUE CHECK (shadow_mode = TRUE),
  discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  usable_count INTEGER NOT NULL DEFAULT 0 CHECK (usable_count >= 0),
  route_a_count INTEGER NOT NULL DEFAULT 0 CHECK (route_a_count >= 0),
  route_b_count INTEGER NOT NULL DEFAULT 0 CHECK (route_b_count >= 0),
  verified_contact_count INTEGER NOT NULL DEFAULT 0 CHECK (verified_contact_count >= 0),
  provider_usage JSONB NOT NULL DEFAULT '{}',
  failure_code TEXT,
  failure_detail TEXT,
  submitted_at TIMESTAMPTZ,
  results_received_at TIMESTAMPTZ,
  review_ready_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_runs_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT discovery_runs_source_request_key UNIQUE (tenant_id, source, source_request_id)
);

CREATE UNIQUE INDEX discovery_runs_one_active_per_tenant_idx
ON discovery_runs (tenant_id)
WHERE status IN ('created','submitted','polling','persisted','processing');

CREATE TABLE business_prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
  discovery_run_id UUID NOT NULL,
  source TEXT NOT NULL CHECK (source = 'outscraper'),
  source_business_id TEXT NOT NULL,
  business_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  primary_category TEXT,
  additional_categories JSONB NOT NULL DEFAULT '[]',
  phone TEXT,
  normalized_phone TEXT,
  full_address TEXT,
  locality TEXT,
  state TEXT,
  postcode TEXT,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  business_status TEXT,
  rating NUMERIC(2,1),
  review_count INTEGER CHECK (review_count IS NULL OR review_count >= 0),
  google_profile_url TEXT,
  source_website_url TEXT,
  normalized_domain TEXT,
  website_ownership TEXT CHECK (website_ownership IN (
    'none','social','directory','marketplace','placeholder','inaccessible','owned'
  )),
  duplicate_evidence JSONB NOT NULL DEFAULT '{}',
  is_franchise BOOLEAN NOT NULL DEFAULT FALSE,
  matched_location_count INTEGER NOT NULL DEFAULT 1 CHECK (matched_location_count >= 1),
  route TEXT CHECK (route IN ('A','B','manual_review','healthy')),
  outcome_reason TEXT,
  status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN (
    'discovered','normalized','assessed','contact_enriched','review_ready',
    'held','rejected','failed','approved','promoted'
  )),
  lead_id UUID REFERENCES leads(id),
  validation_sample BOOLEAN NOT NULL DEFAULT FALSE,
  validation_cohort TEXT CHECK (validation_cohort IN ('A','B','healthy_rejected')),
  source_payload JSONB,
  source_payload_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT business_prospects_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT business_prospects_tenant_run_id_key
    UNIQUE (tenant_id, discovery_run_id, id),
  CONSTRAINT business_prospects_source_identity_key
    UNIQUE (tenant_id, discovery_run_id, source, source_business_id),
  CONSTRAINT fk_business_prospects_run_tenant
    FOREIGN KEY (tenant_id, discovery_run_id)
    REFERENCES discovery_runs(tenant_id, id),
  CONSTRAINT fk_business_prospects_lead_tenant
    FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id)
);

CREATE TABLE prospect_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
  discovery_run_id UUID NOT NULL,
  prospect_id UUID NOT NULL,
  assessment_type TEXT NOT NULL CHECK (assessment_type IN ('automated','manual_review')),
  assessment_version TEXT NOT NULL,
  eligible BOOLEAN,
  computed_route TEXT CHECK (computed_route IN ('A','B','manual_review','healthy')),
  total_score INTEGER CHECK (total_score BETWEEN 0 AND 100),
  category_scores JSONB NOT NULL DEFAULT '{}',
  rule_evidence JSONB NOT NULL DEFAULT '{}',
  forced_route_reason TEXT,
  reviewer_id UUID,
  idempotency_key TEXT,
  review_decision TEXT CHECK (review_decision IN (
    'correct','wrong_route','ineligible','needs_investigation'
  )),
  corrected_route TEXT CHECK (corrected_route IN ('A','B','manual_review','healthy')),
  review_note TEXT,
  ai_summary TEXT,
  prompt_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_prospect_assessments_run_tenant
    FOREIGN KEY (tenant_id, discovery_run_id) REFERENCES discovery_runs(tenant_id, id),
  CONSTRAINT fk_prospect_assessments_prospect_run_tenant
    FOREIGN KEY (tenant_id, discovery_run_id, prospect_id)
    REFERENCES business_prospects(tenant_id, discovery_run_id, id),
  CONSTRAINT prospect_assessment_shape_check CHECK (
    (assessment_type = 'automated' AND reviewer_id IS NULL AND idempotency_key IS NULL)
    OR
    (assessment_type = 'manual_review' AND reviewer_id IS NOT NULL
      AND idempotency_key IS NOT NULL AND review_decision IS NOT NULL)
  )
);

CREATE UNIQUE INDEX prospect_automated_assessment_version_idx
ON prospect_assessments (tenant_id, prospect_id, assessment_version)
WHERE assessment_type = 'automated';

CREATE UNIQUE INDEX prospect_manual_assessment_idempotency_idx
ON prospect_assessments (tenant_id, prospect_id, idempotency_key)
WHERE assessment_type = 'manual_review';

CREATE TABLE prospect_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
  prospect_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'apollo'),
  input_fingerprint TEXT NOT NULL,
  provider_request_id TEXT,
  provider_organization_id TEXT,
  provider_person_id TEXT,
  person_name TEXT,
  person_title TEXT,
  email TEXT,
  provider_email_status TEXT,
  credits_consumed INTEGER CHECK (credits_consumed IS NULL OR credits_consumed >= 0),
  status TEXT NOT NULL CHECK (status IN ('verified','unverified','no_match','suppressed','failed')),
  match_evidence JSONB NOT NULL DEFAULT '{}',
  provider_payload JSONB,
  provider_payload_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prospect_contacts_input_key UNIQUE (tenant_id, prospect_id, provider, input_fingerprint),
  CONSTRAINT fk_prospect_contacts_prospect_tenant
    FOREIGN KEY (tenant_id, prospect_id) REFERENCES business_prospects(tenant_id, id)
);
```

Copy the same definitions into `database/schema.sql` and add indexes on run/status, route/status, assessment lookup, and contact lookup.

- [ ] **Step 4: Add exact Drizzle mappings**

Export `discoveryRuns`, `businessProspects`, `prospectAssessments`, and `prospectContacts` from `src/db/schema.ts`. Map every SQL column; do not omit tenant IDs or provider evidence JSON.

- [ ] **Step 5: Run focused schema tests**

Run:

```powershell
python -m pytest services/pipeline/tests/test_schema.py -q
Set-Location services/dashboard; npm test -- src/db/schema.test.ts
```

Expected: PASS.

- [ ] **Step 6: Request database review and commit**

Invoke `db-reviewer`, address every finding, rerun the focused tests, then:

```powershell
git add database services/pipeline/tests/test_schema.py services/dashboard/src/db/schema.ts services/dashboard/src/db/schema.test.ts
git commit -m "feat: add prospect staging schema"
```

---

### Task 3: Create And Poll An Outscraper Discovery Run

**Files:**
- Create: `services/pipeline/src/clients/outscraper_client.py`
- Create: `services/pipeline/tests/test_outscraper_client.py`
- Create: `services/pipeline/src/workers/discover_prospects.py`
- Create: `services/pipeline/tests/test_discover_prospects.py`
- Modify: `services/pipeline/src/db/queries.py`
- Modify: `services/pipeline/tests/test_queries.py`
- Modify: `services/pipeline/src/pipeline_queue/definitions.py`
- Modify: `services/pipeline/src/workers/orchestrator.py`
- Modify: `services/pipeline/tests/test_orchestrator.py`
- Modify: `services/dashboard/src/db/queries.ts`
- Modify: `services/dashboard/src/db/queries.test.ts`
- Create: `services/dashboard/src/app/actions/prospect-run-actions-core.ts`
- Create: `services/dashboard/src/app/actions/prospect-run-actions.ts`
- Create: `services/dashboard/src/app/actions/prospect-run-actions.test.ts`
- Modify: `services/dashboard/src/queue/pipeline.ts`
- Modify: `services/dashboard/src/queue/pipeline.test.ts`

- [ ] **Step 1: Write failing provider and worker tests**

Cover submission, pending poll, success, failure, malformed data, and secret-safe errors. The core fixture is:

```python
OUTSCRAPER_SUCCESS = {
    "id": "request-123",
    "status": "Success",
    "data": [[{
        "place_id": "ChIJ-test",
        "name": "Northside Plumbing",
        "site": "https://northside.example",
        "phone": "+61 7 3000 0000",
        "full_address": "Brisbane QLD 4000",
        "city": "Brisbane",
        "state": "Queensland",
        "category": "Plumber",
        "subtypes": "Plumber, Drainage service",
        "rating": 4.6,
        "reviews": 42,
        "business_status": "OPERATIONAL",
        "location_link": "https://google.example/place",
    }]],
}
```

Assert that success persists the business before enqueueing normalization and that pending schedules `poll_outscraper` 30 seconds later.

- [ ] **Step 2: Run tests to verify they fail**

```powershell
python -m pytest services/pipeline/tests/test_outscraper_client.py services/pipeline/tests/test_discover_prospects.py services/pipeline/tests/test_orchestrator.py -q
```

Expected: FAIL because the client, workers, job types, and handlers do not exist.

- [ ] **Step 3: Implement the Outscraper client**

Use this public contract:

```python
@dataclass(frozen=True)
class OutscraperRequest:
    request_id: str
    status: Literal["Pending", "Success", "Failure"]
    data: list[dict[str, object]]
```

Expose `submit_google_maps_search(queries, total_limit)` and `get_request(request_id)`, both returning `OutscraperRequest`. Call `GET https://api.outscraper.com/google-maps-search` with repeated `query` params, `limit=100`, `totalLimit=500`, `dropDuplicates=true`, `region=AU`, `language=en`, `async=true`, and an explicit `fields` list. Authenticate with `X-API-KEY`. Poll `GET /requests/{request_id}` with `flat=true`. Flatten nested success arrays but retain malformed object records. The worker stores any record without `place_id` as `status='failed'`, `outcome_reason='missing_place_id'`, and `source_business_id='invalid:' + sha256(canonical_json_payload)` so provider quality remains measurable and the record cannot become eligible.

- [ ] **Step 4: Add run queries and worker handlers**

Add `ProspectStore` methods for tenant-scoped run fetch/update and replay-safe source persistence. The state transition helper must enforce:

```python
_RUN_PREDECESSORS = {
    "submitted": ("created",),
    "polling": ("submitted", "polling"),
    "persisted": ("submitted", "polling"),
    "processing": ("persisted",),
    "review_ready": ("processing",),
    "completed": ("review_ready",),
}
```

The worker uses a fixed server-side query set generated from the three approved categories and five approved Greater Brisbane localities. It does not accept arbitrary browser-provided Outscraper queries.

- [ ] **Step 5: Register jobs and production dependencies**

Add these enum values and pipeline registrations:

```python
START_DISCOVERY = "start_discovery"
POLL_OUTSCRAPER = "poll_outscraper"
NORMALIZE_PROSPECTS = "normalize_prospects"
ASSESS_PROSPECTS = "assess_prospects"
ENRICH_PROSPECT_CONTACTS = "enrich_prospect_contacts"
PREPARE_SHADOW_REVIEW = "prepare_shadow_review"
PURGE_PROSPECT_DATA = "purge_prospect_data"
```

Configure `START_DISCOVERY` for three attempts and `POLL_OUTSCRAPER` for five transport attempts. Provider `Pending` is not a failed attempt; it enqueues a delayed poll with incremented `poll_count`. Stop after 30 polls with failure code `outscraper_timeout`.

- [ ] **Step 6: Add the authenticated start action**

The testable core creates a `shadow_mode=true` run using one constant preset:

```typescript
export const GREATER_BRISBANE_PLUMBERS_V1 = {
  key: "greater-brisbane-plumbers-v1",
  categories: ["Plumber", "Drainage service", "Gas fitter"],
  localities: ["Brisbane", "Logan", "Ipswich", "Moreton Bay", "Redlands"],
  region: "AU",
  totalLimit: 500,
} as const;
```

The authenticated wrapper derives `tenantId` and operator identity server-side, creates the run through `db/queries.ts`, and enqueues only `{job_type, tenant_id, discovery_run_id}`. A database unique-conflict returns the operator-safe message `A discovery run is already active.`

- [ ] **Step 7: Run focused tests**

```powershell
python -m pytest services/pipeline/tests/test_outscraper_client.py services/pipeline/tests/test_discover_prospects.py services/pipeline/tests/test_queries.py services/pipeline/tests/test_orchestrator.py -q
Set-Location services/dashboard; npm test -- src/db/queries.test.ts src/queue/pipeline.test.ts src/app/actions/prospect-run-actions.test.ts
```

Expected: PASS.

- [ ] **Step 8: Request database review and commit**

Invoke `db-reviewer`, address findings, rerun tests, then:

```powershell
git add services/pipeline services/dashboard/src/db services/dashboard/src/queue services/dashboard/src/app/actions
git commit -m "feat: submit and poll Outscraper discovery runs"
```

---

### Task 4: Normalize Businesses And Deliver Route A End To End

**Files:**
- Create: `services/pipeline/src/prospects/__init__.py`
- Create: `services/pipeline/src/prospects/normalization.py`
- Create: `services/pipeline/tests/test_prospect_normalization.py`
- Create: `services/pipeline/src/workers/normalize_prospects.py`
- Create: `services/pipeline/tests/test_normalize_prospects.py`
- Modify: `services/pipeline/src/db/queries.py`
- Modify: `services/pipeline/tests/test_queries.py`
- Modify: `services/pipeline/src/workers/orchestrator.py`

- [ ] **Step 1: Write the failing normalization matrix**

Parameterize cases for operational plumber, permanently closed, wrong category, outside region, social-only, directory, marketplace, no URL, duplicate phone/domain/name-address, franchise, four locations, low rating, and ambiguous duplicate.

Use this result type:

```python
@dataclass(frozen=True)
class NormalizationDecision:
    status: Literal["normalized", "held", "rejected"]
    route: Literal["A"] | None
    website_ownership: Literal[
        "none", "social", "directory", "marketplace", "placeholder", "inaccessible", "owned"
    ] | None
    reason: str
```

Expected reason codes include `permanently_closed`, `wrong_category`, `outside_region`, `franchise`, `too_many_locations`, `reputation_risk`, `ambiguous_duplicate`, and `no_owned_website`.

- [ ] **Step 2: Run tests to verify they fail**

```powershell
python -m pytest services/pipeline/tests/test_prospect_normalization.py services/pipeline/tests/test_normalize_prospects.py -q
```

Expected: FAIL because normalization does not exist.

- [ ] **Step 3: Implement pure normalization**

Normalize names with Unicode normalization, case folding, punctuation removal, and whitespace collapse. Normalize Australian phones to a stable digit form. Normalize owned domains with `urllib.parse`, removing `www`, ports, paths, query strings, and fragments.

Use explicit host sets for social/directory/marketplace classification. Keep those sets in code with tests; do not use fuzzy AI classification. Franchise detection uses a versioned exact normalized-name/domain set plus deduplicated location count. Exact cross-run reporting may use source and Place ID; V1 does not persist fuzzy cross-run canonical links. Unrecognized ambiguous cases are held.

- [ ] **Step 4: Implement replay-safe batch normalization**

Fetch discovered prospects by `(tenant_id, discovery_run_id, status='discovered')`, write decisions one record at a time through `ProspectStore`, record failures per prospect, derive run aggregates from stored rows, and enqueue `assess_prospects` once. Route A records may move directly to `assessed`; owned-site records remain `normalized` for Task 5.

- [ ] **Step 5: Prove Route A isolation**

Add a negative test using fakes that asserts the worker never calls a lead repository, preview queue, outreach queue, or Instantly client. Assert a social-only business is stored as Route A with `website_ownership='social'`.

- [ ] **Step 6: Run tests and database review**

```powershell
python -m pytest services/pipeline/tests/test_prospect_normalization.py services/pipeline/tests/test_normalize_prospects.py services/pipeline/tests/test_queries.py services/pipeline/tests/test_orchestrator.py -q
```

Expected: PASS. Invoke `db-reviewer` and address findings.

- [ ] **Step 7: Commit**

```powershell
git add services/pipeline/src/prospects services/pipeline/src/workers/normalize_prospects.py services/pipeline/src/workers/orchestrator.py services/pipeline/src/db/queries.py services/pipeline/tests
git commit -m "feat: normalize prospects and classify Route A"
```

---

### Task 5: Score Owned Websites And Deliver Route B End To End

**Files:**
- Create: `services/pipeline/src/clients/prospect_website_audit.py`
- Create: `services/pipeline/tests/test_prospect_website_audit.py`
- Create: `services/pipeline/src/prospects/website_scoring.py`
- Create: `services/pipeline/tests/test_website_scoring.py`
- Create: `services/pipeline/src/workers/assess_prospects.py`
- Create: `services/pipeline/tests/test_assess_prospects.py`
- Modify: `services/pipeline/src/db/queries.py`
- Modify: `services/pipeline/tests/test_queries.py`
- Modify: `services/pipeline/src/workers/orchestrator.py`

- [ ] **Step 1: Write failing audit and score tests**

Represent every rule as evidence, not just a boolean aggregate:

```python
from collections.abc import Sequence

@dataclass(frozen=True)
class RuleEvidence:
    key: str
    passed: bool
    awarded: int
    available: int
    evidence: str

@dataclass(frozen=True)
class WebsiteAssessment:
    score: int
    route: Literal["B", "manual_review", "healthy"]
    category_scores: dict[str, int]
    rules: Sequence[RuleEvidence]
    forced_route_reason: str | None
```

Test all point allocations from the design spec, totals 59/60/69/70, forced Route B with no usable contact path, redirect to social, placeholder content, first timeout followed by success, and two independent failures becoming Route A `inaccessible`.

- [ ] **Step 2: Run tests to verify they fail**

```powershell
python -m pytest services/pipeline/tests/test_prospect_website_audit.py services/pipeline/tests/test_website_scoring.py services/pipeline/tests/test_assess_prospects.py -q
```

Expected: FAIL because the dedicated auditor, scorer, and worker do not exist.

- [ ] **Step 3: Build a dedicated prospect auditor**

Do not expand `PlaywrightAuditor` in a way that changes existing lead enrichment behavior. The new auditor uses a mobile viewport and returns the exact raw signals required by `website-health-v1`: final URL/status, HTTPS, horizontal overflow, DOM-content time, title, H1, tel link, mobile-visible primary CTA, contact form/mailto, emergency/hours text, displayed phone, locality/suburb evidence, NAP evidence, LocalBusiness JSON-LD, credentials, testimonials, project images, about/team, privacy/contact details, service sections/pages, service terms, meaningful copy, and FAQ/helpful content.

The auditor does not submit forms or click phone/email links.

- [ ] **Step 4: Implement the deterministic scorer**

Encode the exact 25/25/20/15/15 matrix from the design spec as immutable rule definitions. Assert at module load that available points total 100. No Claude client is accepted by the scoring function.

- [ ] **Step 5: Persist versioned automated assessments**

For each owned-site prospect, audit, score, insert one `automated` assessment with version `website-health-v1`, and update the prospect route/status. The worker continues after prospect-level failures and enqueues contact enrichment after all eligible records have terminal assessment outcomes.

- [ ] **Step 6: Run tests and database review**

```powershell
python -m pytest services/pipeline/tests/test_prospect_website_audit.py services/pipeline/tests/test_website_scoring.py services/pipeline/tests/test_assess_prospects.py services/pipeline/tests/test_queries.py services/pipeline/tests/test_orchestrator.py -q
```

Expected: PASS. Invoke `db-reviewer` and address findings.

- [ ] **Step 7: Commit**

```powershell
git add services/pipeline/src/clients/prospect_website_audit.py services/pipeline/src/prospects/website_scoring.py services/pipeline/src/workers/assess_prospects.py services/pipeline/src/db/queries.py services/pipeline/src/workers/orchestrator.py services/pipeline/tests
git commit -m "feat: score owned websites for Route B"
```

---

### Task 6: Resolve Apollo Organizations, Owners, And Verified Emails

**Files:**
- Create: `services/pipeline/src/clients/apollo_client.py`
- Create: `services/pipeline/tests/test_apollo_client.py`
- Create: `services/pipeline/src/workers/enrich_prospect_contacts.py`
- Create: `services/pipeline/tests/test_enrich_prospect_contacts.py`
- Modify: `services/pipeline/src/db/queries.py`
- Modify: `services/pipeline/tests/test_queries.py`
- Modify: `services/pipeline/src/workers/orchestrator.py`

- [ ] **Step 1: Write failing three-step resolution tests**

Test Route B domain organization match, Route A name/location match, ambiguous organization, no organization, no owner, verified owner, unverified enrichment response, duplicate input fingerprint, known unsubscribed email, 401/403 capability failure, 429 retry, and secret-safe errors.

Use this accepted result contract:

```python
@dataclass(frozen=True)
class ApolloVerifiedContact:
    organization_id: str
    person_id: str
    person_name: str
    person_title: str
    email: str
    email_status: Literal["verified"]
    evidence: dict[str, object]
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
python -m pytest services/pipeline/tests/test_apollo_client.py services/pipeline/tests/test_enrich_prospect_contacts.py -q
```

Expected: FAIL because the Apollo adapter and worker do not exist.

- [ ] **Step 3: Implement the Apollo adapter**

Use these official endpoints:

```text
POST /api/v1/mixed_companies/search
POST /api/v1/mixed_people/api_search
POST /api/v1/people/match
```

For People Search use `organization_ids[]`, `person_seniorities[]=owner|founder|c_suite|partner`, `contact_email_status[]=verified`, `page=1`, and `per_page=10`. Rank exact `owner`, then `founder`, `partner`, and `c_suite`; ties are unresolved unless one result has a stronger exact organization match. Enrich by `id`, with all reveal/waterfall options false. A 403 from People Search becomes `apollo_master_key_required`, not `no_match`.

- [ ] **Step 4: Implement credit-safe enrichment**

Compute SHA-256 over normalized organization inputs, route, scoring version, and Apollo strategy version. If the same `(tenant, prospect, provider, fingerprint)` exists, reuse it. Resolve only A/B prospects. Before storing `verified`, check tenant-scoped existing leads and outreach sends for the same normalized email; existing, bounced, unsubscribed, or archived contacts become `suppressed`.

- [ ] **Step 5: Keep personal and phone enrichment disabled**

Tests must inspect outgoing request parameters and assert:

```python
assert request.get("reveal_personal_emails") in (None, False)
assert request.get("reveal_phone_number") in (None, False)
assert request.get("run_waterfall_email") in (None, False)
assert request.get("run_waterfall_phone") in (None, False)
```

- [ ] **Step 6: Run tests and database review**

```powershell
python -m pytest services/pipeline/tests/test_apollo_client.py services/pipeline/tests/test_enrich_prospect_contacts.py services/pipeline/tests/test_queries.py services/pipeline/tests/test_orchestrator.py -q
```

Expected: PASS. Invoke `db-reviewer` and address findings.

- [ ] **Step 7: Commit**

```powershell
git add services/pipeline/src/clients/apollo_client.py services/pipeline/src/workers/enrich_prospect_contacts.py services/pipeline/src/db/queries.py services/pipeline/src/workers/orchestrator.py services/pipeline/tests
git commit -m "feat: resolve verified Apollo prospect contacts"
```

---

### Task 7: Add The Authenticated Shadow Review Workbench

**Files:**
- Modify: `services/dashboard/src/db/queries.ts`
- Modify: `services/dashboard/src/db/queries.test.ts`
- Create: `services/dashboard/src/lib/prospect-list-params.ts`
- Create: `services/dashboard/src/lib/prospect-list-params.test.ts`
- Create: `services/dashboard/src/app/(app)/prospects/page.tsx`
- Create: `services/dashboard/src/app/(app)/prospects/page.test.tsx`
- Create: `services/dashboard/src/app/(app)/prospects/loading.tsx`
- Create: `services/dashboard/src/app/(app)/prospects/error.tsx`
- Create: `services/dashboard/src/app/api/prospects/route.ts`
- Create: `services/dashboard/src/app/api/prospects/route.test.ts`
- Create: `services/dashboard/src/components/ProspectsWorkbench.tsx`
- Create: `services/dashboard/src/components/ProspectsWorkbench.test.tsx`
- Create: `services/dashboard/src/components/ProspectFilters.tsx`
- Create: `services/dashboard/src/components/ProspectFilters.test.tsx`
- Create: `services/dashboard/src/components/ProspectTable.tsx`
- Create: `services/dashboard/src/components/ProspectTable.test.tsx`
- Create: `services/dashboard/src/components/ProspectQuickPanel.tsx`
- Create: `services/dashboard/src/components/ProspectQuickPanel.test.tsx`
- Create: `services/dashboard/src/components/ProspectRunSummary.tsx`
- Create: `services/dashboard/src/components/ProspectRunSummary.test.tsx`
- Create: `services/dashboard/src/components/ShadowModeBanner.tsx`
- Modify: `services/dashboard/src/components/Sidebar.tsx`
- Modify: `services/dashboard/src/components/AppShell.test.tsx`
- Modify: `services/dashboard/src/auth/middleware.ts`
- Modify: `services/dashboard/src/auth/middleware.test.ts`
- Modify: `services/dashboard/src/app/globals.css`

- [ ] **Step 1: Write failing query, auth, and UI tests**

Require all joined table predicates to include `tenant_id`. API tests cover 401, 403, missing tenant configuration, invalid filters, and rejection of client-supplied tenant IDs. Component tests cover loading, empty, partial processing, provider failure, A, B, manual, healthy, held, rejected, unresolved contact, score evidence, mobile drawer, and Shadow Mode visibility.

- [ ] **Step 2: Run tests to verify they fail**

```powershell
Set-Location services/dashboard
npm test -- src/db/queries.test.ts src/lib/prospect-list-params.test.ts src/app/api/prospects/route.test.ts 'src/app/(app)/prospects/page.test.tsx' src/components/ProspectsWorkbench.test.tsx
```

Expected: FAIL because the prospect dashboard surface does not exist.

- [ ] **Step 3: Implement tenant-scoped query builders**

Return a typed row containing prospect identity, route/status, website/rating fields, latest automated assessment, latest manual assessment, and latest contact. Every subquery/join includes both record identity and tenant identity. Add separate aggregate query builders for the run summary; do not calculate authoritative counts in the browser.

- [ ] **Step 4: Implement server page and authenticated API**

`/prospects` derives the tenant with the existing helper, loads the latest run plus first page, and renders the workbench. `/api/prospects` authenticates explicitly and derives tenant server-side. Add `/api/prospects` to `HANDLER_AUTH_ROUTES` so unauthenticated requests receive JSON 401 behavior.

- [ ] **Step 5: Build the workbench**

Use a compact operational layout matching the Leads workbench. Include:

- persistent `Shadow mode` status banner
- run counts and last provider status
- route/status/contact/search filters
- desktop table and mobile list
- selectable quick panel with Google and owned-site external links
- deterministic category scores and per-rule evidence
- manual/AI summary visually separated, with deterministic evidence first
- actionable loading, empty, partial, and error states

Do not render lead status, campaign, send, pause, preview, promote, or approve-for-outreach controls.

- [ ] **Step 6: Add navigation without a fabricated badge**

Add `{ href: "/prospects", label: "Prospects", icon: ScanSearch }` to the sidebar. Do not add a hardcoded review-count badge.

- [ ] **Step 7: Run focused tests, lint, and security review**

```powershell
Set-Location services/dashboard
npm test -- src/db/queries.test.ts src/lib/prospect-list-params.test.ts src/app/api/prospects/route.test.ts 'src/app/(app)/prospects/page.test.tsx' src/components/ProspectsWorkbench.test.tsx src/components/ProspectTable.test.tsx src/components/ProspectQuickPanel.test.tsx src/auth/middleware.test.ts
npm run lint
```

Expected: PASS and clean lint. Invoke `db-reviewer` and `security-reviewer`; address findings and rerun tests.

- [ ] **Step 8: Commit**

```powershell
git add services/dashboard/src
git commit -m "feat: add prospect shadow review workbench"
```

---

### Task 8: Add Deterministic Sampling, Manual Review, Metrics, And Export

**Files:**
- Create: `services/pipeline/src/prospects/sampling.py`
- Create: `services/pipeline/tests/test_prospect_sampling.py`
- Create: `services/pipeline/src/workers/prepare_shadow_review.py`
- Create: `services/pipeline/tests/test_prepare_shadow_review.py`
- Modify: `services/pipeline/src/db/queries.py`
- Modify: `services/pipeline/tests/test_queries.py`
- Create: `services/dashboard/src/app/actions/prospect-review-actions-core.ts`
- Create: `services/dashboard/src/app/actions/prospect-review-actions.ts`
- Create: `services/dashboard/src/app/actions/prospect-review-actions.test.ts`
- Create: `services/dashboard/src/app/api/prospects/export/route.ts`
- Create: `services/dashboard/src/app/api/prospects/export/route.test.ts`
- Modify: `services/dashboard/src/db/queries.ts`
- Modify: `services/dashboard/src/db/queries.test.ts`
- Modify: `services/dashboard/src/components/ProspectQuickPanel.tsx`
- Modify: `services/dashboard/src/components/ProspectQuickPanel.test.tsx`
- Modify: `services/dashboard/src/components/ProspectRunSummary.tsx`
- Modify: `services/dashboard/src/components/ProspectRunSummary.test.tsx`

- [ ] **Step 1: Write failing deterministic-sample tests**

Use this stable ordering function:

```python
def sample_key(run_id: UUID, prospect_id: UUID, cohort: str) -> str:
    return hashlib.sha256(f"{run_id}:{prospect_id}:{cohort}".encode()).hexdigest()
```

Test exactly 20 A, 20 B, and 20 healthy/rejected records; stable replays; changed run ID; persisted sample flags; and insufficient cohorts that select all available records and fail the gate.

- [ ] **Step 2: Run tests to verify they fail**

```powershell
python -m pytest services/pipeline/tests/test_prospect_sampling.py services/pipeline/tests/test_prepare_shadow_review.py -q
Set-Location services/dashboard; npm test -- src/app/actions/prospect-review-actions.test.ts src/app/api/prospects/export/route.test.ts
```

Expected: FAIL because sampling, review actions, and export do not exist.

- [ ] **Step 3: Persist the validation sample**

Persist `validation_sample=true` and `validation_cohort` on the selected prospect snapshots in the same tenant-scoped transaction. Do not recompute membership in the dashboard. When a cohort has fewer than 20 records, record `insufficient_sample` in run failure detail while keeping the run reviewable.

- [ ] **Step 4: Add append-only manual review actions**

Validate this input server-side:

```typescript
type ManualReviewInput = {
  prospectId: string;
  idempotencyKey: string;
  decision: "correct" | "wrong_route" | "ineligible" | "needs_investigation";
  correctedRoute?: "A" | "B" | "manual_review" | "healthy";
  note?: string;
};
```

`wrong_route` requires `correctedRoute`; other decisions reject it. `idempotencyKey` is a UUID generated once when the review form is opened and reused by retries. Notes are trimmed and limited to 1,000 characters. The wrapper derives tenant and reviewer UUID from the authenticated session. The reviewer UUID is the Supabase Auth subject and deliberately has no application-table foreign key because PrinterIQ has no tenant-owned operator table; it is never accepted from the browser. Insert a new `manual_review` assessment; a repeated idempotency key returns the existing assessment and never duplicates the audit event. Tests must prove a Run A prospect cannot be reviewed through a Run B assessment.

- [ ] **Step 5: Calculate authoritative success metrics**

Query and display usable yield, A/B yield, verified-email match by route, processing-failure rate, eligibility precision, route precision, provider usage, and gate pass/fail. Precision denominators include only reviewed sample records with a decisive manual outcome; `needs_investigation` keeps the gate incomplete. If Outscraper spend or Apollo credits are unavailable from provider responses, show `Cost reconciliation required` and keep the cost gate incomplete until an operator-recorded usage value is stored; never estimate an authoritative cost from pricing-page text.

- [ ] **Step 6: Add authenticated CSV export**

Export only the selected run and tenant. Include business identity, source profile, website, automated route/score/reason, contact status, manual decision/correction, and timestamps. Exclude raw provider payloads, secrets, internal error stacks, personal phone enrichment, and non-selected tenants. Return `text/csv; charset=utf-8` with an attachment filename containing the run ID.

- [ ] **Step 7: Run tests and reviewer agents**

```powershell
python -m pytest services/pipeline/tests/test_prospect_sampling.py services/pipeline/tests/test_prepare_shadow_review.py services/pipeline/tests/test_queries.py -q
Set-Location services/dashboard
npm test -- src/db/queries.test.ts src/app/actions/prospect-review-actions.test.ts src/app/api/prospects/export/route.test.ts src/components/ProspectQuickPanel.test.tsx src/components/ProspectRunSummary.test.tsx
npm run lint
```

Expected: PASS. Invoke `db-reviewer` and `security-reviewer`; address findings.

- [ ] **Step 8: Commit**

```powershell
git add services/pipeline services/dashboard/src
git commit -m "feat: add shadow validation and review metrics"
```

---

### Task 9: Add Retention, Hard Isolation Tests, And Pilot Runbook

**Files:**
- Create: `services/pipeline/src/workers/purge_prospect_data.py`
- Create: `services/pipeline/tests/test_purge_prospect_data.py`
- Modify: `services/pipeline/src/db/queries.py`
- Modify: `services/pipeline/tests/test_queries.py`
- Modify: `services/pipeline/src/workers/orchestrator.py`
- Modify: `services/pipeline/tests/test_orchestrator.py`
- Create: `services/pipeline/tests/test_shadow_pipeline_isolation.py`
- Modify: `docs/operator-runbook.md`

- [ ] **Step 1: Write failing retention and isolation tests**

Retention tests use a fixed clock and assert:

- Outscraper and Apollo payload JSON is nulled after 30 days.
- Held, rejected, and unresolved prospects are deleted after 90 days unless referenced by an active review.
- Tenant A cleanup cannot alter Tenant B.
- Reviews needed for an incomplete validation sample are retained.

The full isolation test runs every prospect handler with fakes and asserts zero calls to:

```python
for forbidden in (lead_store, preview_queue, outreach_store, instantly_client):
    forbidden.assert_not_called()
```

Also assert the database contains no prospect-created `leads`, `website_previews`, or `outreach_sends`.

- [ ] **Step 2: Run tests to verify they fail**

```powershell
python -m pytest services/pipeline/tests/test_purge_prospect_data.py services/pipeline/tests/test_shadow_pipeline_isolation.py -q
```

Expected: FAIL because purge behavior and full isolation coverage do not exist.

- [ ] **Step 3: Implement tenant-scoped purge behavior**

Add `PURGE_PROSPECT_DATA` as a run-level job plus a `python -m src.workers.purge_prospect_data --enqueue` entry point that loads `TENANT_ID` and enqueues only the tenant-scoped cleanup payload. It reads retention days from bounded configuration and nulls expired provider payloads first. It may delete contacts, assessments, and terminal non-promoted snapshots only when the parent discovery run has status `completed`; `review_ready` and other unfinished runs retain all review evidence. Delete children before snapshots, and delete a discovery run only after it has no retained snapshots. Do not cascade-delete existing leads.

- [ ] **Step 4: Write the operator runbook**

Document:

- prerequisite checks for database, Redis, Outscraper key, Apollo master-key capability, and provider credit limits
- creating exactly one Greater Brisbane plumbing run from `/prospects`
- observing run and queue status
- safe retry and abort behavior
- interpreting A/B, hold, reject, unresolved, and provider failure outcomes
- running retention manually
- exporting the review cohort
- the explicit prohibition on live outreach
- the success-gate go/no-go checklist

- [ ] **Step 5: Run focused tests and database review**

```powershell
python -m pytest services/pipeline/tests/test_purge_prospect_data.py services/pipeline/tests/test_shadow_pipeline_isolation.py services/pipeline/tests/test_queries.py services/pipeline/tests/test_orchestrator.py -q
```

Expected: PASS. Invoke `db-reviewer` and address findings.

- [ ] **Step 6: Commit**

```powershell
git add services/pipeline docs/operator-runbook.md
git commit -m "feat: enforce prospect retention and shadow isolation"
```

---

### Task 10: Full Verification And Implementation Handoff

**Files:**
- Modify only files required to fix verification findings
- Create a dated handoff under `docs/superpowers/handoffs/` if implementation is paused before the controlled live-provider pilot

- [ ] **Step 1: Run the complete pipeline verification**

```powershell
Set-Location services/pipeline
python -m pytest -q
python -m ruff check src tests
python -m mypy src
```

Expected: all tests pass; Ruff and mypy report no errors.

- [ ] **Step 2: Run the complete dashboard verification**

```powershell
Set-Location services/dashboard
npm test
npm run lint
npm run build
```

Expected: all tests pass; lint is clean; production build succeeds.

- [ ] **Step 3: Run schema and migration verification**

Apply migrations to an isolated test database, run the schema suites, attempt cross-tenant inserts/reads, attempt a second active run for one tenant, and verify all fail closed as designed. Do not apply the migration to production in this task.

- [ ] **Step 4: Run browser verification**

Start the dashboard locally and verify `/prospects` at desktop and mobile widths. Confirm loading, empty, partial, A, B, held, rejected, provider-error, evidence drawer, review form, metrics, and export. Confirm there is no horizontal overflow and no lead/outreach control on any prospect state.

- [ ] **Step 5: Request final reviews**

Invoke:

- `db-reviewer` for final tenant and migration audit
- `security-reviewer` for authenticated routes, provider-secret handling, export, and review actions
- `requesting-code-review` for the complete branch

Address findings and repeat affected verification.

- [ ] **Step 6: Produce a no-provider smoke proof**

Run the full flow with fixture clients and capture counts proving:

```text
discovery run -> persisted prospects -> A/B assessments -> contact outcomes -> review_ready
leads delta = 0
website_previews delta = 0
outreach_sends delta = 0
Instantly calls = 0
```

- [ ] **Step 7: Commit verification fixes and handoff**

Review `git status --short`, confirm every tracked change belongs to verification, then run:

```powershell
git add -u
git commit -m "test: verify Outscraper shadow pilot"
```

If the implementation pauses and creates a new handoff, add that single handoff path explicitly in a separate `git add` before committing. Never stage unrelated files.

The handoff must link this plan, the design spec, the superseding ADR, exact verification output, remaining provider credential prerequisites, and the next approved action. It must state that no live provider run or production deployment has occurred unless separately verified.

---

## Later `$to-issues` Breakdown

When the user invokes `$to-issues`, regroup the implementation tasks into these tracer-bullet candidates and quiz the user before publishing:

1. Governance plus start/poll discovery run and dashboard status.
2. Route A from persisted Outscraper record through dashboard evidence.
3. Route B from owned-site audit through dashboard score evidence.
4. Apollo organization/owner/verified-email resolution through dashboard contact state.
5. Reproducible shadow sample, manual review, precision metrics, and export.
6. Retention, isolation proof, and controlled-pilot readiness.

Do not publish issues during plan creation. Do not deploy implementation agents until the issue breakdown is approved and published.

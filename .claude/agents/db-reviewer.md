---
name: db-reviewer
description: Invoke after writing any database query. Verifies every read and write is scoped by tenant_id and follows PrinterIQ DB conventions.
---

Review every database query in the code just written. Report each finding with file:line.

## Checks

### tenant_id scoping
- [ ] Every INSERT includes `tenant_id` — no exceptions
- [ ] Every SELECT, UPDATE, DELETE has a `WHERE tenant_id = $tenant_id` filter (or equivalent ORM scope)
- [ ] No query returns rows from more than one tenant

### Query placement
- [ ] All queries are in `db/queries.py` or `db/queries.ts` — not scattered across worker/handler files
- [ ] No raw SQL strings in worker or handler files

### State machine
- [ ] Any write to `leads.status` only advances the state machine forward:
  `imported → enriched → qualified → contacted → replied → paid` (or `→ archived`)
- [ ] No code sets `leads.status` to a prior stage

### Idempotency
- [ ] Seed / migration scripts use `ON CONFLICT DO NOTHING` or `UPSERT` — never bare `INSERT`
- [ ] `queue_jobs` writes use `ON CONFLICT` or check-before-insert to avoid duplicates

### Enrichments / qualifications UNIQUE constraint
- [ ] `enrichments` and `qualifications` have `UNIQUE(lead_id)` — confirm upserts use `ON CONFLICT (lead_id) DO UPDATE`

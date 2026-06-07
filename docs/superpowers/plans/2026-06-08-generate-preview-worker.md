# Generate Preview Worker Implementation Plan

> **For agentic workers:** Use executing-plans or dispatching-parallel-agents to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `generate_preview` pipeline worker that renders a personalized preview site before outreach is scheduled.

**Architecture:** `qualify_lead` will enqueue `GENERATE_PREVIEW` instead of `SCHEDULE_OUTREACH` for qualified leads. The new worker will fetch tenant-scoped lead data, select a trade template, call `preview-personalise-v1`, render the current 20-token HTML contract, write `{lead_id}.html`, insert `website_previews`, then enqueue `SCHEDULE_OUTREACH` with `preview_url`.

**Tech Stack:** Python 3.12, pytest, async worker protocols, Postgres query helpers in `services/pipeline/src/db/queries.py`, existing Claude wrapper and queue abstractions.

---

## Contract Corrections

Issue #38 is stale in two places. Implement the approved contract from `docs/superpowers/specs/2026-05-29-website-preview-design.md`:

- Use `https://preview.presciaiq.com/{lead_id}`, not `https://preview.printeriq.com/{lead_id}`.
- Do not use `tagline` or `top_weakness` in the preview prompt output.
- Validate `about_blurb`, `founder_name`, `year_founded`, and exactly 6 service objects with `title` and `description`.
- Render all 20 tokens already enforced by `services/pipeline/tests/test_preview_templates.py`.

## File Structure

- Modify: `services/pipeline/src/pipeline_queue/definitions.py`
  - Add `GENERATE_PREVIEW` to `JobType` and `PIPELINE_JOB_TYPES`.
- Modify: `services/pipeline/src/clients/claude_client.py`
  - Add `preview-personalise-v1` to `_MODEL_MAP` with `claude-haiku-4-5-20251001`.
- Modify: `services/pipeline/src/workers/qualify.py`
  - Rename the injected downstream queue protocol conceptually from outreach to preview, and enqueue `generate_preview`.
- Create: `services/pipeline/src/workers/generate_preview.py`
  - Own template selection, prompt validation, rendering, disk write, preview insert, and schedule enqueue.
- Modify: `services/pipeline/src/workers/schedule_outreach.py`
  - Pass optional `preview_url` into Instantly custom variables.
- Modify: `services/pipeline/src/workers/orchestrator.py`
  - Register `GENERATE_PREVIEW`, inject dependencies, and rate-limit Claude calls for this worker.
- Modify: `services/pipeline/src/db/queries.py`
  - Add tenant-scoped `insert_website_preview` and `get_website_preview_by_lead_id`; expose methods through `PipelineStore`.
- Create: `services/pipeline/tests/test_generate_preview.py`
  - Worker tests for mapping, validation, render, DB failure, disk failure, enqueue behavior, and tenant scoping via fakes.
- Modify: `services/pipeline/tests/test_qualify.py`
  - Qualified lead now enqueues `generate_preview` with forwarded outreach payload.
- Modify: `services/pipeline/tests/test_schedule_outreach.py`
  - Assert `preview_url` is included in Instantly `custom_variables` when present.
- Modify: `services/pipeline/tests/test_orchestrator.py`
  - Assert handler registration, dependency injection, max attempts, and rate limiter coverage.
- Modify: `services/pipeline/tests/test_outreach_queries.py`
  - Add query tests for website preview insert/get tenant scoping.

---

### Task 1: Queue Job Type and Qualify Routing

**Files:**
- Modify: `services/pipeline/src/pipeline_queue/definitions.py`
- Modify: `services/pipeline/src/workers/qualify.py`
- Modify: `services/pipeline/tests/test_qualify.py`

- [ ] **Step 1: Write failing qualify routing tests**

Update `test_above_threshold_qualifies_lead_calls_sonnet_enqueues_outreach` to expect:

```python
assert outreach_payload["job_type"] == JobType.GENERATE_PREVIEW.value
assert outreach_payload["tenant_id"] == str(TENANT_ID)
assert outreach_payload["lead_id"] == str(LEAD_ID)
assert outreach_payload["campaign_id"] == "campaign-from-env"
assert outreach_payload["channel"] == "email"
assert isinstance(outreach_payload["send_after"], str)
```

Add or update the send-after preservation test to keep the exact forwarded value:

```python
assert queue.jobs[0]["job_type"] == JobType.GENERATE_PREVIEW.value
assert queue.jobs[0]["send_after"] == send_after
```

- [ ] **Step 2: Run RED**

Run:

```powershell
python -m pytest services/pipeline/tests/test_qualify.py -q
```

Expected: FAIL because `JobType.GENERATE_PREVIEW` does not exist or `qualify_lead` still enqueues `schedule_outreach`.

- [ ] **Step 3: Add the job type**

In `services/pipeline/src/pipeline_queue/definitions.py`:

```python
class JobType(StrEnum):
    INGEST_CSV = "ingest_csv"
    ENRICH_LEAD = "enrich_lead"
    QUALIFY_LEAD = "qualify_lead"
    GENERATE_PREVIEW = "generate_preview"
    SCHEDULE_OUTREACH = "schedule_outreach"
    PROCESS_REPLY = "process_reply"
    SEND_REPLY = "send_reply"
    RETRY_CHECKOUT = "retry_checkout"
```

Add it to `PIPELINE_JOB_TYPES`.

- [ ] **Step 4: Route qualified leads to preview generation**

In `qualify_lead`, change the downstream enqueue payload:

```python
await outreach_queue.enqueue(
    {
        "job_type": JobType.GENERATE_PREVIEW.value,
        "tenant_id": str(tenant_id),
        "lead_id": str(lead_id),
        "campaign_id": _campaign_id(payload),
        "channel": str(payload.get("channel", _DEFAULT_CHANNEL)),
        "send_after": _send_after(payload),
    }
)
```

- [ ] **Step 5: Run GREEN**

Run:

```powershell
python -m pytest services/pipeline/tests/test_qualify.py -q
```

Expected: PASS.

---

### Task 2: Website Preview Query Layer

**Files:**
- Modify: `services/pipeline/src/db/queries.py`
- Modify: `services/pipeline/tests/test_outreach_queries.py`

- [ ] **Step 1: Write failing query tests**

Add tests using `RecordingConnection`:

```python
async def test_insert_website_preview_writes_tenant_scoped_metadata() -> None:
    conn = RecordingConnection(fetchval_result=PREVIEW_ID)

    result = await insert_website_preview(
        conn,
        {
            "tenant_id": TENANT_ID,
            "lead_id": LEAD_ID,
            "template_used": "plumbing",
            "preview_url": f"https://preview.presciaiq.com/{LEAD_ID}",
            "personalisation_data": {"about_blurb": "Aqua Flow helps Brisbane homes."},
            "prompt_version": "preview-personalise-v1",
            "cost_usd": Decimal("0.000100"),
        },
    )

    assert result == PREVIEW_ID
    assert "INSERT INTO website_previews" in conn.queries[0]
    assert "tenant_id" in conn.queries[0]
    assert "lead_id" in conn.queries[0]
```

```python
async def test_get_website_preview_by_lead_id_is_tenant_scoped() -> None:
    conn = RecordingConnection(fetchrow_result=None)

    result = await get_website_preview_by_lead_id(
        conn, tenant_id=TENANT_ID, lead_id=LEAD_ID
    )

    assert result is None
    assert "FROM website_previews" in conn.queries[0]
    assert "tenant_id = $1" in conn.queries[0]
    assert "lead_id = $2" in conn.queries[0]
    assert conn.args[0] == (TENANT_ID, LEAD_ID)
```

- [ ] **Step 2: Run RED**

Run:

```powershell
python -m pytest services/pipeline/tests/test_outreach_queries.py -q
```

Expected: FAIL because the functions do not exist.

- [ ] **Step 3: Implement query types and functions**

Add `WebsitePreviewInsert` as a `TypedDict` near the other insert types:

```python
class WebsitePreviewInsert(TypedDict):
    tenant_id: UUID
    lead_id: UUID
    template_used: str
    preview_url: str
    personalisation_data: dict[str, object]
    prompt_version: str
    cost_usd: Decimal
```

Add methods to `PipelineStore`:

```python
async def insert_website_preview(self, preview: WebsitePreviewInsert) -> UUID:
    return await insert_website_preview(self._connection, preview)

async def get_website_preview(
    self, *, tenant_id: UUID, lead_id: UUID
) -> dict[str, object] | None:
    return await get_website_preview_by_lead_id(
        self._connection, tenant_id=tenant_id, lead_id=lead_id
    )
```

Add functions:

```python
async def insert_website_preview(
    connection: DatabaseConnection,
    preview: WebsitePreviewInsert,
) -> UUID:
    raw_id = await connection.fetchval(
        """
        INSERT INTO website_previews (
          tenant_id, lead_id, template_used, preview_url,
          personalisation_data, prompt_version, cost_usd
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
        RETURNING id
        """,
        preview["tenant_id"],
        preview["lead_id"],
        preview["template_used"],
        preview["preview_url"],
        json.dumps(preview["personalisation_data"]),
        preview["prompt_version"],
        preview["cost_usd"],
    )
    if not isinstance(raw_id, UUID):
        raise TypeError(f"Expected website preview UUID, got {type(raw_id).__name__}")
    return raw_id
```

```python
async def get_website_preview_by_lead_id(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    lead_id: UUID,
) -> dict[str, object] | None:
    row = await connection.fetchrow(
        """
        SELECT id, tenant_id, lead_id, template_used, preview_url,
               personalisation_data, prompt_version, cost_usd, generated_at
        FROM website_previews
        WHERE tenant_id = $1
          AND lead_id = $2
        """,
        tenant_id,
        lead_id,
    )
    return dict(row) if row is not None else None
```

- [ ] **Step 4: Run GREEN**

Run:

```powershell
python -m pytest services/pipeline/tests/test_outreach_queries.py -q
```

Expected: PASS.

---

### Task 3: Generate Preview Worker Core

**Files:**
- Create: `services/pipeline/src/workers/generate_preview.py`
- Create: `services/pipeline/tests/test_generate_preview.py`

- [ ] **Step 1: Write failing mapping and validation tests**

Create fakes for lead fetcher, preview repo, queue, and Claude client. Add tests for:

```python
assert select_template_key({"industry": "Plumbing", "vertical": "", "keywords": ""}) == "plumbing"
assert select_template_key({"industry": "Electrical Contractors", "vertical": "", "keywords": ""}) == "electrical"
assert select_template_key({"industry": "Air Conditioning", "vertical": "", "keywords": ""}) == "hvac"
assert select_template_key({"industry": "Concrete Driveways", "vertical": "", "keywords": ""}) == "concreting"
assert select_template_key({"industry": "Landscaping", "vertical": "", "keywords": ""}) == "landscaping"
assert select_template_key({"industry": "Builder", "vertical": "", "keywords": ""}) == "general"
```

Add validation tests:

```python
with pytest.raises(DeadLetterError, match="invalid preview personalisation"):
    parse_personalisation_json("not json")
```

```python
with pytest.raises(DeadLetterError, match="exactly 6"):
    parse_personalisation_json(json.dumps({
        "about_blurb": "Aqua Flow helps Brisbane homes. The team handles urgent jobs.",
        "founder_name": "Sarah Nguyen",
        "year_founded": 2008,
        "services": [{"title": "Blocked Drains", "description": "Fast drain clearing."}],
    }))
```

- [ ] **Step 2: Run RED**

Run:

```powershell
python -m pytest services/pipeline/tests/test_generate_preview.py -q
```

Expected: FAIL because `workers.generate_preview` does not exist.

- [ ] **Step 3: Implement constants, protocols, and pure helpers**

In `generate_preview.py` include:

```python
_PROMPT_VERSION = "preview-personalise-v1"
_PREVIEW_BASE_URL = "https://preview.presciaiq.com"
_TEMPLATE_DIR = Path(__file__).resolve().parents[1] / "templates" / "previews"
_DEFAULT_OUTPUT_DIR = Path("/var/www/previews")
```

Add `TRADE_KEYWORDS`, `DeadLetterError`, `ClaudeResponse`, protocols, `select_template_key`, `parse_personalisation_json`, and `render_preview_html`.

Use `jsonschema.validate` for:

```python
{
    "type": "object",
    "required": ["about_blurb", "founder_name", "year_founded", "services"],
    "properties": {
        "about_blurb": {"type": "string", "minLength": 1},
        "founder_name": {"type": "string", "minLength": 1},
        "year_founded": {"type": "integer", "minimum": 1995, "maximum": 2018},
        "services": {
            "type": "array",
            "minItems": 6,
            "maxItems": 6,
            "items": {
                "type": "object",
                "required": ["title", "description"],
                "properties": {
                    "title": {"type": "string", "minLength": 1},
                    "description": {"type": "string", "minLength": 1},
                },
                "additionalProperties": False,
            },
        },
    },
    "additionalProperties": False,
}
```

- [ ] **Step 4: Run helper tests GREEN**

Run:

```powershell
python -m pytest services/pipeline/tests/test_generate_preview.py -q
```

Expected: helper tests PASS or only the not-yet-written worker tests fail.

---

### Task 4: Generate Preview Worker End-to-End Behavior

**Files:**
- Modify: `services/pipeline/src/workers/generate_preview.py`
- Modify: `services/pipeline/tests/test_generate_preview.py`

- [ ] **Step 1: Write failing worker tests**

Add tests for each of these behaviors:

```python
asyncio.run(generate_preview(
    _payload(campaign_id="campaign", send_after="2026-05-25T09:30:00+10:00"),
    lead_fetcher=lead_fetcher,
    preview_repo=preview_repo,
    schedule_queue=queue,
    claude_client=claude,
    template_dir=template_dir,
    output_dir=output_dir,
))
```

Assert:

```python
assert (output_dir / f"{LEAD_ID}.html").exists()
html = (output_dir / f"{LEAD_ID}.html").read_text()
assert "Aqua Flow Plumbing" in html
assert "Brisbane" in html
assert "+61400000001" in html
assert "{{BUSINESS_NAME}}" not in html
assert preview_repo.inserted[0]["tenant_id"] == TENANT_ID
assert preview_repo.inserted[0]["template_used"] == "plumbing"
assert preview_repo.inserted[0]["preview_url"] == f"https://preview.presciaiq.com/{LEAD_ID}"
assert preview_repo.inserted[0]["prompt_version"] == "preview-personalise-v1"
assert queue.jobs[0]["job_type"] == JobType.SCHEDULE_OUTREACH.value
assert queue.jobs[0]["preview_url"] == f"https://preview.presciaiq.com/{LEAD_ID}"
```

Also add:

- one parameterized end-to-end test for all 6 template keys
- bad JSON first response then good response retries once
- two bad JSON responses raises `DeadLetterError`
- disk write failure does not insert preview and does not enqueue schedule
- DB insert failure writes file but does not enqueue schedule
- lead fetcher receives `tenant_id` and `lead_id`

- [ ] **Step 2: Run RED**

Run:

```powershell
python -m pytest services/pipeline/tests/test_generate_preview.py -q
```

Expected: FAIL because `generate_preview` is incomplete.

- [ ] **Step 3: Implement worker flow**

Worker signature:

```python
async def generate_preview(
    payload: dict[str, object],
    *,
    lead_fetcher: LeadFetcher,
    preview_repo: WebsitePreviewRepository,
    schedule_queue: ScheduleQueue,
    claude_client: ClaudeClient,
    template_dir: Path = _TEMPLATE_DIR,
    output_dir: Path = _DEFAULT_OUTPUT_DIR,
    preview_base_url: str = _PREVIEW_BASE_URL,
) -> None:
```

Flow:

1. Parse `tenant_id` and `lead_id`.
2. Fetch lead with tenant scope.
3. Select template key.
4. Call Claude with `business_name`, `city`, `state`, `industry`, and `keywords`.
5. If invalid, retry once, then raise `DeadLetterError`.
6. Render all 20 tokens.
7. Write `output_dir / f"{lead_id}.html"` with UTF-8.
8. Insert preview metadata.
9. Enqueue schedule payload with `preview_url` plus forwarded `campaign_id`, `channel`, `send_after`.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
python -m pytest services/pipeline/tests/test_generate_preview.py -q
```

Expected: PASS.

---

### Task 5: Schedule Outreach Preview URL Payload

**Files:**
- Modify: `services/pipeline/src/workers/schedule_outreach.py`
- Modify: `services/pipeline/tests/test_schedule_outreach.py`

- [ ] **Step 1: Write failing schedule payload test**

In the existing successful schedule test, add `preview_url` to the payload:

```python
"preview_url": f"https://preview.presciaiq.com/{LEAD_ID}",
```

Assert Instantly custom variables include both names:

```python
assert sent["custom_variables"]["website_preview_url"] == f"https://preview.presciaiq.com/{LEAD_ID}"
assert sent["custom_variables"]["preview_url"] == f"https://preview.presciaiq.com/{LEAD_ID}"
```

Keep `website_preview_url` as the campaign-facing variable configured in Instantly. Also include `preview_url` as an internal alias so downstream tests can assert the payload without campaign-specific naming knowledge.

- [ ] **Step 2: Run RED**

Run:

```powershell
python -m pytest services/pipeline/tests/test_schedule_outreach.py -q
```

Expected: FAIL because preview URL is not forwarded.

- [ ] **Step 3: Add optional preview URL forwarding**

Pass `preview_url=_preview_url(payload)` into `_instantly_payload`. Add:

```python
def _preview_url(payload: dict[str, object]) -> str | None:
    raw_preview_url = payload.get("preview_url")
    if raw_preview_url is None:
        return None
    preview_url = str(raw_preview_url).strip()
    if not preview_url:
        raise ValueError("preview_url cannot be blank")
    return preview_url
```

Inside custom variables:

```python
if preview_url is not None:
    custom_variables["website_preview_url"] = preview_url
    custom_variables["preview_url"] = preview_url
```

- [ ] **Step 4: Run GREEN**

Run:

```powershell
python -m pytest services/pipeline/tests/test_schedule_outreach.py -q
```

Expected: PASS.

---

### Task 6: Orchestrator Registration and Claude Model Map

**Files:**
- Modify: `services/pipeline/src/workers/orchestrator.py`
- Modify: `services/pipeline/src/clients/claude_client.py`
- Modify: `services/pipeline/tests/test_orchestrator.py`

- [ ] **Step 1: Write failing orchestrator tests**

Update expected pipeline jobs to include `JobType.GENERATE_PREVIEW`.

Add production handler injection assertion:

```python
async def generate_preview_handler(payload: dict[str, object], **deps: object) -> None:
    calls.append(("generate_preview", (payload, deps)))
```

Pass `generate_preview_worker=generate_preview_handler` into `build_production_pipeline_handlers` and assert deps include:

```python
{
    "lead_fetcher": pipeline_store,
    "preview_repo": pipeline_store,
    "schedule_queue": queue,
    "claude_client": limited_claude_client,
}
```

Update:

```python
assert max_attempts_by_job_type()[JobType.GENERATE_PREVIEW] == 5
assert JobType.GENERATE_PREVIEW in pipeline_rate_limits()
```

- [ ] **Step 2: Run RED**

Run:

```powershell
python -m pytest services/pipeline/tests/test_orchestrator.py -q
```

Expected: FAIL because the job is not registered.

- [ ] **Step 3: Implement orchestrator integration**

Import:

```python
from workers.generate_preview import generate_preview
```

Add optional `generate_preview_worker` parameters next to `qualify_worker`.

Use the same `RateLimitedClaudeClient` for `QUALIFY_LEAD` and `GENERATE_PREVIEW`, with separate limiter entries if both are configured.

Register:

```python
JobType.GENERATE_PREVIEW: handle_generate_preview
```

Add:

```python
JobType.GENERATE_PREVIEW: RateLimit(CLAUDE_RATE_LIMIT_PER_MINUTE)
```

and:

```python
JobType.GENERATE_PREVIEW: 5
```

In `claude_client.py` add:

```python
"preview-personalise-v1": "claude-haiku-4-5-20251001",
```

- [ ] **Step 4: Run GREEN**

Run:

```powershell
python -m pytest services/pipeline/tests/test_orchestrator.py -q
```

Expected: PASS.

---

### Task 7: Full Verification, Reviewers, and PR

**Files:**
- All changed files from tasks above.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
python -m pytest services/pipeline/tests/test_generate_preview.py services/pipeline/tests/test_qualify.py services/pipeline/tests/test_schedule_outreach.py services/pipeline/tests/test_orchestrator.py services/pipeline/tests/test_outreach_queries.py -q
```

Expected: PASS.

- [ ] **Step 2: Run full pipeline tests**

Run:

```powershell
python -m pytest services/pipeline/tests -q
```

Expected: PASS.

- [ ] **Step 3: Run static checks**

Run:

```powershell
python -m ruff check services/pipeline/src services/pipeline/tests
python -m mypy services/pipeline/src
git diff --check
```

Expected: all PASS.

- [ ] **Step 4: Invoke required reviewers**

Invoke:

- `db-reviewer` because `services/pipeline/src/db/queries.py` changes.
- `security-reviewer` because a new Claude generation path writes public preview HTML and passes preview URLs to outreach.
- focused general code reviewer before merge.

- [ ] **Step 5: Create PR**

Commit only #38 files. Push branch and create a PR:

```powershell
git push -u origin feat/issue-38-generate-preview-worker
gh pr create --base dev --head feat/issue-38-generate-preview-worker --title "Add generate preview worker" --body "<summary, test plan, reviewer evidence, stale issue correction, closes #38>"
```

Expected: PR targets `dev`, includes reviewer sign-off, and documents the `preview.presciaiq.com` correction.

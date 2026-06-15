# Instantly API contract fixes — Implementation Plan

> **For agentic workers:** Use executing-plans or dispatching-parallel-agents to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three confirmed Instantly v2 API contract bugs surfaced during live webhook registration: the pipeline's `add_lead_to_campaign` calls the wrong endpoint/body shape, `pauseLead` (dashboard + reply-agent) sends a no-op PATCH instead of moving the lead to a holding list, and the pipeline's dead `pause_lead`/`unsubscribe_lead` methods are removed.

**Architecture:** Each of the three services gets a focused, TDD fix: (1) `services/pipeline/src/clients/instantly_client.py` posts to `/api/v2/leads/add` with `{campaign_id, leads: [...]}` and `schedule_outreach.py` builds/parses that shape; dead pause/unsubscribe methods deleted. (2) `services/dashboard/src/clients/instantly.ts` and `services/reply-agent/src/escalation.ts`'s `InstantlyHttpClient.pauseLead` both move to `POST /api/v2/leads/move` using a new `INSTANTLY_PAUSED_LIST_ID` env var and the lead's `instantly_campaign_id` (sourced from `outreach_sends`, plumbed through `db/queries.ts` in both services). (3) Env templates gain `INSTANTLY_PAUSED_LIST_ID`.

**Tech Stack:** Python 3.12 + httpx + pytest (pipeline); Next.js/TypeScript + Drizzle + Vitest (dashboard); Node.js/TypeScript + pg + Vitest (reply-agent).

---

## Task 1: Pipeline — fix `add_lead_to_campaign` endpoint and body shape

**Files:**
- Modify: `services/pipeline/src/clients/instantly_client.py:42-43`
- Test: `services/pipeline/tests/test_instantly_client.py:11-52`

- [ ] **Step 1: Rewrite the failing test for the new endpoint/body shape**

Replace lines 11-52 of `services/pipeline/tests/test_instantly_client.py` (the entire `test_add_lead_to_campaign_sends_bearer_auth_and_documented_body` function) with:

```python
def test_add_lead_to_campaign_sends_bearer_auth_and_documented_body() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={"created_leads": [{"id": "lead-123"}]})

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = InstantlyClient(api_key="secret-key", http_client=http_client)

            result = await client.add_lead_to_campaign(
                {
                    "campaign_id": "campaign-123",
                    "leads": [
                        {
                            "email": "example@example.com",
                            "personalization": "Hello there",
                            "website": "https://example.com",
                            "last_name": "Doe",
                            "first_name": "John",
                            "company_name": "Example Inc.",
                            "phone": "+1234567890",
                            "custom_variables": {"lead_id": "lead-uuid"},
                        }
                    ],
                }
            )

        assert result == {"created_leads": [{"id": "lead-123"}]}
        assert len(requests) == 1
        request = requests[0]
        assert request.method == "POST"
        assert str(request.url) == "https://api.instantly.ai/api/v2/leads/add"
        assert request.headers["Authorization"] == "Bearer secret-key"
        assert request.headers["Content-Type"] == "application/json"
        assert request.read()
        assert request.content == (
            b'{"campaign_id":"campaign-123","leads":[{"email":"example@example.com",'
            b'"personalization":"Hello there","website":"https://example.com",'
            b'"last_name":"Doe","first_name":"John","company_name":"Example Inc.",'
            b'"phone":"+1234567890","custom_variables":{"lead_id":"lead-uuid"}}]}'
        )

    asyncio.run(scenario())
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `services/pipeline`):
```
python -m pytest tests/test_instantly_client.py::test_add_lead_to_campaign_sends_bearer_auth_and_documented_body -v
```
Expected: FAIL — `assert str(request.url) == "https://api.instantly.ai/api/v2/leads/add"` fails because the current implementation posts to `https://api.instantly.ai/api/v2/leads`.

- [ ] **Step 3: Fix the endpoint**

In `services/pipeline/src/clients/instantly_client.py`, change:

```python
    async def add_lead_to_campaign(self, payload: Mapping[str, object]) -> dict[str, object]:
        return await self._request("POST", "/api/v2/leads", json=dict(payload))
```

to:

```python
    async def add_lead_to_campaign(self, payload: Mapping[str, object]) -> dict[str, object]:
        return await self._request("POST", "/api/v2/leads/add", json=dict(payload))
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `services/pipeline`):
```
python -m pytest tests/test_instantly_client.py::test_add_lead_to_campaign_sends_bearer_auth_and_documented_body -v
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/pipeline/src/clients/instantly_client.py services/pipeline/tests/test_instantly_client.py
git commit -m "fix(pipeline): post leads to /api/v2/leads/add with documented body shape"
```

---

## Task 2: Pipeline — remove dead `pause_lead` / `unsubscribe_lead`

**Files:**
- Modify: `services/pipeline/src/clients/instantly_client.py:45-57`
- Test: `services/pipeline/tests/test_instantly_client.py:105-129`

- [ ] **Step 1: Delete the dead test**

Remove lines 105-129 of `services/pipeline/tests/test_instantly_client.py` entirely (the trailing blank line before `def test_pause_and_unsubscribe_are_patch_lead_wrappers` stays as the file's final newline). The deleted block is:

```python
def test_pause_and_unsubscribe_are_patch_lead_wrappers() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={"id": "lead-123"})

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = InstantlyClient(api_key="secret-key", http_client=http_client)
            await client.pause_lead("lead-123")
            await client.unsubscribe_lead("lead-123")

        assert [request.method for request in requests] == ["PATCH", "PATCH"]
        assert [str(request.url) for request in requests] == [
            "https://api.instantly.ai/api/v2/leads/lead-123",
            "https://api.instantly.ai/api/v2/leads/lead-123",
        ]
        assert requests[0].read()
        assert requests[0].content == b'{"status":-1}'
        assert requests[1].read()
        assert requests[1].content == b'{"lt_interest_status":-1}'

    asyncio.run(scenario())
```

The file should end immediately after `test_api_error_does_not_include_response_body_with_possible_pii`'s `asyncio.run(scenario())` line (line 102), with a single trailing newline.

- [ ] **Step 2: Delete the dead methods**

In `services/pipeline/src/clients/instantly_client.py`, remove lines 45-57 (the `pause_lead` and `unsubscribe_lead` methods, including the blank line that separates them from `add_lead_to_campaign` but keeping the blank line before `_request`). Delete this block:

```python

    async def pause_lead(self, instantly_lead_id: str) -> dict[str, object]:
        return await self._request(
            "PATCH",
            f"/api/v2/leads/{instantly_lead_id}",
            json={"status": -1},
        )

    async def unsubscribe_lead(self, instantly_lead_id: str) -> dict[str, object]:
        return await self._request(
            "PATCH",
            f"/api/v2/leads/{instantly_lead_id}",
            json={"lt_interest_status": -1},
        )
```

After this edit, `add_lead_to_campaign` is immediately followed by a single blank line and then `async def _request(...)`.

- [ ] **Step 3: Run the full client test file to verify everything still passes**

Run (from `services/pipeline`):
```
python -m pytest tests/test_instantly_client.py -v
```
Expected: PASS — 4 tests (`test_add_lead_to_campaign_sends_bearer_auth_and_documented_body`, `test_from_env_loads_api_key_from_dotenv_path`, `test_add_lead_to_campaign_raises_for_non_2xx_response`, `test_api_error_does_not_include_response_body_with_possible_pii`).

- [ ] **Step 4: Commit**

```bash
git add services/pipeline/src/clients/instantly_client.py services/pipeline/tests/test_instantly_client.py
git commit -m "fix(pipeline): remove dead pause_lead/unsubscribe_lead client methods"
```

---

## Task 3: Pipeline — `schedule_outreach.py` payload shape and lead-id parsing

**Files:**
- Modify: `services/pipeline/src/workers/schedule_outreach.py:254-291`
- Test: `services/pipeline/tests/test_schedule_outreach.py`

- [ ] **Step 1: Update `test_successful_job_adds_instantly_lead_writes_outreach_and_marks_contacted`**

In `services/pipeline/tests/test_schedule_outreach.py`, in `test_successful_job_adds_instantly_lead_writes_outreach_and_marks_contacted`:

Change line 177:
```python
        instantly = FakeInstantlyClient(result={"id": "instantly-lead-1"})
```
to:
```python
        instantly = FakeInstantlyClient(result={"created_leads": [{"id": "instantly-lead-1"}]})
```

Replace the `assert instantly.calls == [...]` block (lines 191-211):
```python
        assert instantly.calls == [
            {
                "campaign": "campaign-from-payload",
                "email": "brett@stonebuilders.com.au",
                "personalization": "Brett, your site is hard to use on mobile.",
                "website": "https://stonebuilders.com.au",
                "first_name": "Brett",
                "last_name": "Stone",
                "company_name": "Stone Builders",
                "phone": "+61400000001",
                "custom_variables": {
                    "opener": "Brett, your site is hard to use on mobile.",
                    "weakness": "no_mobile",
                    "followup_1": "Worth fixing before the next batch of quote requests.",
                    "followup_2": "Happy to show what a fast tradie site can look like.",
                    "lead_id": str(LEAD_ID),
                    "website_preview_url": PREVIEW_URL,
                    "preview_url": PREVIEW_URL,
                },
            }
        ]
```
with:
```python
        assert instantly.calls == [
            {
                "campaign_id": "campaign-from-payload",
                "leads": [
                    {
                        "email": "brett@stonebuilders.com.au",
                        "personalization": "Brett, your site is hard to use on mobile.",
                        "website": "https://stonebuilders.com.au",
                        "first_name": "Brett",
                        "last_name": "Stone",
                        "company_name": "Stone Builders",
                        "phone": "+61400000001",
                        "custom_variables": {
                            "opener": "Brett, your site is hard to use on mobile.",
                            "weakness": "no_mobile",
                            "followup_1": "Worth fixing before the next batch of quote requests.",
                            "followup_2": "Happy to show what a fast tradie site can look like.",
                            "lead_id": str(LEAD_ID),
                            "website_preview_url": PREVIEW_URL,
                            "preview_url": PREVIEW_URL,
                        },
                    }
                ],
            }
        ]
```

- [ ] **Step 2: Update `test_successful_job_reserves_outreach_before_calling_instantly`**

In the same file, change line 294:
```python
            instantly_client=EventInstantlyClient(result={"id": "instantly-lead-1"}),
```
to:
```python
            instantly_client=EventInstantlyClient(result={"created_leads": [{"id": "instantly-lead-1"}]}),
```

- [ ] **Step 3: Update `test_successful_job_defaults_website_preview_url_when_preview_payload_missing`**

Change line 322:
```python
        instantly = FakeInstantlyClient(result={"id": "instantly-lead-1"})
```
to:
```python
        instantly = FakeInstantlyClient(result={"created_leads": [{"id": "instantly-lead-1"}]})
```

Change line 332:
```python
        custom_variables = instantly.calls[0]["custom_variables"]
```
to:
```python
        custom_variables = instantly.calls[0]["leads"][0]["custom_variables"]
```

- [ ] **Step 4: Update `test_campaign_id_defaults_from_env`**

Change line 502:
```python
        instantly = FakeInstantlyClient(result={"id": "instantly-lead-1"})
```
to:
```python
        instantly = FakeInstantlyClient(result={"created_leads": [{"id": "instantly-lead-1"}]})
```

Change line 517:
```python
        assert instantly.calls[0]["campaign"] == "campaign-from-env"
```
to:
```python
        assert instantly.calls[0]["campaign_id"] == "campaign-from-env"
```

- [ ] **Step 5: Add a new test for the missing-`created_leads` error case**

Append to the end of `services/pipeline/tests/test_schedule_outreach.py` (after `test_worker_refuses_qualification_without_personalised_opener`, currently ending at line 537):

```python


def test_missing_created_leads_in_instantly_response_fails_clearly() -> None:
    async def scenario() -> None:
        repo = FakeOutreachRepository()
        instantly = FakeInstantlyClient(result={"created_leads": []})

        with pytest.raises(ValueError, match="Instantly response did not include id"):
            await schedule_outreach(
                _payload(),
                lead_fetcher=FakeLeadFetcher(_lead()),
                qualification_fetcher=FakeQualificationFetcher(_qualification()),
                outreach_repo=repo,
                instantly_client=instantly,
            )

        assert repo.completed == []
        assert repo.updates == []
        assert repo.lock_released is True

    asyncio.run(scenario())
```

- [ ] **Step 6: Run the test suite to verify it fails**

Run (from `services/pipeline`):
```
python -m pytest tests/test_schedule_outreach.py -v
```
Expected: FAIL — `test_successful_job_adds_instantly_lead_writes_outreach_and_marks_contacted`, `test_successful_job_defaults_website_preview_url_when_preview_payload_missing`, `test_campaign_id_defaults_from_env`, and `test_missing_created_leads_in_instantly_response_fails_clearly` all fail because `_instantly_payload` still returns the old flat shape and `_instantly_lead_id` still reads `result["id"]`.

- [ ] **Step 7: Rewrite `_instantly_payload`**

In `services/pipeline/src/workers/schedule_outreach.py`, replace lines 254-284:

```python
def _instantly_payload(
    *,
    campaign_id: str,
    lead: dict[str, object],
    qualification: dict[str, object],
    opener: str,
    lead_id: UUID,
    preview_url: str | None,
) -> dict[str, object]:
    custom_variables = {
        "opener": opener,
        "weakness": str(qualification.get("top_weakness", "")),
        "followup_1": str(qualification.get("followup_1", "")),
        "followup_2": str(qualification.get("followup_2", "")),
        "lead_id": str(lead_id),
        "website_preview_url": preview_url or "",
    }
    if preview_url is not None:
        custom_variables["preview_url"] = preview_url

    return {
        "campaign": campaign_id,
        "email": str(lead["email"]),
        "personalization": opener,
        "website": str(lead.get("website_url", "")),
        "first_name": str(lead.get("first_name", "")),
        "last_name": str(lead.get("last_name", "")),
        "company_name": str(lead.get("business_name", "")),
        "phone": str(lead.get("phone", "")),
        "custom_variables": custom_variables,
    }
```

with:

```python
def _instantly_payload(
    *,
    campaign_id: str,
    lead: dict[str, object],
    qualification: dict[str, object],
    opener: str,
    lead_id: UUID,
    preview_url: str | None,
) -> dict[str, object]:
    custom_variables = {
        "opener": opener,
        "weakness": str(qualification.get("top_weakness", "")),
        "followup_1": str(qualification.get("followup_1", "")),
        "followup_2": str(qualification.get("followup_2", "")),
        "lead_id": str(lead_id),
        "website_preview_url": preview_url or "",
    }
    if preview_url is not None:
        custom_variables["preview_url"] = preview_url

    return {
        "campaign_id": campaign_id,
        "leads": [
            {
                "email": str(lead["email"]),
                "personalization": opener,
                "website": str(lead.get("website_url", "")),
                "first_name": str(lead.get("first_name", "")),
                "last_name": str(lead.get("last_name", "")),
                "company_name": str(lead.get("business_name", "")),
                "phone": str(lead.get("phone", "")),
                "custom_variables": custom_variables,
            }
        ],
    }
```

- [ ] **Step 8: Rewrite `_instantly_lead_id`**

In `services/pipeline/src/workers/schedule_outreach.py`, replace lines 287-291:

```python
def _instantly_lead_id(result: dict[str, object]) -> str:
    instantly_lead_id = result.get("id")
    if not isinstance(instantly_lead_id, str) or not instantly_lead_id:
        raise ValueError("Instantly response did not include id")
    return instantly_lead_id
```

with:

```python
def _instantly_lead_id(result: dict[str, object]) -> str:
    created_leads = result.get("created_leads")
    if isinstance(created_leads, list) and created_leads:
        first = created_leads[0]
        if isinstance(first, dict):
            instantly_lead_id = first.get("id")
            if isinstance(instantly_lead_id, str) and instantly_lead_id:
                return instantly_lead_id
    raise ValueError("Instantly response did not include id")
```

- [ ] **Step 9: Run the test suite to verify it passes**

Run (from `services/pipeline`):
```
python -m pytest tests/test_schedule_outreach.py -v
```
Expected: PASS — all 14 tests (13 existing + 1 new).

- [ ] **Step 10: Run mypy to confirm strict typing holds**

Run (from `services/pipeline`):
```
python -m mypy src
```
Expected: no new errors.

- [ ] **Step 11: Commit**

```bash
git add services/pipeline/src/workers/schedule_outreach.py services/pipeline/tests/test_schedule_outreach.py
git commit -m "fix(pipeline): build /leads/add payload shape and parse created_leads[0].id"
```

---

## Task 4: Env templates — add `INSTANTLY_PAUSED_LIST_ID`

**Files:**
- Modify: `.env.example:25`
- Modify: `.env.test.example:18`
- Manual (not committed): root `.env`

- [ ] **Step 1: Add the var to `.env.example`**

In `.env.example`, after line 25 (`INSTANTLY_WEBHOOK_ID_UNSUBBED=`), add:

```
INSTANTLY_PAUSED_LIST_ID=
```

So the Instantly section reads:

```
# -- Instantly --------------------------------------------------------------
INSTANTLY_API_KEY=
INSTANTLY_CAMPAIGN_ID=instantly_campaign_placeholder
INSTANTLY_WEBHOOK_ID_REPLY=
INSTANTLY_WEBHOOK_ID_BOUNCED=
INSTANTLY_WEBHOOK_ID_UNSUBBED=
INSTANTLY_PAUSED_LIST_ID=
```

- [ ] **Step 2: Add the var to `.env.test.example`**

In `.env.test.example`, after line 18 (`INSTANTLY_WEBHOOK_ID_UNSUBBED=unsubbed_test_webhook_id`), add:

```
INSTANTLY_PAUSED_LIST_ID=paused_list_test_placeholder
```

So the Instantly section reads:

```
# -- Instantly --------------------------------------------------------------
INSTANTLY_CAMPAIGN_ID=instantly_test_campaign_placeholder
INSTANTLY_WEBHOOK_ID_REPLY=reply_test_webhook_id
INSTANTLY_WEBHOOK_ID_BOUNCED=bounced_test_webhook_id
INSTANTLY_WEBHOOK_ID_UNSUBBED=unsubbed_test_webhook_id
INSTANTLY_PAUSED_LIST_ID=paused_list_test_placeholder
```

- [ ] **Step 3: Commit the env templates**

```bash
git add .env.example .env.test.example
git commit -m "chore: add INSTANTLY_PAUSED_LIST_ID env var"
```

- [ ] **Step 4: Manually add the real value to the root `.env` (not committed)**

The root `.env` lives at `C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ\.env` (gitignored, NOT present in this worktree). Add this line to its Instantly section:

```
INSTANTLY_PAUSED_LIST_ID=37e23cd3-01a4-4c6d-b1db-21fe6c5cf5b5
```

This is a manual edit outside the worktree — do not attempt to create or edit `.env` inside `.worktrees/instantly-api-contract/`.

---

## Task 5: Dashboard — `getLatestInstantlyLeadId` returns `instantlyCampaignId`

**Files:**
- Modify: `services/dashboard/src/db/queries.ts:516-533,865-872`
- Test: `services/dashboard/src/db/queries.test.ts:286-296`

- [ ] **Step 1: Add the failing assertion**

In `services/dashboard/src/db/queries.test.ts`, in the test `"fetches the latest Instantly lead id without exposing other tenants"` (lines 286-296), add a new assertion after line 292:

```typescript
  it("fetches the latest Instantly lead id without exposing other tenants", () => {
    const query = buildLatestInstantlyLeadIdQuery(db, { tenantId, leadId }).toSQL();

    expect(query.sql).toContain('from "outreach_sends"');
    expect(query.sql).toContain('"outreach_sends"."tenant_id" =');
    expect(query.sql).toContain('"outreach_sends"."lead_id" =');
    expect(query.sql).toContain('"outreach_sends"."instantly_lead_id" is not null');
    expect(query.sql).toContain('"outreach_sends"."instantly_campaign_id"');
    expect(query.sql).toContain('order by "outreach_sends"."sent_at" desc');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain(leadId);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `services/dashboard`):
```
npx vitest run src/db/queries.test.ts -t "fetches the latest Instantly lead id without exposing other tenants"
```
Expected: FAIL — `query.sql` does not yet contain `"outreach_sends"."instantly_campaign_id"`.

- [ ] **Step 3: Add `instantlyCampaignId` to the query select**

In `services/dashboard/src/db/queries.ts`, change `buildLatestInstantlyLeadIdQuery` (lines 516-533):

```typescript
export function buildLatestInstantlyLeadIdQuery(db: DashboardDb, identity: LeadIdentity) {
  requireTenantId(identity.tenantId);

  return db
    .select({
      instantlyLeadId: outreachSends.instantlyLeadId,
    })
    .from(outreachSends)
    .where(
      and(
        eq(outreachSends.tenantId, identity.tenantId),
        eq(outreachSends.leadId, identity.leadId),
        isNotNull(outreachSends.instantlyLeadId),
      ),
    )
    .orderBy(desc(outreachSends.sentAt), desc(outreachSends.createdAt), desc(outreachSends.id))
    .limit(1);
}
```

to:

```typescript
export function buildLatestInstantlyLeadIdQuery(db: DashboardDb, identity: LeadIdentity) {
  requireTenantId(identity.tenantId);

  return db
    .select({
      instantlyLeadId: outreachSends.instantlyLeadId,
      instantlyCampaignId: outreachSends.instantlyCampaignId,
    })
    .from(outreachSends)
    .where(
      and(
        eq(outreachSends.tenantId, identity.tenantId),
        eq(outreachSends.leadId, identity.leadId),
        isNotNull(outreachSends.instantlyLeadId),
      ),
    )
    .orderBy(desc(outreachSends.sentAt), desc(outreachSends.createdAt), desc(outreachSends.id))
    .limit(1);
}
```

- [ ] **Step 4: Update `getLatestInstantlyLeadId`'s return shape**

In `services/dashboard/src/db/queries.ts`, change `getLatestInstantlyLeadId` (lines 865-872):

```typescript
export async function getLatestInstantlyLeadId(identity: LeadIdentity) {
  const db = getDb();
  const [row] = await buildLatestInstantlyLeadIdQuery(db, identity);
  if (!row?.instantlyLeadId) {
    throw new Error("Instantly lead id not found for lead");
  }
  return row.instantlyLeadId;
}
```

to:

```typescript
export async function getLatestInstantlyLeadId(identity: LeadIdentity) {
  const db = getDb();
  const [row] = await buildLatestInstantlyLeadIdQuery(db, identity);
  if (!row?.instantlyLeadId) {
    throw new Error("Instantly lead id not found for lead");
  }
  return { instantlyLeadId: row.instantlyLeadId, instantlyCampaignId: row.instantlyCampaignId };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run (from `services/dashboard`):
```
npx vitest run src/db/queries.test.ts
```
Expected: PASS — full `queries.test.ts` suite passes.

- [ ] **Step 6: Commit**

```bash
git add services/dashboard/src/db/queries.ts services/dashboard/src/db/queries.test.ts
git commit -m "fix(dashboard): include instantly_campaign_id in latest Instantly lead lookup"
```

---

## Task 6: Dashboard — `InstantlyHttpClient.pauseLead` moves the lead to the holding list

**Files:**
- Modify: `services/dashboard/src/clients/instantly.ts:1-35`
- Test: `services/dashboard/src/clients/instantly.test.ts:1-35`

- [ ] **Step 1: Rewrite the failing tests**

In `services/dashboard/src/clients/instantly.test.ts`, replace lines 5-35 (the two existing `it(...)` blocks inside `describe("InstantlyHttpClient", ...)`, up to but not including the `sendReply` tests) with:

```typescript
  it("fails before calling fetch when the API key is missing", async () => {
    const fetchMock = vi.fn();
    const client = new InstantlyHttpClient({
      apiKey: undefined,
      pausedListId: "paused-list-1",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await expect(client.pauseLead("instantly-lead-1", "campaign-1")).rejects.toThrow(
      "Missing env var: INSTANTLY_API_KEY",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails before calling fetch when INSTANTLY_PAUSED_LIST_ID is missing", async () => {
    const fetchMock = vi.fn();
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      pausedListId: undefined,
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await expect(client.pauseLead("instantly-lead-1", "campaign-1")).rejects.toThrow(
      "Missing env var: INSTANTLY_PAUSED_LIST_ID",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("moves a lead to the paused holding list via the Instantly v2 leads/move endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      pausedListId: "paused-list-1",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await client.pauseLead("instantly-lead-1", "campaign-1");

    expect(fetchMock).toHaveBeenCalledWith("https://api.instantly.test/api/v2/leads/move", {
      method: "POST",
      headers: {
        Authorization: "Bearer api-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ids: ["instantly-lead-1"],
        campaign: "campaign-1",
        to_list_id: "paused-list-1",
      }),
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `services/dashboard`):
```
npx vitest run src/clients/instantly.test.ts
```
Expected: FAIL — `pausedListId` is not a recognized constructor option (TypeScript error) and/or `pauseLead` still takes one argument and sends the old PATCH body.

- [ ] **Step 3: Rewrite `pauseLead` in the client**

In `services/dashboard/src/clients/instantly.ts`, change the options type (lines 6-10):

```typescript
type InstantlyClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: FetchFn;
};
```

to:

```typescript
type InstantlyClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: FetchFn;
  pausedListId?: string;
};
```

Change the class fields and constructor (lines 21-29):

```typescript
export class InstantlyHttpClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(options: InstantlyClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.INSTANTLY_API_KEY;
    this.baseUrl = (options.baseUrl ?? INSTANTLY_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
  }
```

to:

```typescript
export class InstantlyHttpClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly pausedListId?: string;

  constructor(options: InstantlyClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.INSTANTLY_API_KEY;
    this.baseUrl = (options.baseUrl ?? INSTANTLY_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.pausedListId = options.pausedListId ?? process.env.INSTANTLY_PAUSED_LIST_ID;
  }
```

Change `pauseLead` (lines 31-35):

```typescript
  async pauseLead(instantlyLeadId: string): Promise<void> {
    await this.request(`/api/v2/leads/${encodeURIComponent(instantlyLeadId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: -1 }),
    });
  }
```

to:

```typescript
  async pauseLead(instantlyLeadId: string, instantlyCampaignId: string): Promise<void> {
    if (!this.pausedListId) {
      throw new Error("Missing env var: INSTANTLY_PAUSED_LIST_ID");
    }
    await this.request("/api/v2/leads/move", {
      method: "POST",
      body: JSON.stringify({
        ids: [instantlyLeadId],
        campaign: instantlyCampaignId,
        to_list_id: this.pausedListId,
      }),
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `services/dashboard`):
```
npx vitest run src/clients/instantly.test.ts
```
Expected: PASS — including the unaffected `sendReply` tests.

- [ ] **Step 5: Commit**

```bash
git add services/dashboard/src/clients/instantly.ts services/dashboard/src/clients/instantly.test.ts
git commit -m "fix(dashboard): pause leads by moving them to the Instantly holding list"
```

---

## Task 7: Dashboard — `pauseLead` action passes `instantlyCampaignId`

**Files:**
- Modify: `services/dashboard/src/app/actions/lead-actions-core.ts:36-37,124-145`
- Test: `services/dashboard/src/app/actions/lead-actions.test.ts:27,82`

- [ ] **Step 1: Update the test fixtures and assertion**

In `services/dashboard/src/app/actions/lead-actions.test.ts`, change line 27 in `createDeps()`:

```typescript
    getLatestInstantlyLeadId: vi.fn().mockResolvedValue("instantly-lead-123"),
```

to:

```typescript
    getLatestInstantlyLeadId: vi.fn().mockResolvedValue({
      instantlyLeadId: "instantly-lead-123",
      instantlyCampaignId: "campaign-456",
    }),
```

Change line 82, in `"pauses a lead through Instantly and archives the lead badge state"`:

```typescript
    expect(deps.instantly.pauseLead).toHaveBeenCalledWith("instantly-lead-123");
```

to:

```typescript
    expect(deps.instantly.pauseLead).toHaveBeenCalledWith("instantly-lead-123", "campaign-456");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `services/dashboard`):
```
npx vitest run src/app/actions/lead-actions.test.ts -t "pauses a lead"
```
Expected: FAIL — `lead-actions-core.ts` still destructures/uses `instantlyLeadId` as a bare string and calls `pauseLead` with one argument, so `getLatestInstantlyLeadId`'s mocked object return breaks `pauseLead`'s logic and the `toHaveBeenCalledWith` assertion fails.

- [ ] **Step 3: Update `LeadActionDeps` and the `pauseLead` action**

In `services/dashboard/src/app/actions/lead-actions-core.ts`, change the `instantly.pauseLead` signature in `LeadActionDeps` (lines 36-37):

```typescript
  instantly: {
    pauseLead(instantlyLeadId: string): Promise<void>;
```

to:

```typescript
  instantly: {
    pauseLead(instantlyLeadId: string, instantlyCampaignId: string): Promise<void>;
```

Change the `pauseLead` action (lines 124-145):

```typescript
    async pauseLead(_previousState: LeadActionState, formData: FormData): Promise<LeadActionState> {
      const identity = readIdentity(formData);
      let instantlyLeadId: string;
      try {
        instantlyLeadId = await deps.getLatestInstantlyLeadId(identity);
      } catch (error) {
        if (error instanceof Error && error.message === "Instantly lead id not found for lead") {
          return {
            ok: false,
            message: "This lead has not been sent to Instantly yet and cannot be paused.",
          };
        }
        throw error;
      }

      await deps.assertLeadStatusTransitionAllowed({ ...identity, status: "archived" });
      await deps.instantly.pauseLead(instantlyLeadId);
      await deps.updateLeadStatus({ ...identity, status: "archived" });
      deps.revalidatePath(`/leads/${identity.leadId}`);

      return { ok: true, message: "Lead paused.", status: "archived" };
    },
```

to:

```typescript
    async pauseLead(_previousState: LeadActionState, formData: FormData): Promise<LeadActionState> {
      const identity = readIdentity(formData);
      try {
        const { instantlyLeadId, instantlyCampaignId } = await deps.getLatestInstantlyLeadId(identity);

        await deps.assertLeadStatusTransitionAllowed({ ...identity, status: "archived" });
        await deps.instantly.pauseLead(instantlyLeadId, instantlyCampaignId);
        await deps.updateLeadStatus({ ...identity, status: "archived" });
        deps.revalidatePath(`/leads/${identity.leadId}`);

        return { ok: true, message: "Lead paused.", status: "archived" };
      } catch (error) {
        if (error instanceof Error && error.message === "Instantly lead id not found for lead") {
          return {
            ok: false,
            message: "This lead has not been sent to Instantly yet and cannot be paused.",
          };
        }
        throw error;
      }
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `services/dashboard`):
```
npx vitest run src/app/actions/lead-actions.test.ts
```
Expected: PASS — full `lead-actions.test.ts` suite passes, including `"returns a graceful pause error when the lead has not been sent to Instantly"`.

- [ ] **Step 5: Commit**

```bash
git add services/dashboard/src/app/actions/lead-actions-core.ts services/dashboard/src/app/actions/lead-actions.test.ts
git commit -m "fix(dashboard): pass instantly_campaign_id through the pause-lead action"
```

---

## Task 8: Reply agent — `fetchEscalationContext` returns `instantly_campaign_id`

**Files:**
- Modify: `services/reply-agent/src/types.ts:83-92`
- Modify: `services/reply-agent/src/db/queries.ts:387-428`
- Test: `services/reply-agent/tests/db_queries.test.ts:231-262`

- [ ] **Step 1: Update the failing test**

In `services/reply-agent/tests/db_queries.test.ts`, in `"fetches escalation context through tenant-scoped lead and outreach send filters"` (lines 231-262), add `instantly_campaign_id` to the mocked row:

```typescript
  it("fetches escalation context through tenant-scoped lead and outreach send filters", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          tenant_id: "tenant-id",
          lead_id: "lead-id",
          first_name: "Brett",
          last_name: "Stone",
          business_name: "Stone Builders",
          city: "Newcastle",
          email: "brett@example.com",
          instantly_lead_id: "instantly-lead-123",
          instantly_campaign_id: "campaign-456",
        },
      ],
    });

    const context = await fetchEscalationContext("tenant-id", "lead-id", { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("FROM leads");
    expect(sql).toContain("WHERE leads.tenant_id = $1");
    expect(sql).toContain("AND leads.id = $2");
    expect(sql).toContain("FROM outreach_sends");
    expect(sql).toContain("outreach_sends.tenant_id = leads.tenant_id");
    expect(sql).toContain("outreach_sends.lead_id = leads.id");
    expect(sql).toContain("outreach_sends.instantly_lead_id IS NOT NULL");
    expect(sql).toContain("outreach_sends.instantly_campaign_id");
    expect(sql).toContain("outreach_sends.sent_at DESC NULLS LAST");
    expect(sql).toContain("outreach_sends.created_at DESC");
    expect(sql).toContain("outreach_sends.id DESC");
    expect(params).toEqual(["tenant-id", "lead-id"]);
    expect(context.instantly_lead_id).toBe("instantly-lead-123");
    expect(context.instantly_campaign_id).toBe("campaign-456");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `services/reply-agent`):
```
npx vitest run tests/db_queries.test.ts -t "fetches escalation context"
```
Expected: FAIL — TypeScript error / assertion failure because `EscalationContext` has no `instantly_campaign_id` field and the SQL doesn't select it.

- [ ] **Step 3: Add `instantly_campaign_id` to `EscalationContext`**

In `services/reply-agent/src/types.ts`, change `EscalationContext` (lines 83-92):

```typescript
export type EscalationContext = {
  tenant_id: string;
  lead_id: string;
  first_name: string | null;
  last_name: string | null;
  business_name: string | null;
  city: string | null;
  email: string;
  instantly_lead_id: string;
};
```

to:

```typescript
export type EscalationContext = {
  tenant_id: string;
  lead_id: string;
  first_name: string | null;
  last_name: string | null;
  business_name: string | null;
  city: string | null;
  email: string;
  instantly_lead_id: string;
  instantly_campaign_id: string;
};
```

- [ ] **Step 4: Add `instantly_campaign_id` to the SQL**

In `services/reply-agent/src/db/queries.ts`, change `fetchEscalationContext`'s query (lines 392-420):

```typescript
  const result = await db(client).query<EscalationContext>(
    `
      SELECT
        leads.tenant_id,
        leads.id AS lead_id,
        leads.first_name,
        leads.last_name,
        leads.business_name,
        leads.city,
        leads.email,
        latest_send.instantly_lead_id
      FROM leads
      JOIN LATERAL (
        SELECT outreach_sends.instantly_lead_id
        FROM outreach_sends
        WHERE outreach_sends.tenant_id = leads.tenant_id
          AND outreach_sends.lead_id = leads.id
          AND outreach_sends.instantly_lead_id IS NOT NULL
        ORDER BY outreach_sends.sent_at DESC NULLS LAST,
                 outreach_sends.created_at DESC,
                 outreach_sends.id DESC
        LIMIT 1
      ) AS latest_send ON TRUE
      WHERE leads.tenant_id = $1
        AND leads.id = $2
      LIMIT 1
    `,
    [tenantId, leadId],
  );
```

to:

```typescript
  const result = await db(client).query<EscalationContext>(
    `
      SELECT
        leads.tenant_id,
        leads.id AS lead_id,
        leads.first_name,
        leads.last_name,
        leads.business_name,
        leads.city,
        leads.email,
        latest_send.instantly_lead_id,
        latest_send.instantly_campaign_id
      FROM leads
      JOIN LATERAL (
        SELECT outreach_sends.instantly_lead_id, outreach_sends.instantly_campaign_id
        FROM outreach_sends
        WHERE outreach_sends.tenant_id = leads.tenant_id
          AND outreach_sends.lead_id = leads.id
          AND outreach_sends.instantly_lead_id IS NOT NULL
        ORDER BY outreach_sends.sent_at DESC NULLS LAST,
                 outreach_sends.created_at DESC,
                 outreach_sends.id DESC
        LIMIT 1
      ) AS latest_send ON TRUE
      WHERE leads.tenant_id = $1
        AND leads.id = $2
      LIMIT 1
    `,
    [tenantId, leadId],
  );
```

- [ ] **Step 5: Run the test to verify it passes**

Run (from `services/reply-agent`):
```
npx vitest run tests/db_queries.test.ts
```
Expected: PASS — full `db_queries.test.ts` suite passes.

- [ ] **Step 6: Commit**

```bash
git add services/reply-agent/src/types.ts services/reply-agent/src/db/queries.ts services/reply-agent/tests/db_queries.test.ts
git commit -m "fix(reply-agent): include instantly_campaign_id in escalation context"
```

---

## Task 9: Reply agent — `InstantlyHttpClient.pauseLead` moves the lead to the holding list

**Files:**
- Modify: `services/reply-agent/src/escalation.ts:25-27,83-107,124-125`
- Test: `services/reply-agent/tests/escalation.test.ts:14-28,76,234`

- [ ] **Step 1: Update the escalation test fixtures, assertion, and add a new `InstantlyHttpClient` describe block**

In `services/reply-agent/tests/escalation.test.ts`, add `instantly_campaign_id` to the `createQueries()` fixture (lines 14-28):

```typescript
function createQueries(overrides: Partial<EscalationQueries> = {}): EscalationQueries {
  return {
    fetchEscalationContext: vi.fn().mockResolvedValue({
      tenant_id: tenantId,
      lead_id: leadId,
      first_name: "Brett",
      last_name: "Stone",
      business_name: "Stone Builders",
      city: "Newcastle",
      email: "brett@stonebuilders.com.au",
      instantly_lead_id: "instantly-lead-123",
      instantly_campaign_id: "campaign-456",
    }),
    ...overrides,
  };
}
```

Change line 76:

```typescript
    expect(instantly.pauseLead).toHaveBeenCalledWith("instantly-lead-123");
```

to:

```typescript
    expect(instantly.pauseLead).toHaveBeenCalledWith("instantly-lead-123", "campaign-456");
```

Add a new `describe` block at the end of the file, after the `"Twilio SMS client"` block's closing `});` (currently the last line, line 233/234):

```typescript

describe("Instantly client", () => {
  it("moves a lead to the paused holding list via the Instantly v2 leads/move endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const client = new InstantlyHttpClient("api-key", "https://api.instantly.test", "paused-list-1");

    await client.pauseLead("instantly-lead-123", "campaign-456");

    expect(fetchMock).toHaveBeenCalledWith("https://api.instantly.test/api/v2/leads/move", {
      method: "POST",
      headers: {
        Authorization: "Bearer api-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ids: ["instantly-lead-123"],
        campaign: "campaign-456",
        to_list_id: "paused-list-1",
      }),
    });
    vi.unstubAllGlobals();
  });

  it("fails before calling fetch when INSTANTLY_PAUSED_LIST_ID is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new InstantlyHttpClient("api-key", "https://api.instantly.test", undefined);

    await expect(client.pauseLead("instantly-lead-123", "campaign-456")).rejects.toThrow(
      "Missing env var: INSTANTLY_PAUSED_LIST_ID",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
```

Add `InstantlyHttpClient` to the import list at the top of the file (lines 1-8):

```typescript
import { describe, expect, it, vi } from "vitest";
import {
  escalate,
  TwilioSmsClient,
  type EscalationQueries,
  type InstantlyClient,
  type SmsClient,
} from "../src/escalation.js";
```

to:

```typescript
import { describe, expect, it, vi } from "vitest";
import {
  escalate,
  InstantlyHttpClient,
  TwilioSmsClient,
  type EscalationQueries,
  type InstantlyClient,
  type SmsClient,
} from "../src/escalation.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `services/reply-agent`):
```
npx vitest run tests/escalation.test.ts
```
Expected: FAIL — `InstantlyClient.pauseLead` (the type and the mock satisfying it) takes one argument and `InstantlyHttpClient`'s constructor has no third `pausedListId` parameter, so the new tests and the updated `toHaveBeenCalledWith` assertion fail.

- [ ] **Step 3: Update `InstantlyClient` type, `InstantlyHttpClient`, and `escalate()`**

In `services/reply-agent/src/escalation.ts`, change the `InstantlyClient` type (lines 25-27):

```typescript
export type InstantlyClient = {
  pauseLead(instantlyLeadId: string): Promise<void>;
};
```

to:

```typescript
export type InstantlyClient = {
  pauseLead(instantlyLeadId: string, instantlyCampaignId: string): Promise<void>;
};
```

Change `InstantlyHttpClient` (lines 83-107):

```typescript
export class InstantlyHttpClient implements InstantlyClient {
  constructor(
    private readonly apiKey = process.env.INSTANTLY_API_KEY,
    private readonly baseUrl = INSTANTLY_BASE_URL,
  ) {}

  async pauseLead(instantlyLeadId: string): Promise<void> {
    if (!this.apiKey) {
      throw new MissingEnvError("Missing env var: INSTANTLY_API_KEY");
    }

    const response = await fetch(`${this.baseUrl}/api/v2/leads/${encodeURIComponent(instantlyLeadId)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: -1 }),
    });

    if (!response.ok) {
      throw new Error(`Instantly lead pause failed with ${response.status}; response body omitted`);
    }
  }
}
```

to:

```typescript
export class InstantlyHttpClient implements InstantlyClient {
  constructor(
    private readonly apiKey = process.env.INSTANTLY_API_KEY,
    private readonly baseUrl = INSTANTLY_BASE_URL,
    private readonly pausedListId = process.env.INSTANTLY_PAUSED_LIST_ID,
  ) {}

  async pauseLead(instantlyLeadId: string, instantlyCampaignId: string): Promise<void> {
    if (!this.apiKey) {
      throw new MissingEnvError("Missing env var: INSTANTLY_API_KEY");
    }
    if (!this.pausedListId) {
      throw new MissingEnvError("Missing env var: INSTANTLY_PAUSED_LIST_ID");
    }

    const response = await fetch(`${this.baseUrl}/api/v2/leads/move`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ids: [instantlyLeadId],
        campaign: instantlyCampaignId,
        to_list_id: this.pausedListId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Instantly lead pause failed with ${response.status}; response body omitted`);
    }
  }
}
```

Change `escalate()`'s pause call (line 125):

```typescript
  try {
    await instantly.pauseLead(context.instantly_lead_id);
  } catch {
```

to:

```typescript
  try {
    await instantly.pauseLead(context.instantly_lead_id, context.instantly_campaign_id);
  } catch {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `services/reply-agent`):
```
npx vitest run tests/escalation.test.ts
```
Expected: PASS — full `escalation.test.ts` suite passes, including the new `"Instantly client"` describe block.

- [ ] **Step 5: Commit**

```bash
git add services/reply-agent/src/escalation.ts services/reply-agent/tests/escalation.test.ts
git commit -m "fix(reply-agent): pause leads by moving them to the Instantly holding list"
```

---

## Task 10: Reviews (per CLAUDE.md)

**Files:** none (review-only)

- [ ] **Step 1: Run db-reviewer on the query changes**

Invoke `.claude/agents/db-reviewer.md` against the diffs in:
- `services/dashboard/src/db/queries.ts` (Task 5)
- `services/reply-agent/src/db/queries.ts` (Task 8)

Confirm both remain tenant-scoped reads with no new writes, and that the added columns (`instantlyCampaignId` / `instantly_campaign_id`) don't leak cross-tenant data. Address any findings before continuing.

- [ ] **Step 2: Run security-reviewer on the outbound Instantly client changes**

Invoke `.claude/agents/security-reviewer.md` against the diffs in:
- `services/dashboard/src/clients/instantly.ts` (Task 6)
- `services/reply-agent/src/escalation.ts` (Task 9)

Confirm the `/api/v2/leads/move` calls still use Bearer auth from env, don't log PII or the API key, and that error messages continue to omit response bodies. Address any findings before continuing.

---

## Task 11: Full regression run

**Files:** none (verification-only)

- [ ] **Step 1: Run the full pipeline test suite**

Run (from `services/pipeline`):
```
python -m pytest -v
```
Expected: PASS — all tests pass, including `test_instantly_client.py` and `test_schedule_outreach.py`.

- [ ] **Step 2: Run the full dashboard test suite**

Run (from `services/dashboard`):
```
npm test
```
Expected: PASS — all tests pass, including `queries.test.ts`, `instantly.test.ts`, and `lead-actions.test.ts`.

- [ ] **Step 3: Run the full reply-agent test suite**

Run (from `services/reply-agent`):
```
npm test
```
Expected: PASS — all tests pass, including `db_queries.test.ts` and `escalation.test.ts`.

- [ ] **Step 4: Confirm `INSTANTLY_CAMPAIGN_ID` remains untouched**

Run:
```bash
git diff dev -- .env.example .env.test.example
```
Expected: the diff shows only the new `INSTANTLY_PAUSED_LIST_ID` lines added in Task 4 — `INSTANTLY_CAMPAIGN_ID` placeholders are unchanged, and no campaign is started.

# Instantly API contract fixes — design

**Date:** 2026-06-16
**Status:** Approved
**Branch:** `fix/instantly-api-contract` off `dev`

## Background

While registering Instantly webhooks (reply, bounced, unsubscribed) with a real
API key, live testing against the Instantly v2 API surfaced two confirmed
contract bugs and one piece of dead/broken code:

1. `add_lead_to_campaign` calls the wrong endpoint with the wrong body shape.
2. `pauseLead` (escalation handoff + dashboard "Pause" button) sends a PATCH
   that Instantly silently no-ops (`status` is read-only).
3. The pipeline's `instantly_client.py` has unused `pause_lead` /
   `unsubscribe_lead` methods. `pause_lead` shares bug 2's broken
   `{"status": -1}` no-op; `unsubscribe_lead` sends a different body
   (`{"lt_interest_status": -1}`) but the same broken `PATCH /api/v2/leads/{id}`
   endpoint shape, and is uncalled either way.

The three Instantly webhooks (`reply_received`, `email_bounced`,
`lead_unsubscribed`) are already registered and verified against the existing
URL-token routes in `services/reply-agent/src/webhook.ts` — no further work
needed there.

A new Instantly lead list, **"Paused - PrinterIQ"** (id
`37e23cd3-01a4-4c6d-b1db-21fe6c5cf5b5`), was created live via the API to serve
as the holding list for paused leads.

No campaign is started as part of this work (`INSTANTLY_CAMPAIGN_ID` stays
empty — emails are still warming up).

## Bug 1 — `add_lead_to_campaign`

### Current (broken)

```python
async def add_lead_to_campaign(self, payload: Mapping[str, object]) -> dict[str, object]:
    return await self._request("POST", "/api/v2/leads", json=dict(payload))
```

`schedule_outreach.py::_instantly_payload` builds a flat body with a
`"campaign"` key; `_instantly_lead_id` reads `result["id"]`.

### Fix

- `services/pipeline/src/clients/instantly_client.py`:
  `add_lead_to_campaign(payload)` → `POST /api/v2/leads/add`, returns the raw
  response dict unchanged (no shape assumptions in the client itself).

- `services/pipeline/src/workers/schedule_outreach.py`:
  - `_instantly_payload(...)` returns:

    ```python
    {
        "campaign_id": campaign_id,
        "leads": [
            {
                "email": ...,
                "personalization": opener,
                "website": ...,
                "first_name": ...,
                "last_name": ...,
                "company_name": ...,
                "phone": ...,
                "custom_variables": {...},
            }
        ],
    }
    ```

  - `_instantly_lead_id(result)` reads `result["created_leads"][0]["id"]`,
    raising `ValueError("Instantly response did not include id")` if
    `created_leads` is missing, empty, or the first entry has no string `id`.

## Bug 2 — `pauseLead` → move to holding list

### Current (broken, 2 locations)

Both `services/dashboard/src/clients/instantly.ts` and the
`InstantlyHttpClient` inside `services/reply-agent/src/escalation.ts` send:

```ts
PATCH /api/v2/leads/{instantlyLeadId}
{ "status": -1 }
```

Instantly returns `200` but `status` is read-only — the lead keeps sending.

### Fix

New env var `INSTANTLY_PAUSED_LIST_ID=37e23cd3-01a4-4c6d-b1db-21fe6c5cf5b5`
(added to `.env`, `.env.example`, `.env.test.example`).

Both clients change `pauseLead` to take the lead's source campaign id and
call:

```
POST /api/v2/leads/move
{
  "ids": ["<instantlyLeadId>"],
  "campaign": "<instantlyCampaignId>",
  "to_list_id": "<INSTANTLY_PAUSED_LIST_ID>"
}
```

`outreach_sends.instantly_campaign_id` is `NOT NULL` and set on the same row
as `instantly_lead_id`, so it is always available at both call sites.

#### Dashboard (`services/dashboard`)

- `src/db/queries.ts`: `buildLatestInstantlyLeadIdQuery` /
  `getLatestInstantlyLeadId` add `outreachSends.instantlyCampaignId` to the
  select. Return type becomes `{ instantlyLeadId: string; instantlyCampaignId: string }`.
- `src/clients/instantly.ts`: `pauseLead(instantlyLeadId, instantlyCampaignId)`
  performs the `/leads/move` call; reads `INSTANTLY_PAUSED_LIST_ID` the same
  way it currently reads `apiKey` (constructor option with env fallback,
  throws `Missing env var: INSTANTLY_PAUSED_LIST_ID` if absent).
- `src/app/actions/lead-actions-core.ts`: `pauseLead` action keeps its
  existing `try/catch` around `getLatestInstantlyLeadId` (which still throws
  `"Instantly lead id not found for lead"` before returning), then
  destructures `const { instantlyLeadId, instantlyCampaignId } = await deps.getLatestInstantlyLeadId(identity)`
  inside the try and passes both to `deps.instantly.pauseLead`.
  `InstantlyClient` type signature updated to
  `pauseLead(instantlyLeadId: string, instantlyCampaignId: string): Promise<void>`.

#### Reply agent (`services/reply-agent`)

- `src/db/queries.ts`: `fetchEscalationContext` SQL adds
  `latest_send.instantly_campaign_id` to the `SELECT`.
- `src/types.ts`: `EscalationContext` gains `instantly_campaign_id: string`.
- `src/escalation.ts`: `InstantlyHttpClient.pauseLead(instantlyLeadId, instantlyCampaignId)`
  performs the `/leads/move` call, same env-var pattern as the dashboard
  client. `escalate()` calls
  `instantly.pauseLead(context.instantly_lead_id, context.instantly_campaign_id)`.
  `InstantlyClient` type updated to match.

## Cleanup — dead/broken Python methods

`services/pipeline/src/clients/instantly_client.py::pause_lead` and
`::unsubscribe_lead`:

- Have no callers anywhere in `services/pipeline/src`.
- Use the same broken `{"status": -1}` / no-op-adjacent PATCH pattern.
- Per `docs/architecture.md` service boundaries, pause/suppression actions
  belong to the reply agent and dashboard, not the pipeline.

**Action:** delete both methods from `instantly_client.py` and their
corresponding tests in `services/pipeline/tests/test_instantly_client.py`.

## Testing (TDD)

Write failing tests first, then implement, for each of:

- `services/pipeline/tests/test_instantly_client.py` — rewrite
  `add_lead_to_campaign` test for `POST /api/v2/leads/add` with
  `{"campaign_id", "leads"}`; remove `pause_lead`/`unsubscribe_lead` tests.
- `services/pipeline/tests/test_schedule_outreach.py` — update
  `_instantly_payload` shape assertions and `_instantly_lead_id` to read
  `created_leads[0].id` (including the missing/empty `created_leads` error
  case).
- `services/dashboard/src/clients/instantly.test.ts` — replace the existing
  "pauses a lead with the Instantly v2 lead status patch" test (asserts the
  old PATCH body) and the existing missing-API-key test's single-arg
  `pauseLead("instantly-lead-1")` call with two-arg
  `pauseLead(leadId, campaignId)` tests asserting the `/leads/move` body and
  the `INSTANTLY_PAUSED_LIST_ID` missing-env error.
- `services/dashboard/src/db/queries.test.ts` —
  `buildLatestInstantlyLeadIdQuery` / `getLatestInstantlyLeadId` return
  `instantlyCampaignId`.
- `services/dashboard/src/app/actions/lead-actions.test.ts` — update the
  `getLatestInstantlyLeadId` mock (currently `mockResolvedValue("instantly-lead-123")`)
  to resolve `{ instantlyLeadId, instantlyCampaignId }`, and update the
  `pauseLead` call assertion to the two-arg form.
- `services/reply-agent/tests/escalation.test.ts` — new
  `InstantlyHttpClient.pauseLead` move-body test; `escalate()` passes
  `instantly_campaign_id` through.
- `services/reply-agent/tests/db_queries.test.ts` — `fetchEscalationContext`
  returns `instantly_campaign_id`.

## Reviews (per CLAUDE.md)

- `db-reviewer` for the two `db/queries.ts` changes (dashboard, reply-agent).
- `security-reviewer` for the `escalation.ts` and `instantly.ts` client
  changes (outbound Instantly API calls).

## Out of scope

- `unsubscribe_lead`'s effect on Instantly's email sequence (configured in
  Instantly's UI per ADR 002).
- `instantly.ts::sendReply` optional `subject` handling.
- Starting any campaign — `INSTANTLY_CAMPAIGN_ID` remains empty.
- The existing CSV-import work on `feat/issue-33-import-csv` (separate
  branch, untouched by this work).

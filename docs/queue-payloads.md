# Queue Job Payload Schemas

> Source of truth: PRD Section 7. Never add fields without updating this doc and the PRD.

## Queue layout

| Queue name | Workers | Concurrency |
|---|---|---|
| `pipeline` | ingest, enrich, qualify, schedule_outreach | 5 max |
| `replies` | process_reply, send_reply, retry_checkout | 10 max |

---

## `ingest_csv`

**Queue:** pipeline | **Worker:** `ingest.py` | **Max retries:** 3 | **Concurrency:** 1

```json
{
  "job_type": "ingest_csv",
  "tenant_id": "uuid",
  "file_path": "/uploads/apollo_2026_05.csv",
  "source_file": "apollo_2026_05.csv",
  "vertical": "tradies",
  "dry_run": false
}
```

On completion fans out one `enrich_lead` job per new lead.

---

## `enrich_lead`

**Queue:** pipeline | **Worker:** `enrich.py` | **Max retries:** 5 | **Concurrency:** 5

```json
{
  "job_type": "enrich_lead",
  "tenant_id": "uuid",
  "lead_id": "uuid"
}
```

Minimal payload by design — worker fetches full lead from DB. Never put DB field values in the payload.

---

## `qualify_lead`

**Queue:** pipeline | **Worker:** `qualify.py` | **Max retries:** 3 | **Rate limit:** 50 Claude calls/min

```json
{
  "job_type": "qualify_lead",
  "tenant_id": "uuid",
  "lead_id": "uuid",
  "score_threshold": 40
}
```

`score_threshold` must be in the payload — never hardcoded.

---

## `schedule_outreach`

**Queue:** pipeline | **Worker:** `schedule_outreach.py` | **Max retries:** 5

```json
{
  "job_type": "schedule_outreach",
  "tenant_id": "uuid",
  "lead_id": "uuid",
  "campaign_id": "instantly_campaign_uuid",
  "channel": "email",
  "send_after": "2026-05-20T09:00:00+10:00"
}
```

---

## `generate_preview`

**Queue:** pipeline | **Worker:** `generate_preview.py` | **Max retries:** 3

```json
{
  "job_type": "generate_preview",
  "tenant_id": "uuid",
  "lead_id": "uuid"
}
```

---

## Prospect shadow discovery

These jobs operate only on tenant-scoped prospect staging. They cannot create leads, previews, outreach sends, or Instantly requests.

### `start_discovery`

```json
{
  "job_type": "start_discovery",
  "tenant_id": "uuid",
  "discovery_run_id": "uuid"
}
```

### `poll_outscraper`

```json
{
  "job_type": "poll_outscraper",
  "tenant_id": "uuid",
  "discovery_run_id": "uuid",
  "poll_count": 1
}
```

### `normalize_prospects`

```json
{
  "job_type": "normalize_prospects",
  "tenant_id": "uuid",
  "discovery_run_id": "uuid"
}
```

### `assess_prospects`

```json
{
  "job_type": "assess_prospects",
  "tenant_id": "uuid",
  "discovery_run_id": "uuid"
}
```

### `enrich_prospect_contacts`

```json
{
  "job_type": "enrich_prospect_contacts",
  "tenant_id": "uuid",
  "discovery_run_id": "uuid"
}
```

### `prepare_shadow_review`

```json
{
  "job_type": "prepare_shadow_review",
  "tenant_id": "uuid",
  "discovery_run_id": "uuid"
}
```

### `purge_prospect_data`

Tenant-scoped retention cleanup. Enqueue from server configuration only with
`python -m src.workers.purge_prospect_data --enqueue`; do not accept a browser
tenant override.

```json
{
  "job_type": "purge_prospect_data",
  "tenant_id": "uuid"
}
```

The worker clears expired raw Outscraper and Apollo payload JSON before deleting
eligible prospect snapshots. It only deletes child contacts/assessments and
non-promoted prospect snapshots for `completed` discovery runs, and only deletes
a run after no prospect snapshots remain. It cannot create leads, previews,
outreach sends, or Instantly requests.

---

## `process_reply`

**Queue:** replies | **Worker:** `handler.ts` | **Max retries:** 3 | **Concurrency:** 10

```json
{
  "job_type": "process_reply",
  "tenant_id": "uuid",
  "lead_id": "uuid",
  "channel": "email",
  "direction": "inbound",
  "body": "Yeah mate how much is it?",
  "raw_webhook": {}
}
```

Hardcoded escalation phrases checked BEFORE Claude: `"call me"`, `"speak to"`, `"too expensive"`, `"can you do a deal"`, `"talk to a human"`.

Claude response schema:
```json
{
  "intent": "question",
  "confidence": 85,
  "reply_body": "string",
  "action": "reply",
  "escalation_reason": null
}
```

---

## `send_reply`

**Queue:** replies | **Worker:** `handler.ts` | **Max retries:** 5

```json
{
  "job_type": "send_reply",
  "tenant_id": "uuid",
  "lead_id": "uuid",
  "conversation_id": "uuid",
  "channel": "email",
  "action": "reply",
  "body": "Hey mate, great question...",
  "instantly_lead_id": "instantly_uuid",
  "stripe_session_url": null
}
```

Never proceeds without `conversation_id` — this is the idempotency guard.

---

## `retry_checkout`

**Queue:** replies | **Worker:** `handler.ts` | **Max retries:** 1 | **Fires at most once per lead**

```json
{
  "job_type": "retry_checkout",
  "tenant_id": "uuid",
  "lead_id": "uuid",
  "original_session": "cs_stripe_uuid",
  "scheduled_at": "2026-05-21T09:00:00+10:00"
}
```

Always checks `payments` table first — if `status = 'completed'`, do nothing.

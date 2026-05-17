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

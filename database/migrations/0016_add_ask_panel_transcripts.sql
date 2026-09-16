-- What the ask panel was asked, and what it answered.
--
-- Two reasons to keep it rather than let the panel be a chat that forgets.
-- First, cost: every answer records its model, tokens and dollars, so the
-- panel cannot quietly become the biggest line in the bill without anyone
-- seeing it. Second, trust: an answer is only as good as the reads behind it,
-- so the tool calls are stored with it and can be checked later against what
-- the dashboard showed at the time.
--
-- Tenant scoped like every other table here. Operator email rather than a
-- user id, because the dashboard authenticates operators by email allowlist.

CREATE TABLE IF NOT EXISTS ask_conversations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id),
  operator_email      TEXT NOT NULL,
  title               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ask_conversations_tenant_recent
  ON ask_conversations (tenant_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS ask_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID NOT NULL REFERENCES ask_conversations(id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id),
  question            TEXT NOT NULL,
  answer              TEXT,
  -- One entry per tool call: name, input, whether it failed, and the reason.
  tool_calls          JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_used          TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cost_usd            NUMERIC(10,6),
  -- Set when the answer never completed, so a failed turn is not stored as an
  -- empty answer that reads like the model had nothing to say.
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ask_messages_conversation
  ON ask_messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ask_messages_tenant_created
  ON ask_messages (tenant_id, created_at DESC);

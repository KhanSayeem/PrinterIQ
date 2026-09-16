-- One inbound reply, one row.
--
-- On 2026-09-16 a single reply from one lead became three inbound
-- conversations. The reply classifier was failing with a 400, BullMQ retried
-- the job at 30 and 60 seconds, and every attempt inserted the reply again.
-- The third attempt then counted its own duplicates as three replies and
-- escalated with "three_inbound_replies_without_checkout", so one reply filled
-- the replies page three times and paged the operator.
--
-- The key is set by the reply handler from the Instantly email id when the
-- webhook carries one, and from a hash of the tenant, lead, channel and body
-- otherwise. Nullable, because every row written before this migration has no
-- key, and the index is partial so those rows do not collide with each other.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_dedupe_key
  ON conversations (tenant_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

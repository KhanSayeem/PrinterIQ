-- Migration 0012: give a checkout session a home so it can be reused.
--
-- createCheckoutSession had no idempotency guard. The BullMQ jobId dedupes
-- enqueues, but a send_reply job that failed after Stripe returned a session
-- was retried and minted a second one, so the same lead could hold two live
-- payment links. The session is stored against the conversation that produced
-- it and looked up per lead before Stripe is called again.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS stripe_session_id  TEXT,
  ADD COLUMN IF NOT EXISTS stripe_session_url TEXT;

-- The id and the URL describe one session and must appear and disappear
-- together, so the {id, url} return type in db/queries.ts is true by
-- construction rather than by convention.
ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_stripe_session_complete;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_stripe_session_complete
  CHECK ((stripe_session_id IS NULL) = (stripe_session_url IS NULL));

-- The invariant, enforced by the database rather than by application code:
-- one live checkout session per lead. Application-side COALESCE only
-- serialises writers touching the same conversation row; two conversations for
-- one lead would each see NULL and each mint a session. Here the second writer
-- gets a unique violation, its job fails and retries, and the retry finds the
-- winning session. This is also the lookup index for fetchCheckoutSession.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_checkout_session_per_lead
  ON conversations (tenant_id, lead_id)
  WHERE stripe_session_id IS NOT NULL;

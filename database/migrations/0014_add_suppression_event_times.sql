-- Migration 0014: give a bounce and an unsubscribe their own event time.
--
-- outreach_sends records a suppression as a boolean and nothing else, so the
-- only time signal a suppression left behind was updated_at, the row's last
-- write. The dashboard was dating today's unsubscribes by it, and that is wrong
-- in two ways at once.
--
-- The first is the one the code already admitted to: a row that bounces and
-- later unsubscribes has one updated_at, so both events land on the later day.
--
-- The second is the one an operator actually reads off the tile. The
-- unsubscribe rate divides today's suppressions by today's sends, and a lead
-- suppressed today may have been sent to last week. Numerator and denominator
-- were two different cohorts, so the rate was not a rate. On a quiet sending
-- day, one unsubscribe from an old send could put the tile over its 0.5%
-- warning line and stop a campaign that had done nothing wrong.
--
-- Both columns are nullable and there is no backfill. Copying updated_at into
-- them would preserve exactly the wrong attribution this migration exists to
-- remove, and would do it silently, with no way left to tell a real event time
-- from a guess. A null therefore means "flagged before this migration, event
-- time unknown", and the dashboard counts those rows separately and prints
-- that on the tile instead of quietly leaving them out.
--
-- The index is partial and matches the dashboard's read: today's unsubscribes
-- for one tenant. Rows that never unsubscribed are not in it, and rows flagged
-- before this migration are not in it either, which is correct because they
-- carry no event time to order by.

ALTER TABLE outreach_sends
  ADD COLUMN IF NOT EXISTS bounced_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_outreach_sends_tenant_unsubscribed_at
  ON outreach_sends(tenant_id, unsubscribed_at DESC)
  WHERE unsubscribed_at IS NOT NULL;

-- A timestamp without the flag, or a flag that later loses its timestamp,
-- would move a lead into or out of the suppressed population the dashboard
-- filters on. The flag may still stand alone, which is the pre-migration row.
ALTER TABLE outreach_sends
  DROP CONSTRAINT IF EXISTS outreach_sends_suppression_times_consistent;

ALTER TABLE outreach_sends
  ADD CONSTRAINT outreach_sends_suppression_times_consistent
  CHECK (
    (bounced_at IS NULL OR bounced = TRUE)
    AND (unsubscribed_at IS NULL OR unsubscribed = TRUE)
  );

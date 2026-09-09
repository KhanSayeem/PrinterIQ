-- Migration 0013: record when a prospect actually opens their preview page.
--
-- Open tracking and click tracking are both switched off on the campaigns on
-- purpose, to protect deliverability. Google Postmaster Tools cannot fill the
-- gap either: it needs far more volume than the ramp allows, which is roughly
-- 39 emails per domain per day. The result is that once sending starts we
-- cannot tell "delivered and ignored" from "landed in spam", and those two
-- outcomes call for opposite responses. One means the copy or the offer is
-- wrong, the other means the domain is in trouble and sending must stop.
--
-- Every preview already lives on our own domain at a high-entropy slug that
-- appears in exactly one email, so a hit on that URL is not an open, it is
-- that specific prospect opening the email and clicking through. It is a
-- stronger signal than an open, it needs no tracking pixel, and it costs
-- nothing in deliverability because it is an ordinary page load on our
-- server. These three columns are where that signal is kept.
--
-- No new index. Lookups on the write path go through preview_slug, which
-- already carries the UNIQUE index website_previews_preview_slug_key from
-- migration 0007, and the per-lead read goes through
-- idx_website_previews_tenant_lead from migration 0005.

ALTER TABLE website_previews
  ADD COLUMN IF NOT EXISTS first_viewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_viewed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS view_count      INTEGER NOT NULL DEFAULT 0;

-- The three columns describe one history and cannot disagree. view_count = 0
-- has to mean never seen, because that is exactly the population the operator
-- will act on, and a row that claims views without a timestamp, or a
-- timestamp without views, silently moves a lead into or out of that set.
-- Enforced here rather than in application code so a manual UPDATE during an
-- incident cannot quietly break the invariant the dashboard filters on.
ALTER TABLE website_previews
  DROP CONSTRAINT IF EXISTS website_previews_view_tracking_consistent;

ALTER TABLE website_previews
  ADD CONSTRAINT website_previews_view_tracking_consistent
  CHECK (
    view_count >= 0
    AND (first_viewed_at IS NULL) = (view_count = 0)
    AND (first_viewed_at IS NULL) = (last_viewed_at IS NULL)
    AND (first_viewed_at IS NULL OR last_viewed_at >= first_viewed_at)
  );

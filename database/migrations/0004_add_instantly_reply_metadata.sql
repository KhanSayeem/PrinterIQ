ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS instantly_email_id TEXT,
  ADD COLUMN IF NOT EXISTS instantly_account_id TEXT;

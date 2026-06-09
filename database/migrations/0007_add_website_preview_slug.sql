-- Migration 0007: replace deterministic public preview paths with high-entropy slugs.

ALTER TABLE website_previews
ADD COLUMN IF NOT EXISTS preview_slug TEXT;

UPDATE website_previews
SET preview_slug = REPLACE(gen_random_uuid()::TEXT, '-', '')
WHERE preview_slug IS NULL;

ALTER TABLE website_previews
ALTER COLUMN preview_slug SET NOT NULL;

UPDATE website_previews
SET preview_url = 'https://preview.presciaiq.com/p/' || preview_slug || '/'
WHERE preview_url IS DISTINCT FROM 'https://preview.presciaiq.com/p/' || preview_slug || '/';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'website_previews_preview_slug_key'
      AND conrelid = 'website_previews'::regclass
  ) THEN
    ALTER TABLE website_previews
    ADD CONSTRAINT website_previews_preview_slug_key UNIQUE (preview_slug);
  END IF;
END $$;

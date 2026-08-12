-- Migration 0010: gate qualified leads on a concrete, pitchable weakness.

ALTER TABLE qualifications
ADD COLUMN IF NOT EXISTS has_actionable_weakness BOOLEAN;

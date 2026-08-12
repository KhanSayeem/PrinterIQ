-- Migration 0011: add a natural-language weakness sentence for outreach copy.

ALTER TABLE qualifications
ADD COLUMN IF NOT EXISTS weakness_sentence TEXT;

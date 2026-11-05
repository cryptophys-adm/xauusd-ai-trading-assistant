-- Outcome scoring v2: outcome_runs records the scoring version, so candles scored by an
-- older version are scored again (and their outcome_scores rows replaced).
ALTER TABLE outcome_runs ADD COLUMN scoring_version TEXT;

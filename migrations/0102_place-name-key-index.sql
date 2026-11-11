-- #857 (S2 of #844), rev3 §4.2 column-transform path. Needs CODEOWNER review.
-- Whole-name equality for place QA is decided on the whitespace-collapsed,
-- trimmed form of name_normalized (what normalizeVietnamese produces for the
-- query side). An expression index: no new column, no table rewrite, no data
-- change, and rollback is DROP INDEX. The build holds a SHARE lock on places
-- (reads continue, writes wait) for its duration. For a large table build it
-- first with scripts/ops/index-place-name-key.sql (CONCURRENTLY, autocommit);
-- this statement is then a no-op.
SET LOCAL lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS places_name_key_idx ON places ((btrim(regexp_replace(name_normalized, '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'), ' ')));
SET LOCAL lock_timeout TO DEFAULT;

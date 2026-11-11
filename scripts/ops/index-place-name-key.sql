-- psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f scripts/ops/index-place-name-key.sql
-- #857: the migration 0102 index, built without blocking writes on a large
-- places table. Run BEFORE db:migrate (0102 is then a no-op), or after it as a
-- readiness check only. Autocommit ONLY; never BEGIN or the migration runner.
-- After an interrupted build, DROP INDEX CONCURRENTLY places_name_key_idx then
-- rerun; never silently accept an invalid index.
SET lock_timeout = '5s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS places_name_key_idx ON places ((btrim(regexp_replace(name_normalized, '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'), ' ')));
RESET lock_timeout;
SELECT 1 / count(*)::int AS places_name_key_idx_ready FROM pg_index i WHERE i.indexrelid=to_regclass('places_name_key_idx') AND i.indrelid=to_regclass('places') AND i.indisvalid AND i.indisready AND i.indisunique=false AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indpred IS NULL AND regexp_replace(replace(coalesce(pg_get_expr(i.indexprs,i.indrelid),''),'::text',''),'[[:space:]]','','g')='btrim(regexp_replace(name_normalized,''[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'','''',''g''),'''')';

-- psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f scripts/ops/index-place-name-key.sql
-- MANDATORY after deploy/db:migrate and before accepting S2 resolver traffic.
-- Autocommit ONLY, never BEGIN, psql -1 or the migration runner.
-- IF NOT EXISTS cannot heal an interrupted or incompatible same-name index.
-- Recovery: DROP INDEX CONCURRENTLY IF EXISTS places_name_key_idx then rerun.
SET lock_timeout = '5s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS places_name_key_idx ON places ((btrim(regexp_replace(name_normalized, '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'), ' ')));
RESET lock_timeout;
SELECT CASE WHEN count(*)=1 THEN 1 ELSE
 ('places_name_key_idx missing, invalid or incompatible. In autocommit run DROP INDEX CONCURRENTLY IF EXISTS places_name_key_idx then rerun scripts/ops/index-place-name-key.sql (matches=' || count(*)::text || ')')::int
 END AS places_name_key_idx_ready
FROM pg_index i
JOIN pg_class x ON x.oid=i.indexrelid
JOIN pg_am am ON am.oid=x.relam
JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname='name_normalized'
JOIN pg_opclass opc ON opc.oid=i.indclass[0]
WHERE i.indexrelid=to_regclass('places_name_key_idx')
 AND i.indrelid=to_regclass('places')
 AND i.indisvalid AND i.indisready AND i.indislive
 AND NOT i.indisunique AND NOT i.indisexclusion
 AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indpred IS NULL
 AND am.amname='btree' AND i.indkey[0]=0 AND i.indoption[0]=0
 AND opc.opcname='text_ops' AND opc.opcnamespace='pg_catalog'::regnamespace
 AND i.indcollation[0]=a.attcollation
 AND pg_get_expr(i.indexprs,i.indrelid)='btrim(regexp_replace(name_normalized, ''[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+''::text, '' ''::text, ''g''::text), '' ''::text)';

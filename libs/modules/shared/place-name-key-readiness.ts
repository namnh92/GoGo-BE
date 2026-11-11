import { sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from './app-error';

// pg_get_expr's canonical SQL; preserve literal whitespace (replacement/trim
// characters are part of the key semantics). Ops checks the identical shape.
const expression = `btrim(regexp_replace(name_normalized, '${schema.PLACE_NAME_KEY_WHITESPACE}'::text, ' '::text, 'g'::text), ' '::text)`;

/** Per-read gate inside the resolver's existing deadline; never cache success. */
export async function assertPlaceNameKeyReady(db: Pick<Db, 'execute'>): Promise<void> {
  const result = await db.execute(sql`SELECT i.indexrelid
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
 AND pg_get_expr(i.indexprs,i.indrelid)=${expression}`);
  if (result.rows.length !== 1)
    throw AppError.serviceUnavailable(
      'PLACE_NAME_KEY_NOT_READY',
      'places_name_key_idx missing, invalid or incompatible. In autocommit run DROP INDEX CONCURRENTLY IF EXISTS places_name_key_idx then rerun scripts/ops/index-place-name-key.sql',
      false,
    );
}

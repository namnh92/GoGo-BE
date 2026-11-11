import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { expect, it, vi } from 'vitest';
import { assertPlaceNameKeyReady } from './place-name-key-readiness';

it('round-4: ops and runtime require the identical exact index shape, preserving SQL literals', async () => {
  const execute = vi.fn(async () => ({ rows: [{ indexrelid: 1 }] }));
  await assertPlaceNameKeyReady({ execute } as never);
  const [statement] = execute.mock.calls[0] as unknown as [Parameters<PgDialect['sqlToQuery']>[0]];
  const compiled = new PgDialect().sqlToQuery(statement);
  const ops = readFileSync(
    path.resolve(__dirname, '../../../scripts/ops/index-place-name-key.sql'),
    'utf8',
  );
  const sql = compiled.sql.replace('$1', `'${String(compiled.params[0]).replaceAll("'", "''")}'`);
  expect(ops).toContain(sql.slice(sql.indexOf('FROM pg_index')));
  expect(compiled.params[0]).toContain("' '::text, 'g'::text), ' '::text)");
  for (const guard of [
    'indisvalid',
    'indisready',
    'indislive',
    'indisunique',
    'indisexclusion',
    'indnkeyatts=1',
    'indnatts=1',
    'indpred IS NULL',
    "amname='btree'",
    'indkey[0]=0',
    'indoption[0]=0',
    "opcname='text_ops'",
    'indcollation[0]=a.attcollation',
    'pg_get_expr',
  ])
    expect(compiled.sql).toContain(guard);
});

it('round-4: readiness is checked again after success and supplies explicit recovery instructions', async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ indexrelid: 1 }] })
    .mockResolvedValue({ rows: [] });
  const db = { execute } as never;
  await assertPlaceNameKeyReady(db);
  await expect(assertPlaceNameKeyReady(db)).rejects.toMatchObject({
    code: 'PLACE_NAME_KEY_NOT_READY',
    message: expect.stringContaining('DROP INDEX CONCURRENTLY'),
  });
  expect(execute).toHaveBeenCalledTimes(2);
});

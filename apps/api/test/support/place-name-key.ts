import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '@gogo/database';

/** Same mandatory post-migration ops phase as DEV; no surrounding transaction. */
export async function placeNameKeyIndex(db: Db): Promise<void> {
  const script = await readFile(
    path.resolve(__dirname, '../../../../scripts/ops/index-place-name-key.sql'),
    'utf8',
  );
  const client = await db.$client.connect();
  try {
    for (const statement of script
      .replace(/--[^\n]*/g, '')
      .split(';')
      .filter((s) => s.trim()))
      await client.query(statement);
  } finally {
    client.release(true);
  }
}

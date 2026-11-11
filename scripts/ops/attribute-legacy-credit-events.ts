/** Run from repo root: pnpm exec tsx scripts/ops/attribute-legacy-credit-events.ts
 * Exactly one committed batch per invocation; rerun through remaining=0 after writer drain. */
import { createDb } from '../../libs/database/src';
import { attributeLegacyCreditBatch } from '../../libs/modules/shared/credit-grants';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDb(process.env.DATABASE_URL);
  try {
    const result = await attributeLegacyCreditBatch(
      db,
      Number(process.env.CREDIT_ATTRIBUTION_BATCH_SIZE ?? 1000),
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});

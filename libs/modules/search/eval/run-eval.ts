/* eslint-disable no-console */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDb } from '@gogo/database';
import { SearchService } from '../application/search.service';
import { SearchRepository, type SearchFilters } from '../infrastructure/search.repository';

/**
 * SE-008 — offline evaluation harness. Runs the judged query set against the
 * database at DATABASE_URL (seeded corpus locally; snapshot in CI/staging)
 * and reports Recall@K + MRR per query and aggregate, tagged with the active
 * weights version so baselines are comparable across ranking changes.
 *
 *   DATABASE_URL=postgres://gogo:gogo@localhost:5433/gogo pnpm eval:search
 *
 * Exit code 1 when aggregate recall falls below the gate (default 0.9;
 * override EVAL_MIN_RECALL, or EVAL_REPORT_ONLY=1 to never fail).
 */

type Judgment = {
  id: string;
  filters: Partial<SearchFilters> & { q?: string };
  expected: string[];
  k: number;
};

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDb(url);
  const repo = new SearchRepository(db);
  const service = new SearchService(repo, db);

  const file = JSON.parse(readFileSync(path.resolve(__dirname, 'judgments.json'), 'utf8')) as {
    version: string;
    judgments: Judgment[];
  };

  const { version: weightsVersion } = await repo.activeWeights();
  const scoredAt = new Date();
  const rows: { id: string; recall: number; mrr: number; missing: string[] }[] = [];

  for (const j of file.judgments) {
    const result = await service.search({
      sort: 'relevance',
      limit: j.k,
      scoredAt,
      ...j.filters,
    } as SearchFilters);
    const names = result.results.map((r) => r.name);
    const hits = j.expected.filter((e) => names.includes(e));
    const recall = hits.length / j.expected.length;
    const firstRank = names.findIndex((n) => j.expected.includes(n));
    const mrr = firstRank === -1 ? 0 : 1 / (firstRank + 1);
    rows.push({
      id: j.id,
      recall,
      mrr,
      missing: j.expected.filter((e) => !names.includes(e)),
    });
  }

  const aggregate = {
    judgmentsVersion: file.version,
    weightsVersion,
    evaluatedAt: scoredAt.toISOString(),
    queries: rows.length,
    meanRecall: rows.reduce((a, r) => a + r.recall, 0) / rows.length,
    meanMrr: rows.reduce((a, r) => a + r.mrr, 0) / rows.length,
  };

  console.table(
    rows.map((r) => ({
      id: r.id,
      recall: r.recall.toFixed(2),
      mrr: r.mrr.toFixed(2),
      missing: r.missing.join(', '),
    })),
  );
  console.log(JSON.stringify(aggregate, null, 2));

  await pool.end();

  const gate = Number(process.env.EVAL_MIN_RECALL ?? 0.9);
  if (!process.env.EVAL_REPORT_ONLY && aggregate.meanRecall < gate) {
    console.error(`FAIL: mean recall ${aggregate.meanRecall.toFixed(3)} < gate ${gate}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

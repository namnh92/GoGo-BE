import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Db } from '@gogo/database';
import {
  DEFAULT_WEIGHTS,
  SearchRepository,
  type SearchRow,
} from '../infrastructure/search.repository';
import { SearchService } from './search.service';

vi.mock('../../reviews/infrastructure/gogo-ratings', () => ({
  loadGogoRatings: async () => new Map(),
}));

const filters = { sort: 'relevance' as const, limit: 1, scoredAt: new Date() };

describe('search verification identity snapshot (#774)', () => {
  it.each([false, true])(
    'selects revision-bound verification in the page (total=%s)',
    async (includeTotal) => {
      const queries: string[] = [];
      const execute = vi.fn(async (query: SQL) => {
        queries.push(new PgDialect().sqlToQuery(query).sql);
        return { rows: includeTotal ? [{ total_count: 0, results: [] }] : [] };
      });
      const db = { execute, transaction: async (fn: (tx: unknown) => unknown) => fn({ execute }) };
      await new SearchRepository(db as unknown as Db).search(
        { ...filters, includeTotal },
        DEFAULT_WEIGHTS,
      );
      const page = queries.at(-1)!;
      expect(page).toContain('as verification');
      expect(page).toContain('v.identity_revision = p.identity_revision');
    },
  );

  it.each([
    { status: 'unverified' as const },
    { status: 'verified' as const, verifiedAt: '2026-11-01T09:00:00.000Z' },
  ])(
    'keeps page verification %j when identity is edited and re-verified before facts',
    async (verification) => {
      const repo = {
        activeWeights: async () => ({ weights: DEFAULT_WEIGHTS, version: 'default' }),
        search: async () => [{ id: 'place', name: 'Old identity', verification } as SearchRow],
        hoursFor: async () => [],
        // Another transaction has edited the identity and verified its new revision.
        factsFor: async () => [
          {
            id: 'place',
            verification: { status: 'verified', verifiedAt: '2026-11-06T09:00:00.000Z' },
            taxonomies: [],
          },
        ],
      };
      const db = { execute: async () => ({ rows: [] }) };
      const result = await new SearchService(
        repo as unknown as SearchRepository,
        db as unknown as Db,
      ).search(filters);
      expect(result.results[0]).toMatchObject({ name: 'Old identity', verification });
    },
  );
});

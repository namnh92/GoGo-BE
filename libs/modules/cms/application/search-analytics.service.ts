import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { DB } from '../../shared/tokens';

/**
 * SE-006 (#36) — the search quality read.
 *
 * Two questions an editor actually has: is search getting worse, and which
 * queries are failing. Both are answerable from a daily aggregate; neither
 * needs a per-request log, and not keeping one is what keeps this free of PII.
 */

/**
 * A term is only named once enough different searches produced it. Below the
 * floor the row is real but the text is withheld and folded into a long-tail
 * bucket: a query one person typed is, in effect, that person's query, and
 * "no raw PII in search logs" is not satisfied by hoping nobody typed
 * anything identifying into a search box.
 */
export const TERM_VISIBILITY_FLOOR = 5;

export type SearchAnalytics = {
  days: number;
  totals: {
    searches: number;
    zeroResults: number;
    zeroResultRate: number;
    avgResults: number;
    avgLatencyMs: number;
  };
  trend: { day: string; searches: number; zeroResults: number; zeroResultRate: number }[];
  worstQueries: { query: string; searches: number; zeroResults: number; zeroResultRate: number }[];
  hiddenBelowFloor: { terms: number; searches: number; zeroResults: number };
};

type TotalsRow = {
  searches: number;
  zero_results: number;
  results_sum: number;
  latency_ms_sum: number;
};

@Injectable()
export class SearchAnalyticsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async overview(days: number, limit: number): Promise<SearchAnalytics> {
    const since = sql`current_date - ${days - 1}::int`;

    const totalsRows = await this.db.execute(sql`
      select coalesce(sum(searches), 0)::int as searches,
             coalesce(sum(zero_results), 0)::int as zero_results,
             coalesce(sum(results_sum), 0)::bigint as results_sum,
             coalesce(sum(latency_ms_sum), 0)::bigint as latency_ms_sum
      from search_query_daily where day >= ${since}
    `);
    const t = totalsRows.rows[0] as TotalsRow;
    const searches = Number(t.searches);

    const trendRows = await this.db.execute(sql`
      select day::text as day, sum(searches)::int as searches,
             sum(zero_results)::int as zero_results
      from search_query_daily where day >= ${since}
      group by day order by day
    `);

    // Only queries: a filter-only browse has no term to report, and folding it
    // in would make the "worst queries" list mostly one empty string.
    const worstRows = await this.db.execute(sql`
      select query_normalized, sum(searches)::int as searches,
             sum(zero_results)::int as zero_results
      from search_query_daily
      where day >= ${since} and has_query
      group by query_normalized
      having sum(searches) >= ${TERM_VISIBILITY_FLOOR}
      order by sum(zero_results) desc, sum(searches) desc
      limit ${limit}
    `);

    // Counted, not shown. Hiding the rows entirely would understate how much
    // of search is failing, which is the opposite of what this is for.
    const hiddenRows = await this.db.execute(sql`
      select count(*)::int as terms,
             coalesce(sum(searches), 0)::int as searches,
             coalesce(sum(zero_results), 0)::int as zero_results
      from (
        select query_normalized, sum(searches) as searches, sum(zero_results) as zero_results
        from search_query_daily
        where day >= ${since} and has_query
        group by query_normalized
        having sum(searches) < ${TERM_VISIBILITY_FLOOR}
      ) rare
    `);
    const hidden = hiddenRows.rows[0] as {
      terms: number;
      searches: number;
      zero_results: number;
    };

    const rate = (zero: number, all: number) => (all === 0 ? 0 : Number((zero / all).toFixed(4)));

    return {
      days,
      totals: {
        searches,
        zeroResults: Number(t.zero_results),
        zeroResultRate: rate(Number(t.zero_results), searches),
        avgResults: searches === 0 ? 0 : Number((Number(t.results_sum) / searches).toFixed(2)),
        avgLatencyMs: searches === 0 ? 0 : Math.round(Number(t.latency_ms_sum) / searches),
      },
      trend: (trendRows.rows as { day: string; searches: number; zero_results: number }[]).map(
        (r) => ({
          day: r.day,
          searches: Number(r.searches),
          zeroResults: Number(r.zero_results),
          zeroResultRate: rate(Number(r.zero_results), Number(r.searches)),
        }),
      ),
      worstQueries: (
        worstRows.rows as { query_normalized: string; searches: number; zero_results: number }[]
      ).map((r) => ({
        query: r.query_normalized,
        searches: Number(r.searches),
        zeroResults: Number(r.zero_results),
        zeroResultRate: rate(Number(r.zero_results), Number(r.searches)),
      })),
      hiddenBelowFloor: {
        terms: Number(hidden.terms),
        searches: Number(hidden.searches),
        zeroResults: Number(hidden.zero_results),
      },
    };
  }
}

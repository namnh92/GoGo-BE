import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import { utcDay, utcMonth } from '../domain/provider-pricing';

/**
 * COST-BE-002 (#335) — reading the ledger back.
 *
 * Separate from `DbUsageLedger` because writing and reading have opposite
 * requirements: the writer must never block a Google call, the reader is a
 * CMS request that can await freely. Keeping them apart also stops a reporting
 * query from ever being tempted onto the hot path.
 */
@Injectable()
export class UsageReportService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Billable units per operation so far this month, for one environment.
   *
   * Feeds the free-cap estimate. It is **GoGo's** month-to-date, not Google's:
   * the real free allowance pools per billing account per SKU across every
   * linked project, which no GoGo query can see. Anything derived from this is
   * therefore reported as `basis: ESTIMATED, confidence: MEDIUM`, and it is
   * never allowed near the budget guard, where an optimistic number authorises
   * real spend.
   */
  async monthToDateUnits(
    environment: string,
    day: string = utcDay(),
  ): Promise<Map<string, number>> {
    const month = utcMonth(day);
    const rows = await this.db.execute(sql`
      select operation, coalesce(sum(billable_units), 0)::bigint as units
        from provider_usage_daily
       where environment = ${environment}
         and to_char(day, 'YYYY-MM') = ${month}
       group by operation
    `);
    return new Map(
      (rows.rows as { operation: string; units: string }[]).map((r) => [
        r.operation,
        Number(r.units),
      ]),
    );
  }

  /** Usage for one UTC day — what the DEV verification in #335 compares. */
  async dailyUsage(environment: string, day: string = utcDay()) {
    const rows = await this.db.execute(sql`
      select operation, calls_attempted, calls_succeeded, billable_units
        from provider_usage_daily
       where environment = ${environment} and day = ${day}::date
       order by operation
    `);
    return (
      rows.rows as {
        operation: string;
        calls_attempted: number;
        calls_succeeded: number;
        billable_units: string;
      }[]
    ).map((r) => ({
      operation: r.operation,
      callsAttempted: Number(r.calls_attempted),
      callsSucceeded: Number(r.calls_succeeded),
      billableUnits: Number(r.billable_units),
    }));
  }
}

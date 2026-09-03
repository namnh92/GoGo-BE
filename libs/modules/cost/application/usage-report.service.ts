import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import {
  OPS_PROVIDERS,
  PRICING_CURRENCY,
  PRICING_VERSION,
  freeCapAdjustedCostMicros,
  microsToMinorUnits,
  pricingFor,
  providerOf,
  staticCostGaps,
  utcDay,
  type CostGap,
  type OpsProvider,
} from '../domain/provider-pricing';
import { isClientTelemetryEnabledAnywhere } from './mobile-usage.service';

/**
 * PR2 / COST-BE-002 (#335) — money, from the durable ledger.
 *
 * This is the half of the cost model that Grafana cannot do. The time-series
 * store keeps 14 days on the free tier and answers windows; a free cap is
 * monthly and an invoice is monthly, so "what have we spent this month" has
 * to come from `provider_usage_daily`.
 *
 * Three properties, in order of how easy they are to get wrong:
 *
 * 1. **Each day is priced with the rule in force on that day.** Rows are
 *    walked in date order and looked up per day, so a price change mid-month
 *    does not retroactively re-price the days before it.
 * 2. **The free cap is applied once, chronologically, per SKU.** Consuming it
 *    day by day in order is the only arrangement where the day that crosses
 *    the cap is the day the charges start. Applying the monthly cap to each
 *    day independently would zero the whole month.
 * 3. **An unpriced operation contributes nothing and says so.** It does not
 *    contribute zero — it lands in `gaps` with `kind: 'price_unknown'`, and
 *    its provider is left out of the money list entirely rather than reported
 *    as free.
 *
 * Everything here is labelled `basis: ESTIMATED, confidence: MEDIUM`: the free
 * cap is per billing account per SKU across every linked project, and this
 * approximates it per environment. It is a reporting estimate and must never
 * be mistaken for an invoice — no field here is called `billed` or `actual`.
 */

export type ProviderCostLine = {
  key: OpsProvider;
  /** Integer USD minor units, for the console's `formatMoney`. */
  today: number;
  monthToDate: number;
  currency: string;
  basis: 'estimated';
  /** The exact figures, so nothing is lost to cent rounding. */
  todayMicros: number;
  monthToDateMicros: number;
  billableUnitsToday: number;
  billableUnitsMonthToDate: number;
};

export type ProviderCostReport = {
  providers: ProviderCostLine[];
  /**
   * True once a durable source exists. With the ledger on, an operation with
   * no rows this month is a **measured** zero and is reported as one; that is
   * a different claim from the empty list this endpoint used to return, and
   * `gaps` carries everything still unmeasured.
   */
  sourcesConfigured: boolean;
  currency: string;
  pricingVersion: string;
  basis: 'ESTIMATED';
  confidence: 'MEDIUM';
  /** Newest `updated_at` in the window — how fresh these numbers are. */
  asOf: string | null;
  gaps: CostGap[];
};

type UsageRow = {
  day: string;
  operation: string;
  units: number;
  attempted: number;
  succeeded: number;
  updated_at: Date | string;
};

export class ProviderUsageReportService {
  constructor(
    private readonly db: Db,
    private readonly options: { environment: string; ledgerEnabled: boolean },
  ) {}

  /**
   * Today and month-to-date estimated spend per provider.
   *
   * `day` is injected by tests; production always asks about the current UTC
   * day, which is the day the ledger writes.
   */
  async report(day: string = utcDay()): Promise<ProviderCostReport> {
    const monthStart = `${day.slice(0, 7)}-01`;
    // #387 — whether the client-reported operations are being counted at all
    // is a runtime fact, and the gap list must not claim they are uncounted
    // while a phone is filling the ledger.
    const [rows, clientTelemetryEnabled] = await Promise.all([
      this.usageRows(monthStart, day),
      this.clientTelemetryEnabled(),
    ]);

    // Free cap is consumed per SKU, in date order. Operations that share a SKU
    // share the cap; today none do, but grouping by SKU is what makes that
    // true rather than accidental.
    const unitsSoFarBySku = new Map<string, number>();
    const todayMicros = new Map<OpsProvider, number>();
    const monthMicros = new Map<OpsProvider, number>();
    const todayUnits = new Map<OpsProvider, number>();
    const monthUnits = new Map<OpsProvider, number>();
    const unpriced = new Set<string>();
    const seenProviders = new Set<OpsProvider>();
    let asOf: string | null = null;

    for (const row of rows) {
      const provider = providerOf(row.operation);
      const updated = new Date(row.updated_at).toISOString();
      if (asOf === null || updated > asOf) asOf = updated;
      if (provider === null) continue;
      seenProviders.add(provider);
      monthUnits.set(provider, (monthUnits.get(provider) ?? 0) + row.units);
      if (row.day === day) todayUnits.set(provider, (todayUnits.get(provider) ?? 0) + row.units);

      const pricing = pricingFor(row.operation, row.day);
      const skuKey = pricing?.googleSku ?? row.operation;
      const consumed = unitsSoFarBySku.get(skuKey) ?? 0;
      const micros = freeCapAdjustedCostMicros(row.operation, row.day, row.units, consumed);
      unitsSoFarBySku.set(skuKey, consumed + row.units);

      if (micros === null) {
        // Measured units, unverified price. Never folded in as zero.
        unpriced.add(row.operation);
        continue;
      }
      monthMicros.set(provider, (monthMicros.get(provider) ?? 0) + micros);
      if (row.day === day) todayMicros.set(provider, (todayMicros.get(provider) ?? 0) + micros);
    }

    const gaps = this.gapsFor(day, unpriced, seenProviders, clientTelemetryEnabled);
    const unpricedProviders = new Set(
      [...unpriced].map((operation) => providerOf(operation)).filter((p): p is OpsProvider => !!p),
    );

    const providers = OPS_PROVIDERS.filter(
      (provider) =>
        // A provider whose spend cannot be stated is not stated. It is named in
        // `gaps` instead — a money row is a claim, and "we do not know" is not
        // one a currency symbol can express.
        provider !== 'maps_sdk' && !unpricedProviders.has(provider),
    ).map<ProviderCostLine>((provider) => {
      const t = todayMicros.get(provider) ?? 0;
      const m = monthMicros.get(provider) ?? 0;
      return {
        key: provider,
        today: microsToMinorUnits(t),
        monthToDate: microsToMinorUnits(m),
        currency: PRICING_CURRENCY,
        basis: 'estimated',
        todayMicros: t,
        monthToDateMicros: m,
        billableUnitsToday: todayUnits.get(provider) ?? 0,
        billableUnitsMonthToDate: monthUnits.get(provider) ?? 0,
      };
    });

    return {
      providers: this.options.ledgerEnabled ? providers : [],
      sourcesConfigured: this.options.ledgerEnabled,
      currency: PRICING_CURRENCY,
      pricingVersion: PRICING_VERSION,
      basis: 'ESTIMATED',
      confidence: 'MEDIUM',
      asOf,
      gaps,
    };
  }

  /**
   * The static gaps from the registry, plus anything this month's traffic
   * turned up that the registry has never heard of.
   *
   * An operation with no registry row is not free and not ignorable — it is
   * usually a new adapter call somebody shipped without pricing it, and it
   * should surface on the ops screen the first day it runs.
   */
  /**
   * #387 — `not_instrumented` is a claim about setup, not about traffic, and
   * the client-telemetry endpoint changes the setup at runtime.
   */
  private clientTelemetryEnabled(): Promise<boolean> {
    return isClientTelemetryEnabledAnywhere(this.db, this.options.environment);
  }

  private gapsFor(
    day: string,
    unpriced: Set<string>,
    seen: Set<OpsProvider>,
    clientTelemetryEnabled: boolean,
  ): CostGap[] {
    const gaps = staticCostGaps(day, { clientTelemetryEnabled });
    const known = new Set(gaps.map((g) => g.key));
    for (const operation of unpriced) {
      if (known.has(operation)) continue;
      gaps.push({
        key: operation,
        provider: providerOf(operation),
        kind: 'price_unknown',
        detail:
          'Calls were counted but the pricing registry has no row for this operation. Add one in libs/modules/cost/domain/provider-pricing.ts.',
      });
    }
    // A provider that produced traffic is not a gap, whatever the registry
    // says about tiers nobody called yet.
    return gaps.filter((gap) => gap.kind !== 'not_instrumented' || !seen.has(gap.provider!));
  }

  private async usageRows(from: string, to: string): Promise<UsageRow[]> {
    const result = await this.db.execute(sql`
      select
        to_char(day, 'YYYY-MM-DD') as day,
        operation,
        billable_units  as units,
        calls_attempted as attempted,
        calls_succeeded as succeeded,
        updated_at
      from provider_usage_daily
      where environment = ${this.options.environment}
        and day >= ${from}::date
        and day <= ${to}::date
      order by day asc, operation asc
    `);
    return (result.rows as unknown as (Omit<UsageRow, 'units'> & { units: number | string })[]).map(
      (row) => ({ ...row, units: Number(row.units) }),
    );
  }
}

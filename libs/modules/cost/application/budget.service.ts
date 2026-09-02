import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { writeAudit } from '../../shared/audit';
import {
  costBudgetStatus,
  forecastMonthMicros,
  inScope,
  spend,
  type CostBudgetScope,
  type CostBudgetStatus,
  type CostRow,
  type SpendBreakdown,
} from '../domain/budget';
import type { CostRegistry } from '../domain/registry';
import { utcDay } from '../domain/provider-pricing';

/**
 * COST-BE-020 (#379) — epic §32 (monthly budgets by TOTAL / PROVIDER /
 * SERVICE), §33 (forecast), §12 (precedence) over `provider_cost_daily`.
 *
 * What this is not: the hard guard. `ProviderBudgetService` reserves before a
 * job spends and refuses; this reports against a number an operator set.
 * Both exist on purpose (ADR-0012 roles table): one stops, one tells.
 */

export type BudgetRow = {
  id: string;
  environment: string;
  scope: CostBudgetScope;
  monthMicros: number;
  currency: string;
  note: string | null;
  updatedAt: string;
};

export type MonthOverview = {
  environment: string;
  month: string;
  today: string;
  spend: SpendBreakdown;
  forecastMicros: number | null;
  budgets: CostBudgetStatus[];
  /** Spend per provider → service, after precedence, for the callers that render rows. */
  byService: {
    providerId: string;
    serviceId: string;
    micros: number;
    byBasis: SpendBreakdown['byBasis'];
  }[];
};

export class BudgetService {
  constructor(
    private readonly db: Db,
    private readonly registry: CostRegistry,
    private readonly options: { environment: string; now?: () => Date },
  ) {}

  async list(): Promise<BudgetRow[]> {
    const { rows } = await this.db.execute(sql`
      select id, environment, scope_kind, scope_id, month_micros, currency, note, updated_at
      from cost_budgets where environment = ${this.options.environment}
      order by scope_kind, scope_id nulls first
    `);
    return (rows as unknown as RawBudget[]).map(toBudgetRow);
  }

  /**
   * Set or replace the budget for a scope. The scope must exist in the
   * registry (a budget for a provider nobody registered is a typo, not a
   * plan). Audited with the before/after amount.
   */
  async upsert(
    input: { scope: CostBudgetScope; monthMicros: number; currency?: string; note?: string | null },
    actor: { adminId: string | null },
  ): Promise<BudgetRow> {
    if (!Number.isInteger(input.monthMicros) || input.monthMicros < 0) {
      throw new Error('monthMicros must be a non-negative integer');
    }
    if (input.scope.kind === 'PROVIDER' && this.registry.provider(input.scope.id) === null) {
      throw new Error(`unknown provider ${input.scope.id}`);
    }
    if (input.scope.kind === 'SERVICE' && this.registry.service(input.scope.id) === null) {
      throw new Error(`unknown service ${input.scope.id}`);
    }
    const env = this.options.environment;
    const before = (await this.list()).find((b) => sameScope(b.scope, input.scope)) ?? null;
    const { rows } = await this.db.execute(sql`
      insert into cost_budgets (environment, scope_kind, scope_id, month_micros, currency, note, created_by, updated_by)
      values (${env}, ${input.scope.kind}, ${input.scope.id}, ${input.monthMicros}, ${input.currency ?? 'USD'},
              ${input.note ?? null}, ${actor.adminId}, ${actor.adminId})
      on conflict (environment, scope_kind, coalesce(scope_id, '')) do update set
        month_micros = excluded.month_micros,
        currency = excluded.currency,
        note = excluded.note,
        updated_by = excluded.updated_by,
        updated_at = now()
      returning id, environment, scope_kind, scope_id, month_micros, currency, note, updated_at
    `);
    const row = toBudgetRow(rows[0] as unknown as RawBudget);
    await writeAudit(this.db, {
      actorType: actor.adminId ? 'admin' : 'system',
      actorId: actor.adminId,
      action: 'cost.budget.set',
      resourceType: 'cost_budget',
      resourceId: row.id,
      diff: {
        scope: `${input.scope.kind}${input.scope.id ? `:${input.scope.id}` : ''}`,
        monthMicros: { before: before?.monthMicros ?? null, after: row.monthMicros },
      },
    });
    return row;
  }

  async remove(scope: CostBudgetScope, actor: { adminId: string | null }): Promise<boolean> {
    const existing = (await this.list()).find((b) => sameScope(b.scope, scope));
    if (!existing) return false;
    await this.db.execute(sql`delete from cost_budgets where id = ${existing.id}`);
    await writeAudit(this.db, {
      actorType: actor.adminId ? 'admin' : 'system',
      actorId: actor.adminId,
      action: 'cost.budget.removed',
      resourceType: 'cost_budget',
      resourceId: existing.id,
      diff: { monthMicros: { before: existing.monthMicros, after: null } },
    });
    return true;
  }

  /**
   * The month as the Cost Center reads it: spend after precedence, forecast,
   * every budget's status, and the per-service split. `month` is `YYYY-MM`
   * (UTC); defaults to the current one.
   */
  async overview(month?: string): Promise<MonthOverview> {
    const now = (this.options.now ?? (() => new Date()))();
    const today = utcDay(now);
    const m = month ?? today.slice(0, 7);
    const rows = await this.costRows(m);
    const total = spend(rows);
    const forecast = forecastMonthMicros(total.micros, m, today, rows.length > 0);
    const budgets = (await this.list()).map((b) => {
      const scoped = rows.filter((r) => inScope(r, b.scope));
      const used = spend(scoped);
      const projected = forecastMonthMicros(used.micros, m, today, scoped.length > 0);
      return costBudgetStatus(b.scope, b.monthMicros, b.currency, used, projected);
    });
    const services = new Map<string, CostRow[]>();
    for (const r of rows) {
      const k = `${r.providerId}|${r.serviceId}`;
      const g = services.get(k);
      if (g) g.push(r);
      else services.set(k, [r]);
    }
    const byService = [...services.entries()]
      .map(([k, group]) => {
        const [providerId, serviceId] = k.split('|') as [string, string];
        const s = spend(group);
        return { providerId, serviceId, micros: s.micros, byBasis: s.byBasis };
      })
      .sort((a, b) => a.serviceId.localeCompare(b.serviceId));
    return {
      environment: this.options.environment,
      month: m,
      today,
      spend: total,
      forecastMicros: forecast,
      budgets,
      byService,
    };
  }

  private async costRows(month: string): Promise<CostRow[]> {
    const from = `${month}-01`;
    const { rows } = await this.db.execute(sql`
      select to_char(day, 'YYYY-MM-DD') as day, provider_id, service_id, operation_id, usage_metric_id,
             billing_sku_id, amount_micros, currency, basis, confidence, source
      from provider_cost_daily
      where environment = ${this.options.environment}
        and day >= ${from}::date
        and day < (${from}::date + interval '1 month')
    `);
    return (rows as unknown as RawCost[]).map((r) => ({
      day: r.day,
      providerId: r.provider_id,
      serviceId: r.service_id,
      operationId: r.operation_id,
      usageMetricId: r.usage_metric_id,
      billingSkuId: r.billing_sku_id,
      amountMicros: Number(r.amount_micros),
      currency: r.currency,
      basis: r.basis,
      confidence: r.confidence,
      source: r.source,
    }));
  }
}

type RawBudget = {
  id: string;
  environment: string;
  scope_kind: CostBudgetScope['kind'];
  scope_id: string | null;
  month_micros: number | string;
  currency: string;
  note: string | null;
  updated_at: Date | string;
};

type RawCost = {
  day: string;
  provider_id: string;
  service_id: string;
  operation_id: string | null;
  usage_metric_id: string | null;
  billing_sku_id: string | null;
  amount_micros: number | string;
  currency: string;
  basis: CostRow['basis'];
  confidence: CostRow['confidence'];
  source: string;
};

function toBudgetRow(r: RawBudget): BudgetRow {
  const scope: CostBudgetScope =
    r.scope_kind === 'TOTAL'
      ? { kind: 'TOTAL', id: null }
      : { kind: r.scope_kind, id: r.scope_id as string };
  return {
    id: r.id,
    environment: r.environment,
    scope,
    monthMicros: Number(r.month_micros),
    currency: r.currency.trim(),
    note: r.note,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function sameScope(a: CostBudgetScope, b: CostBudgetScope): boolean {
  return a.kind === b.kind && a.id === b.id;
}

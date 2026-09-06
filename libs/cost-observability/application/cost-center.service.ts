import type { RuntimeStateReader } from '@gogo/observability';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import {
  spend,
  winningRows,
  type Confidence,
  type CostBasis,
  type CostBudgetStatus,
  type CostKind,
  type CostRow,
} from '../domain/budget';
import type { MonthForecast } from '../domain/forecast';
import type { Capability } from '../domain/capabilities';
import {
  costDataFreshness,
  providerCostSourceKind,
  serviceCostSourceKind,
  type CostSource,
} from '../domain/cost-source';
import { freshnessStatus, type FreshnessStatus } from '../domain/freshness';
import {
  bootstrapConnection,
  providerRuntime,
  serviceRuntime,
  type ProviderRuntime,
  type ServiceRuntime,
} from '../domain/runtime-coverage';
import type {
  CostRegistry,
  OperationDefinition,
  ProviderDefinition,
  ProviderStatus,
  ServiceCategory,
  ServiceDefinition,
} from '../domain/registry';
import { utcDay } from '../pricing/provider-pricing';
import { BudgetService, readManualItemFacts, toCostRow, type RawCost } from './budget.service';
import { chargeDays, type ManualCostItemFacts } from '../domain/manual-cost';
import { refuseAudit } from '../ports/audit.port';

/**
 * COST-BE-022 (#381) — epic §34 (API), §35 (rows and cards), §36 (generic
 * CMS), §12 (precedence), §23 (freshness), §44.2/§44.3 (no provider switch).
 *
 * The Cost Center read model, keyed by registry ids. Every row here exists
 * because the registry names it — a provider added to `COST_REGISTRY_DATA`
 * appears in `providers()` with nothing changed in this file — and every
 * number on a row went through `spend()` first, so ACTUAL and ESTIMATED for
 * the same spend are never added and an absent number is `null`, not 0.
 *
 * Three claims a row can make about money, and they are kept apart:
 *
 * - `KNOWN`: at least one cost row in the window. `spendMicros` is a number.
 * - `MEASURED_ZERO`: no cost row and no usage, but the service has an
 *   instrumented operation and a source covering the provider is FRESH or
 *   STALE — someone was counting, and counted nothing. `spendMicros` is 0.
 * - `UNKNOWN`: nothing else. `spendMicros` is `null`. The CMS renders "—" and
 *   "Chưa có nguồn chi phí" (epic §35), never `$0`.
 *
 * The daily tables cannot answer `1h`; the windows are days. Cards are
 * month-shaped whatever the window (a free cap and an invoice are monthly).
 */

export const COST_WINDOWS = ['today', '7d', '30d', 'mtd'] as const;
export type CostWindow = (typeof COST_WINDOWS)[number];

export type DateRange = { from: string; to: string };

export function windowRange(window: CostWindow, today: string): DateRange {
  switch (window) {
    case 'today':
      return { from: today, to: today };
    case '7d':
      return { from: shiftDay(today, -6), to: today };
    case '30d':
      return { from: shiftDay(today, -29), to: today };
    case 'mtd':
      return { from: `${today.slice(0, 7)}-01`, to: today };
  }
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ── usage ────────────────────────────────────────────────────────────────────

/** One `provider_usage_meter_daily` row, as this reader needs it. */
export type UsageRow = {
  day: string;
  providerId: string;
  serviceId: string;
  operationId: string | null;
  usageMetricId: string;
  billingSkuId: string | null;
  quantity: number;
  unit: string;
  source: string;
  confidence: Confidence;
  updatedAt: string;
};

export type UsageLine = {
  /** Registry meter id (`<operation|service>/<metric>`), `null` when the meter is not registered. */
  meterId: string | null;
  operationId: string | null;
  usageMetricId: string;
  billingSkuId: string | null;
  unit: string;
  billable: boolean;
  /** Sum over the window after per-day source precedence. */
  quantity: number;
  /** Which sources contributed a day. Never summed with each other. */
  sources: string[];
};

const CONFIDENCE_RANK: Record<Confidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

const meterKey = (r: Pick<UsageRow, 'operationId' | 'usageMetricId' | 'billingSkuId'>) =>
  `${r.operationId ?? ''}|${r.usageMetricId}|${r.billingSkuId ?? ''}`;

/**
 * Usage lines per meter. Two sources never share a row and never sum (the
 * schema's rule): for one (day, meter) the most confident source is taken —
 * the ledger over a Prometheus backfill — and the winners are summed over
 * the window's days.
 */
export function usageLines(rows: readonly UsageRow[], registry: CostRegistry): UsageLine[] {
  const perDay = new Map<string, UsageRow[]>();
  for (const r of rows) {
    const k = `${r.day}|${meterKey(r)}`;
    const g = perDay.get(k);
    if (g) g.push(r);
    else perDay.set(k, [r]);
  }
  const lines = new Map<string, UsageLine>();
  for (const group of perDay.values()) {
    const winner = [...group].sort(
      (a, b) =>
        CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
        a.source.localeCompare(b.source),
    )[0]!;
    const k = meterKey(winner);
    const existing = lines.get(k);
    if (existing) {
      existing.quantity += winner.quantity;
      if (!existing.sources.includes(winner.source)) existing.sources.push(winner.source);
      continue;
    }
    const meterId = `${winner.operationId ?? winner.serviceId}/${winner.usageMetricId}`;
    const meter = registry.meter(meterId);
    lines.set(k, {
      meterId: meter ? meter.id : null,
      operationId: winner.operationId,
      usageMetricId: winner.usageMetricId,
      billingSkuId: winner.billingSkuId,
      unit: winner.unit,
      billable: meter ? meter.billable : winner.billingSkuId !== null,
      quantity: winner.quantity,
      sources: [winner.source],
    });
  }
  return [...lines.values()]
    .map((l) => ({ ...l, sources: [...l.sources].sort() }))
    .sort((a, b) => meterKey(a).localeCompare(meterKey(b)));
}

// ── freshness ────────────────────────────────────────────────────────────────

/** One `cost_source_freshness` row's facts. */
export type FreshnessSourceRow = {
  sourceId: string;
  providerId: string;
  serviceId: string | null;
  lastSuccessfulAt: Date | null;
  lastAttemptAt: Date | null;
  sourceAsOf: Date | null;
  staleAfterS: number;
  consecutiveFailures: number;
};

export type FreshnessSource = {
  sourceId: string;
  serviceId: string | null;
  status: FreshnessStatus;
  lastSuccessfulAt: string | null;
  lastAttemptAt: string | null;
  sourceAsOf: string | null;
  staleAfterS: number;
  consecutiveFailures: number;
};

export type RowFreshness = {
  /** The worst covering source. No source at all is `UNKNOWN`. */
  status: FreshnessStatus;
  /** Newest `sourceAsOf` across covering sources. */
  sourceAsOf: string | null;
  sources: FreshnessSource[];
};

/** Worst-first, epic §23 read for a row: one bad source taints the row. */
const FRESHNESS_RANK: Record<FreshnessStatus, number> = {
  FRESH: 0,
  STALE: 1,
  UNKNOWN: 2,
  UNAVAILABLE: 3,
};

export function rowFreshness(sources: readonly FreshnessSourceRow[], now: Date): RowFreshness {
  if (sources.length === 0) return { status: 'UNKNOWN', sourceAsOf: null, sources: [] };
  const out: FreshnessSource[] = sources.map((s) => ({
    sourceId: s.sourceId,
    serviceId: s.serviceId,
    status: freshnessStatus(
      {
        lastSuccessfulAt: s.lastSuccessfulAt,
        lastAttemptAt: s.lastAttemptAt,
        staleAfterMs: s.staleAfterS * 1000,
        consecutiveFailures: s.consecutiveFailures,
      },
      now,
    ),
    lastSuccessfulAt: s.lastSuccessfulAt?.toISOString() ?? null,
    lastAttemptAt: s.lastAttemptAt?.toISOString() ?? null,
    sourceAsOf: s.sourceAsOf?.toISOString() ?? null,
    staleAfterS: s.staleAfterS,
    consecutiveFailures: s.consecutiveFailures,
  }));
  const status = out.reduce<FreshnessStatus>(
    (worst, s) => (FRESHNESS_RANK[s.status] > FRESHNESS_RANK[worst] ? s.status : worst),
    'FRESH',
  );
  const asOf = out
    .map((s) => s.sourceAsOf)
    .filter((v): v is string => v !== null)
    .sort()
    .at(-1);
  return { status, sourceAsOf: asOf ?? null, sources: out.sort(bySourceId) };
}

const bySourceId = (a: FreshnessSource, b: FreshnessSource) => a.sourceId.localeCompare(b.sourceId);

/** A source covers a service when it names it, or names only the provider. */
export function sourcesForService(
  all: readonly FreshnessSourceRow[],
  providerId: string,
  serviceId: string,
): FreshnessSourceRow[] {
  return all.filter(
    (s) => s.providerId === providerId && (s.serviceId === null || s.serviceId === serviceId),
  );
}

// ── money ────────────────────────────────────────────────────────────────────

export type CostStatus = 'KNOWN' | 'MEASURED_ZERO' | 'UNKNOWN';
export type RowBasis = CostBasis | 'MIXED' | 'UNKNOWN';

export type MoneyFacts = {
  /** After precedence. `null` = unknown, never 0; 0 only for a measured zero. */
  spendMicros: number | null;
  /** Best estimate per key, shadowed or not — the reconciliation counterpart of `actualMicros`. `null` when no ESTIMATED row. */
  estimatedMicros: number | null;
  actualMicros: number | null;
  fixedMicros: number | null;
  manualMicros: number | null;
  /** Estimates an ACTUAL row displaced; part of `estimatedMicros`, never of `spendMicros`. */
  shadowedEstimatedMicros: number;
  basis: RowBasis;
  /** Lowest confidence among the rows that count. */
  confidence: Confidence | null;
  currency: string | null;
  mixedCurrency: boolean;
  costStatus: CostStatus;
};

const UNKNOWN_MONEY: MoneyFacts = {
  spendMicros: null,
  estimatedMicros: null,
  actualMicros: null,
  fixedMicros: null,
  manualMicros: null,
  shadowedEstimatedMicros: 0,
  basis: 'UNKNOWN',
  confidence: null,
  currency: null,
  mixedCurrency: false,
  costStatus: 'UNKNOWN',
};

/**
 * A measured zero is stated the way the legacy endpoint states one — as an
 * estimate over measured usage — so the CMS reads both surfaces alike.
 */
const MEASURED_ZERO_MONEY: MoneyFacts = {
  ...UNKNOWN_MONEY,
  spendMicros: 0,
  estimatedMicros: 0,
  basis: 'ESTIMATED',
  confidence: 'MEDIUM',
  costStatus: 'MEASURED_ZERO',
};

export function moneyFacts(rows: readonly CostRow[], measuredZero: boolean): MoneyFacts {
  if (rows.length === 0) return measuredZero ? MEASURED_ZERO_MONEY : UNKNOWN_MONEY;
  const s = spend(rows);
  const winners = winningRows(rows);
  const bases = new Set<CostBasis>(winners.map((r) => r.basis));
  const has = (b: CostBasis) => rows.some((r) => r.basis === b);
  const confidence = winners.reduce<Confidence>(
    (low, r) => (CONFIDENCE_RANK[r.confidence] < CONFIDENCE_RANK[low] ? r.confidence : low),
    'HIGH',
  );
  return {
    spendMicros: s.micros,
    estimatedMicros: has('ESTIMATED') ? s.byBasis.ESTIMATED + s.shadowedEstimatedMicros : null,
    actualMicros: has('ACTUAL') ? s.byBasis.ACTUAL : null,
    fixedMicros: has('FIXED') ? s.byBasis.FIXED : null,
    manualMicros: has('MANUAL') ? s.byBasis.MANUAL : null,
    shadowedEstimatedMicros: s.shadowedEstimatedMicros,
    basis: bases.size === 1 ? [...bases][0]! : 'MIXED',
    confidence,
    currency: s.currency,
    mixedCurrency: s.mixedCurrency,
    costStatus: 'KNOWN',
  };
}

// ── rows ─────────────────────────────────────────────────────────────────────

export type CostRowWithMeta = CostRow & { updatedAt: string };

export type ServiceCostRow = MoneyFacts & {
  serviceId: string;
  providerId: string;
  displayName: string;
  category: ServiceCategory;
  capabilities: readonly Capability[];
  /** `runtime.coverage` is FULL or PARTIAL. Kept for readers of the first contract; false = a gap, never a zero. */
  instrumented: boolean;
  /** ADR-0014 — what is measured, from the registry alone. */
  runtime: ServiceRuntime;
  /** ADR-0014 — how money gets in, and whether it is current. Independent of `runtime`. */
  cost: CostSource;
  usage: UsageLine[];
  /** No QUOTA collector exists yet (epic §6); `null` until one does. */
  quota: null;
  /** Newest write among the rows behind this row. */
  lastUpdated: string | null;
  freshness: RowFreshness;
};

export type OperationUsage = {
  operationId: string;
  displayName: string | null;
  instrumented: boolean;
  /** `true` when the operation is not in the registry — a label somebody forgot to fold. */
  unregistered: boolean;
  meters: UsageLine[];
};

export type ServiceCostDetail = ServiceCostRow & { operations: OperationUsage[] };

export type ProviderCostRow = MoneyFacts & {
  providerId: string;
  displayName: string;
  /** Integration lifecycle only — never a cost or telemetry fact (ADR-0014). */
  status: ProviderStatus;
  capabilities: readonly Capability[];
  /** ADR-0014 — coverage over every service with a runtime surface, with counts for the drill-down. */
  runtime: ProviderRuntime;
  /** ADR-0014 — how money gets in, and whether it is current. Independent of `runtime`. */
  cost: CostSource;
  billingTimezone: string | null;
  /** Services with `costStatus: UNKNOWN` — what the "unknown" card counts. */
  unknownServices: string[];
  services: ServiceCostRow[];
  lastUpdated: string | null;
  freshness: RowFreshness;
};

export type RowInputs = {
  costRows: readonly CostRowWithMeta[];
  usageRows: readonly UsageRow[];
  freshness: readonly FreshnessSourceRow[];
  /** ADR-0015 — the manual items, whose billing schedule says what MANUAL rows are due. */
  manualItems: readonly ManualCostItemFacts[];
  /** The days the rows were read for; what is due is judged inside it. */
  range: DateRange;
  now: Date;
  /** #427 — this process's boot-time outcomes, for `runtime.connection`. Absent in a worker or a test. */
  runtimeState?: RuntimeStateReader | null;
};

const newest = (values: readonly string[]): string | null =>
  values.length === 0 ? null : [...values].sort().at(-1)!;

/**
 * ADR-0014 — the cost dimension of a row. `rowFreshness` answers UNKNOWN both
 * for "no source covers this" and for "a source that never ran", and only the
 * second is a source's status; the first is passed as `null` so the rows can
 * decide instead.
 */
function costSource(
  kind: CostSource['kind'],
  freshness: RowFreshness,
  costRows: readonly CostRow[],
  manualItems: readonly ManualCostItemFacts[],
  range: DateRange,
  now: Date,
): CostSource {
  const today = utcDay(now);
  const days = (predicate: (r: CostRow) => boolean) => [
    ...new Set(costRows.filter(predicate).map((r) => r.day)),
  ];
  // ADR-0015: a manual row is a charge on its billing day. What should be
  // there is every billing day due so far inside the window the rows were
  // read for — never "a row for today".
  const to = range.to < today ? range.to : today;
  const expectedManualDays = [
    ...new Set(manualItems.flatMap((item) => chargeDays(item, { from: range.from, to }))),
  ];
  return {
    kind,
    freshness: costDataFreshness({
      kind,
      sourceStatus: freshness.sources.length > 0 ? freshness.status : null,
      rowDays: {
        manual: days((r) => r.basis === 'MANUAL'),
        automatic: days((r) => r.basis !== 'MANUAL'),
      },
      expectedManualDays,
      today,
    }),
  };
}

export function buildServiceRow(
  service: ServiceDefinition,
  registry: CostRegistry,
  input: RowInputs,
): ServiceCostRow {
  const costRows = input.costRows.filter((r) => r.serviceId === service.id);
  const usageRows = input.usageRows.filter((r) => r.serviceId === service.id);
  const usage = usageLines(usageRows, registry);
  const freshness = rowFreshness(
    sourcesForService(input.freshness, service.providerId, service.id),
    input.now,
  );
  const runtime = {
    ...serviceRuntime(service),
    connection: bootstrapConnection(service, input.runtimeState),
  };
  const instrumented = runtime.coverage === 'FULL' || runtime.coverage === 'PARTIAL';
  const measuredZero =
    costRows.length === 0 &&
    !usage.some((l) => l.quantity > 0) &&
    instrumented &&
    (freshness.status === 'FRESH' || freshness.status === 'STALE');
  const provider = registry.provider(service.providerId);
  const kind = serviceCostSourceKind(service, provider ?? { capabilities: [] });
  return {
    serviceId: service.id,
    providerId: service.providerId,
    displayName: service.displayName,
    category: service.category,
    capabilities: service.capabilities,
    instrumented,
    runtime,
    cost: costSource(
      kind,
      freshness,
      costRows,
      input.manualItems.filter((i) => i.serviceId === service.id),
      input.range,
      input.now,
    ),
    ...moneyFacts(costRows, measuredZero),
    usage,
    quota: null,
    lastUpdated: newest([...costRows, ...usageRows].map((r) => r.updatedAt)),
    freshness,
  };
}

export function buildServiceDetail(
  service: ServiceDefinition,
  registry: CostRegistry,
  input: RowInputs,
): ServiceCostDetail {
  const row = buildServiceRow(service, registry, input);
  const byOperation = new Map<string, UsageLine[]>();
  for (const line of row.usage) {
    if (line.operationId === null) continue;
    const g = byOperation.get(line.operationId);
    if (g) g.push(line);
    else byOperation.set(line.operationId, [line]);
  }
  const operations: OperationUsage[] = service.operations.map((op: OperationDefinition) => ({
    operationId: op.id,
    displayName: op.displayName,
    instrumented: op.instrumented,
    unregistered: false,
    meters: byOperation.get(op.id) ?? [],
  }));
  for (const [operationId, meters] of byOperation) {
    if (service.operations.some((o) => o.id === operationId)) continue;
    operations.push({
      operationId,
      displayName: null,
      instrumented: true,
      unregistered: true,
      meters,
    });
  }
  return { ...row, operations };
}

export function buildProviderRow(
  provider: ProviderDefinition,
  registry: CostRegistry,
  input: RowInputs,
): ProviderCostRow {
  const services = provider.services.map((s) => buildServiceRow(s, registry, input));
  // Every row of the provider's, including any under a service id nobody
  // registered: money attributed to the provider is not dropped because a
  // service label is stale.
  const costRows = input.costRows.filter((r) => r.providerId === provider.id);
  const usageRows = input.usageRows.filter((r) => r.providerId === provider.id);
  const freshness = rowFreshness(
    input.freshness.filter((s) => s.providerId === provider.id),
    input.now,
  );
  const measured = services.filter((s) => s.instrumented);
  const measuredZero =
    costRows.length === 0 &&
    measured.length > 0 &&
    measured.every((s) => s.costStatus === 'MEASURED_ZERO');
  return {
    providerId: provider.id,
    displayName: provider.displayName,
    status: provider.status,
    capabilities: provider.capabilities,
    runtime: providerRuntime(provider),
    cost: costSource(
      providerCostSourceKind(provider),
      freshness,
      costRows,
      input.manualItems.filter((i) => i.providerId === provider.id),
      input.range,
      input.now,
    ),
    billingTimezone: provider.billingTimezone ?? null,
    ...moneyFacts(costRows, measuredZero),
    unknownServices: services.filter((s) => s.costStatus === 'UNKNOWN').map((s) => s.serviceId),
    services,
    lastUpdated: newest([...costRows, ...usageRows].map((r) => r.updatedAt)),
    freshness,
  };
}

// ── cards ────────────────────────────────────────────────────────────────────

export type CostCard = {
  /** `null` when no cost row is in scope — unknown, not zero. */
  spendMicros: number | null;
  byBasis: Record<CostBasis, number> | null;
  /** The same money by how it is billed (ADR-0015); `null` with `spendMicros`. */
  byKind: Record<CostKind, number> | null;
  currency: string | null;
  mixedCurrency: boolean;
  /** How many services contributed a row. */
  services: number;
};

export function costCard(rows: readonly CostRow[]): CostCard {
  if (rows.length === 0) {
    return {
      spendMicros: null,
      byBasis: null,
      byKind: null,
      currency: null,
      mixedCurrency: false,
      services: 0,
    };
  }
  const s = spend(rows);
  return {
    spendMicros: s.micros,
    byBasis: s.byBasis,
    byKind: s.byKind,
    currency: s.currency,
    mixedCurrency: s.mixedCurrency,
    services: new Set(rows.map((r) => r.serviceId)).size,
  };
}

export type CostCards = {
  today: CostCard & { day: string };
  monthToDate: CostCard & { month: string };
  /**
   * ADR-0015 — three numbers kept apart: `forecast.actual` (recognised so
   * far), `forecast.cash` (end-of-month cash), `forecast.runRate`
   * (normalised monthly). Replaces the MTD-extrapolated `projected` card.
   */
  forecast: MonthForecast;
  budget: {
    /** The TOTAL scope's status, `null` when no TOTAL budget is set. */
    total: CostBudgetStatus | null;
    budgets: CostBudgetStatus[];
  };
  unknown: {
    providerIds: string[];
    serviceIds: string[];
  };
  /** Epic §20/§21 — month-to-date spend of the registry's `internal` services. */
  costOfMonitoring: CostCard & { serviceIds: string[] };
};

export type CostOverview = {
  environment: string;
  ledgerEnabled: boolean;
  window: CostWindow;
  range: DateRange;
  month: string;
  today: string;
  generatedAt: string;
  cards: CostCards;
  providerRows: ProviderCostRow[];
  /** Ids in the tables that the registry does not know. Money there is reported nowhere else. */
  unattributed: { providerIds: string[]; serviceIds: string[] };
};

export type CostCenterOptions = {
  environment: string;
  ledgerEnabled: boolean;
  now?: () => Date;
  /** #427 — the API process's `RuntimeStateStore`; `runtime.connection` reads from it. */
  runtimeState?: RuntimeStateReader | null;
};

export class CostCenterService {
  private readonly budgets: BudgetService;

  constructor(
    private readonly db: Db,
    private readonly registry: CostRegistry,
    private readonly options: CostCenterOptions,
  ) {
    // Read-only: this service asks the budgets for a month's status and never
    // calls a method that writes one. `refuseAudit` throws rather than
    // silently dropping a row if that ever stops being true (#388).
    this.budgets = new BudgetService(db, registry, {
      environment: options.environment,
      ...(options.now ? { now: options.now } : {}),
      audit: refuseAudit,
    });
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  async overview(window: CostWindow): Promise<CostOverview> {
    const now = this.now();
    const today = utcDay(now);
    const month = today.slice(0, 7);
    const range = windowRange(window, today);
    const [monthOverview, windowInputs, monthCost] = await Promise.all([
      this.budgets.overview(month),
      this.inputs(range, now),
      // The month's rows for the cards; the window's rows for the table. For
      // `mtd` they are the same rows read twice, which is cheaper than a
      // second code path.
      window === 'mtd' ? null : this.costRows(windowRange('mtd', today)),
    ]);
    const monthRows = monthCost ?? windowInputs.costRows;
    const providerRows = this.registry
      .providers()
      .map((p) => buildProviderRow(p, this.registry, windowInputs));
    const internal = this.registry
      .services()
      .filter((s) => s.category === 'internal')
      .map((s) => s.id);
    const total = monthOverview.budgets.find((b) => b.scope.kind === 'TOTAL') ?? null;
    return {
      environment: this.options.environment,
      ledgerEnabled: this.options.ledgerEnabled,
      window,
      range,
      month,
      today,
      generatedAt: now.toISOString(),
      cards: {
        today: { ...costCard(monthRows.filter((r) => r.day === today)), day: today },
        monthToDate: { ...costCard(monthRows), month },
        forecast: monthOverview.forecast,
        budget: { total, budgets: monthOverview.budgets },
        unknown: {
          providerIds: providerRows
            .filter((p) => p.costStatus === 'UNKNOWN')
            .map((p) => p.providerId),
          serviceIds: providerRows.flatMap((p) => p.unknownServices),
        },
        costOfMonitoring: {
          ...costCard(monthRows.filter((r) => internal.includes(r.serviceId))),
          serviceIds: internal,
        },
      },
      providerRows,
      unattributed: this.unattributed(windowInputs),
    };
  }

  async providers(window: CostWindow): Promise<ProviderCostRow[]> {
    const now = this.now();
    const input = await this.inputs(windowRange(window, utcDay(now)), now);
    return this.registry.providers().map((p) => buildProviderRow(p, this.registry, input));
  }

  /** `null` when the registry has no such provider. */
  async provider(providerId: string, window: CostWindow): Promise<ProviderCostRow | null> {
    const provider = this.registry.provider(providerId);
    if (provider === null) return null;
    const now = this.now();
    const input = await this.inputs(windowRange(window, utcDay(now)), now);
    return buildProviderRow(provider, this.registry, input);
  }

  /** `null` when the service is unknown or belongs to another provider. */
  async service(
    providerId: string,
    serviceId: string,
    window: CostWindow,
  ): Promise<ServiceCostDetail | null> {
    const service = this.registry.service(serviceId);
    if (service === null || service.providerId !== providerId) return null;
    const now = this.now();
    const input = await this.inputs(windowRange(window, utcDay(now)), now);
    return buildServiceDetail(service, this.registry, input);
  }

  private unattributed(input: RowInputs): CostOverview['unattributed'] {
    const providerIds = new Set<string>();
    const serviceIds = new Set<string>();
    for (const r of [...input.costRows, ...input.usageRows]) {
      if (this.registry.provider(r.providerId) === null) providerIds.add(r.providerId);
      if (this.registry.service(r.serviceId) === null) serviceIds.add(r.serviceId);
    }
    return { providerIds: [...providerIds].sort(), serviceIds: [...serviceIds].sort() };
  }

  private async inputs(range: DateRange, now: Date): Promise<RowInputs> {
    const [costRows, usageRows, freshness, manualItems] = await Promise.all([
      this.costRows(range),
      this.usageRows(range),
      this.freshnessRows(),
      readManualItemFacts(this.db, this.options.environment),
    ]);
    return {
      costRows,
      usageRows,
      freshness,
      manualItems,
      range,
      now,
      runtimeState: this.options.runtimeState ?? null,
    };
  }

  private async costRows(range: DateRange): Promise<CostRowWithMeta[]> {
    const { rows } = await this.db.execute(sql`
      select to_char(day, 'YYYY-MM-DD') as day, provider_id, service_id, operation_id, usage_metric_id,
             billing_sku_id, amount_micros, currency, basis, confidence, source,
             cost_kind, billing_cadence, period_amount_micros, updated_at
      from provider_cost_daily
      where environment = ${this.options.environment}
        and day >= ${range.from}::date and day <= ${range.to}::date
    `);
    return (rows as unknown as (RawCost & { updated_at: Date | string })[]).map((r) => ({
      ...toCostRow(r),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
  }

  private async usageRows(range: DateRange): Promise<UsageRow[]> {
    const { rows } = await this.db.execute(sql`
      select to_char(day, 'YYYY-MM-DD') as day, provider_id, service_id, operation_id, usage_metric_id,
             billing_sku_id, quantity, unit, source, confidence, updated_at
      from provider_usage_meter_daily
      where environment = ${this.options.environment}
        and day >= ${range.from}::date and day <= ${range.to}::date
    `);
    return (rows as unknown as RawUsage[]).map((r) => ({
      day: r.day,
      providerId: r.provider_id,
      serviceId: r.service_id,
      operationId: r.operation_id,
      usageMetricId: r.usage_metric_id,
      billingSkuId: r.billing_sku_id,
      quantity: Number(r.quantity),
      unit: r.unit,
      source: r.source,
      confidence: r.confidence,
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
  }

  private async freshnessRows(): Promise<FreshnessSourceRow[]> {
    const { rows } = await this.db.execute(sql`
      select source_id, provider_id, service_id, last_successful_at, last_attempt_at, source_as_of,
             stale_after_s, consecutive_failures
      from cost_source_freshness
      where environment = ${this.options.environment}
    `);
    const at = (v: Date | string | null) => (v === null ? null : new Date(v));
    return (rows as unknown as RawFreshness[]).map((r) => ({
      sourceId: r.source_id,
      providerId: r.provider_id,
      serviceId: r.service_id,
      lastSuccessfulAt: at(r.last_successful_at),
      lastAttemptAt: at(r.last_attempt_at),
      sourceAsOf: at(r.source_as_of),
      staleAfterS: Number(r.stale_after_s),
      consecutiveFailures: Number(r.consecutive_failures),
    }));
  }
}

type RawUsage = {
  day: string;
  provider_id: string;
  service_id: string;
  operation_id: string | null;
  usage_metric_id: string;
  billing_sku_id: string | null;
  quantity: number | string;
  unit: string;
  source: string;
  confidence: Confidence;
  updated_at: Date | string;
};

type RawFreshness = {
  source_id: string;
  provider_id: string;
  service_id: string | null;
  last_successful_at: Date | string | null;
  last_attempt_at: Date | string | null;
  source_as_of: Date | string | null;
  stale_after_s: number | string;
  consecutive_failures: number | string;
};

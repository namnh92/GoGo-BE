import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { NeonConsumptionDay, NeonProjectConsumption, NeonUsagePort } from '@gogo/providers';
import type { CollectorDefinition, CollectorRunContext } from '../domain/collector';
import type { Confidence, UsageSample } from '../ports/collectors.port';
import { previousDay, upsertUsageSamples } from './cloudflare.collector';

/**
 * COST-BE-026 (#385) — the Neon Postgres usage collector on the generic
 * scheduler (epic §19, §41-P2): `neon_postgres` for `neon.postgres`.
 *
 * Two sources, chosen by what the project's plan allows:
 *
 * 1. **Consumption history** (`GET /consumption_history/projects`, daily) —
 *    the issue's source, one entry per UTC day. Available on Launch, Scale,
 *    Agent and Enterprise. Yesterday and today are **replaced** on every run
 *    (`source = 'neon_api'`): the endpoint reports the day's total, and
 *    yesterday is re-read because the last run of a day happens before
 *    midnight. A day the answer does not carry gets **no row** — absent is
 *    not zero (epic §44.6, §44.10).
 * 2. **Project snapshot** (`GET /projects/{id}`) — every plan, including the
 *    Free plan `gogo-dev` is on, where the history endpoint answers 403
 *    (`PLAN_NOT_SUPPORTED`). It carries the same counters as period-to-date
 *    totals, plus `data_transfer_bytes` (which history does not list) and the
 *    live storage size. Today's row is the **difference between two measured
 *    counters** — this run's total and the total at the last run of an
 *    earlier day (the baseline, kept in `metadata`) — never a projection.
 *    Attribution across midnight drifts by at most one run interval, so these
 *    rows are MEDIUM; the exact byte/second deltas ride in `metadata.exact`,
 *    and the sum of a month's rows telescopes to the exact period total.
 *
 * The history endpoint is probed once per UTC day: after a 403 the rest of
 * the day's runs skip it, so a Free-plan project costs one GET per run and
 * notices an upgrade the next day.
 *
 * Meters written (registry ids under `neon.postgres`):
 *
 * | meter              | quantity                                                          | unit         | billed                   |
 * | ------------------ | ----------------------------------------------------------------- | ------------ | ------------------------ |
 * | `compute_hours`    | history: round(`compute_time_seconds` / 3600); snapshot: floor-telescoped delta | compute_hour | `postgres.compute`       |
 * | `written_data_gb`  | history: round(`written_data_bytes` / 1e9); snapshot: delta       | gb           | —                        |
 * | `data_transfer_gb` | snapshot delta (history only when a body carries it)              | gb           | `postgres.data_transfer` |
 * | `storage_bytes`    | peak of `synthetic_storage_size` seen on the day                  | byte         | —                        |
 * | `storage_gb_month` | ceil(`storage_bytes` / 1e9) — decimal GB, as R2 does              | gb_month     | `postgres.storage`       |
 *
 * `compute_time_seconds` is CPU-seconds = active seconds × compute size, so
 * `/ 3600` is Neon's own CU-hour (pricing page, 2026-09-03). A whole-unit
 * meter on a 0.5 GB / 100 CU-hour plan is coarse; the raw seconds and bytes
 * are kept in `metadata` so nothing is lost, and the byte meter is exact.
 *
 * FREE and non-essential: neither endpoint is charged or wakes a compute,
 * and nothing downstream needs these rows to keep consumer traffic flowing.
 */
export const NEON_SOURCE = 'neon_api';
export const NEON_POSTGRES_COLLECTOR_ID = 'neon_postgres';

const POSTGRES = 'neon.postgres';
const PROVIDER = 'neon';
const GB = 1e9;
const HOUR = 3600;

export type NeonCollectorOptions = {
  frequencyMs?: number;
  staleAfterMs?: number;
  timeoutMs?: number;
  maxCallsPerDay?: number;
  now?: () => Date;
};

const DEFAULTS = {
  frequencyMs: 6 * 60 * 60 * 1000,
  staleAfterMs: 24 * 60 * 60 * 1000,
  timeoutMs: 15_000,
  maxCallsPerDay: 8,
};

export type NeonSampleContext = {
  /** The day the rows are for. */
  day: string;
  /** The run's UTC day. */
  today: string;
  environment: string;
  now: Date;
};

/** The three period-to-date counters the snapshot path differences. */
export type NeonCounters = {
  computeTimeSeconds: number | null;
  writtenDataBytes: number | null;
  dataTransferBytes: number | null;
};

/** Where today's deltas are measured from. */
export type NeonBaseline = {
  counters: NeonCounters;
  /** When the baseline counters were read. */
  at: Date;
  /** `consumption_period_start` at the baseline, ISO; `null` when the API gave none. */
  periodStart: string | null;
};

export type DeltaMeter = 'compute_hours' | 'written_data_gb' | 'data_transfer_gb';
const DELTA_METERS: readonly DeltaMeter[] = [
  'compute_hours',
  'written_data_gb',
  'data_transfer_gb',
];

/** What an earlier run left behind, read back before writing today. */
export type NeonStoredState = {
  baseline: NeonBaseline | null;
  /** Today's `storage_bytes` row, so a replace never loses an earlier peak. */
  storagePeakBytes: number | null;
};

const whole = (v: number) => Math.max(0, Math.round(v));

function sample(
  ctx: NeonSampleContext,
  metric: string,
  billingSkuId: string | null,
  unit: UsageSample['unit'],
  quantity: number,
  confidence: Confidence,
  metadata: Record<string, unknown>,
): UsageSample {
  return {
    day: ctx.day,
    environment: ctx.environment,
    providerId: PROVIDER,
    serviceId: POSTGRES,
    operationId: null,
    usageMetricId: metric,
    billingSkuId,
    quantity: Math.max(0, Math.trunc(quantity)),
    unit,
    source: NEON_SOURCE,
    confidence,
    sourceAsOf: ctx.now,
    metadata,
  };
}

const maxOf = (...values: (number | null | undefined)[]) => {
  let out: number | null = null;
  for (const v of values) if (v !== null && v !== undefined && (out === null || v > out)) out = v;
  return out;
};

/** The two storage rows from one peak figure. Exported for the fixture tests. */
export function storageSamples(
  ctx: NeonSampleContext,
  peakBytes: number,
  confidence: Confidence,
  metadata: Record<string, unknown>,
): UsageSample[] {
  return [
    sample(ctx, 'storage_bytes', null, 'byte', peakBytes, confidence, {
      definition: 'peak of synthetic_storage_size samples on the day',
      ...metadata,
    }),
    sample(
      ctx,
      'storage_gb_month',
      'postgres.storage',
      'gb_month',
      Math.ceil(peakBytes / GB),
      confidence,
      {
        gbDefinition: 'decimal (1e9 bytes), ceil',
        storageBytes: peakBytes,
        ...metadata,
      },
    ),
  ];
}

/**
 * Pure: one history day → its meter rows. A counter the entry lacks gives no
 * row. `data_transfer_gb` is written only when the entry carries the field —
 * the docs do not list it for this endpoint, so it normally comes from the
 * snapshot path instead. `liveStorageBytes` (today's `synthetic_storage_size`)
 * and `storedPeakBytes` (today's row so far) join the entry's gauge for the peak.
 */
export function historySamples(
  ctx: NeonSampleContext,
  entry: NeonConsumptionDay,
  extras: { liveStorageBytes?: number | null; storedPeakBytes?: number | null } = {},
): UsageSample[] {
  const out: UsageSample[] = [];
  const common = {
    from: 'consumption_history',
    periodPlan: entry.periodPlan,
    timeframeStart: entry.timeframeStart.toISOString(),
    timeframeEnd: entry.timeframeEnd.toISOString(),
  };
  if (entry.computeTimeSeconds !== null) {
    out.push(
      sample(
        ctx,
        'compute_hours',
        'postgres.compute',
        'compute_hour',
        whole(entry.computeTimeSeconds / HOUR),
        'HIGH',
        {
          ...common,
          definition: 'round(compute_time_seconds / 3600)',
          computeTimeSeconds: entry.computeTimeSeconds,
          activeTimeSeconds: entry.activeTimeSeconds,
        },
      ),
    );
  }
  if (entry.writtenDataBytes !== null) {
    out.push(
      sample(ctx, 'written_data_gb', null, 'gb', whole(entry.writtenDataBytes / GB), 'HIGH', {
        ...common,
        definition: 'round(written_data_bytes / 1e9)',
        writtenDataBytes: entry.writtenDataBytes,
      }),
    );
  }
  if (entry.dataTransferBytes !== null) {
    out.push(
      sample(
        ctx,
        'data_transfer_gb',
        'postgres.data_transfer',
        'gb',
        whole(entry.dataTransferBytes / GB),
        'HIGH',
        {
          ...common,
          definition: 'round(data_transfer_bytes / 1e9)',
          dataTransferBytes: entry.dataTransferBytes,
        },
      ),
    );
  }
  const peak = maxOf(
    entry.syntheticStorageSizeBytes,
    extras.liveStorageBytes,
    extras.storedPeakBytes,
  );
  if (peak !== null) {
    out.push(
      ...storageSamples(ctx, peak, 'HIGH', {
        ...common,
        entryStorageBytes: entry.syntheticStorageSizeBytes,
        liveStorageBytes: extras.liveStorageBytes ?? null,
        dataStorageBytesHour: entry.dataStorageBytesHour,
      }),
    );
  }
  return out;
}

const counterOf = (s: NeonProjectConsumption): NeonCounters => ({
  computeTimeSeconds: s.computeTimeSeconds,
  writtenDataBytes: s.writtenDataBytes,
  dataTransferBytes: s.dataTransferBytes,
});

const COUNTER_KEYS = ['computeTimeSeconds', 'writtenDataBytes', 'dataTransferBytes'] as const;

/**
 * Does the snapshot continue the baseline's period? A new
 * `consumption_period_start`, or any counter below its baseline, means Neon
 * reset the totals: everything period-to-date belongs to today.
 */
function continuesPeriod(
  now: NeonCounters,
  nowPeriodStart: string | null,
  baseline: NeonBaseline,
): boolean {
  if (
    baseline.periodStart !== null &&
    nowPeriodStart !== null &&
    baseline.periodStart !== nowPeriodStart
  ) {
    return false;
  }
  for (const k of COUNTER_KEYS) {
    const a = now[k];
    const b = baseline.counters[k];
    if (a !== null && b !== null && a < b) return false;
  }
  return true;
}

const ZERO: NeonCounters = { computeTimeSeconds: 0, writtenDataBytes: 0, dataTransferBytes: 0 };

/**
 * Pure: the snapshot and the baseline → today's delta rows and the baseline
 * to carry forward. Quantities are `floor(now / unit) − floor(baseline / unit)`
 * so consecutive days telescope to the exact period total; the exact deltas
 * ride in `metadata.exact`.
 *
 * - No baseline (first run ever, or nothing on record): the baseline is this
 *   snapshot and today reads `0` from here on — the period's earlier usage
 *   was never observed daily and is not attributed (`metadata.firstRun`).
 * - Period rolled over: the baseline is zero (`metadata.periodRollover`).
 */
export function deltaSamples(
  ctx: NeonSampleContext,
  snapshot: NeonProjectConsumption,
  baseline: NeonBaseline | null,
  opts: {
    meters?: readonly DeltaMeter[];
    storage?: boolean;
    storedPeakBytes?: number | null;
    historyStatus: 'PLAN_NOT_SUPPORTED' | 'not_listed';
  },
): { samples: UsageSample[]; baseline: NeonBaseline } {
  const now = counterOf(snapshot);
  const periodStart = snapshot.consumptionPeriodStart?.toISOString() ?? null;
  const periodEnd = snapshot.consumptionPeriodEnd?.toISOString() ?? null;
  let base: NeonBaseline;
  let firstRun = false;
  let periodRollover = false;
  if (baseline === null) {
    base = { counters: now, at: ctx.now, periodStart };
    firstRun = true;
  } else if (!continuesPeriod(now, periodStart, baseline)) {
    base = { counters: ZERO, at: snapshot.consumptionPeriodStart ?? ctx.now, periodStart };
    periodRollover = true;
  } else {
    base = baseline;
  }

  const exact = {
    computeTimeSecondsDelta:
      now.computeTimeSeconds === null || base.counters.computeTimeSeconds === null
        ? null
        : now.computeTimeSeconds - base.counters.computeTimeSeconds,
    writtenDataBytesDelta:
      now.writtenDataBytes === null || base.counters.writtenDataBytes === null
        ? null
        : now.writtenDataBytes - base.counters.writtenDataBytes,
    dataTransferBytesDelta:
      now.dataTransferBytes === null || base.counters.dataTransferBytes === null
        ? null
        : now.dataTransferBytes - base.counters.dataTransferBytes,
  };
  const metadata = {
    from: 'project',
    definition: 'delta_since_baseline: floor(now / unit) - floor(baseline / unit)',
    historyStatus: opts.historyStatus,
    at: ctx.now.toISOString(),
    periodStart,
    periodEnd,
    cumulative: { ...now, at: ctx.now.toISOString(), periodStart },
    baseline: { ...base.counters, at: base.at.toISOString(), periodStart: base.periodStart },
    exact,
    ...(firstRun ? { firstRun: true } : {}),
    ...(periodRollover ? { periodRollover: true } : {}),
  };

  const delta = (nowV: number | null, baseV: number | null, unit: number): number | null =>
    nowV === null || baseV === null ? null : Math.floor(nowV / unit) - Math.floor(baseV / unit);

  const out: UsageSample[] = [];
  for (const meter of opts.meters ?? DELTA_METERS) {
    if (meter === 'compute_hours') {
      const q = delta(now.computeTimeSeconds, base.counters.computeTimeSeconds, HOUR);
      if (q !== null)
        out.push(
          sample(ctx, 'compute_hours', 'postgres.compute', 'compute_hour', q, 'MEDIUM', metadata),
        );
    } else if (meter === 'written_data_gb') {
      const q = delta(now.writtenDataBytes, base.counters.writtenDataBytes, GB);
      if (q !== null) out.push(sample(ctx, 'written_data_gb', null, 'gb', q, 'MEDIUM', metadata));
    } else {
      const q = delta(now.dataTransferBytes, base.counters.dataTransferBytes, GB);
      if (q !== null)
        out.push(
          sample(ctx, 'data_transfer_gb', 'postgres.data_transfer', 'gb', q, 'MEDIUM', metadata),
        );
    }
  }
  if (opts.storage) {
    const peak = maxOf(snapshot.syntheticStorageSizeBytes, opts.storedPeakBytes);
    if (peak !== null) {
      out.push(
        ...storageSamples(ctx, peak, 'MEDIUM', {
          from: 'project',
          historyStatus: opts.historyStatus,
          liveStorageBytes: snapshot.syntheticStorageSizeBytes,
          dataStorageBytesHour: snapshot.dataStorageBytesHour,
        }),
      );
    }
  }
  return { samples: out, baseline: base };
}

function counters(v: unknown): NeonCounters | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    computeTimeSeconds: num(r.computeTimeSeconds),
    writtenDataBytes: num(r.writtenDataBytes),
    dataTransferBytes: num(r.dataTransferBytes),
  };
}

function baselineFrom(v: unknown): NeonBaseline | null {
  const c = counters(v);
  if (c === null) return null;
  const r = v as Record<string, unknown>;
  const at = typeof r.at === 'string' ? new Date(r.at) : null;
  if (at === null || !Number.isFinite(at.getTime())) return null;
  return { counters: c, at, periodStart: typeof r.periodStart === 'string' ? r.periodStart : null };
}

/**
 * The baseline rides on the `data_transfer_gb` row, which the snapshot path
 * writes in both modes. Today's row carries the baseline the day started
 * from; an earlier day's row carries the totals at its last run, which is
 * where today measures from.
 */
export async function readNeonState(
  db: Db,
  environment: string,
  today: string,
): Promise<NeonStoredState> {
  const carrier = await db.execute(sql`
    select to_char(day, 'YYYY-MM-DD') as day, metadata
    from provider_usage_meter_daily
    where environment = ${environment} and provider_id = ${PROVIDER} and service_id = ${POSTGRES}
      and source = ${NEON_SOURCE} and usage_metric_id = 'data_transfer_gb'
      and day <= ${today}::date
    order by day desc
    limit 1
  `);
  const row = (carrier.rows as { day: string; metadata: Record<string, unknown> | null }[])[0];
  let baseline: NeonBaseline | null = null;
  if (row?.metadata) {
    baseline = baselineFrom(row.day === today ? row.metadata.baseline : row.metadata.cumulative);
  }
  const storage = await db.execute(sql`
    select quantity from provider_usage_meter_daily
    where environment = ${environment} and provider_id = ${PROVIDER} and service_id = ${POSTGRES}
      and source = ${NEON_SOURCE} and usage_metric_id = 'storage_bytes' and day = ${today}::date
  `);
  const q = (storage.rows as { quantity: number | string }[])[0]?.quantity;
  const storagePeakBytes = q === undefined ? null : Number(q);
  return {
    baseline,
    storagePeakBytes: Number.isFinite(storagePeakBytes) ? storagePeakBytes : null,
  };
}

const isPlanNotSupported = (err: unknown) =>
  typeof err === 'object' &&
  err !== null &&
  (err as { code?: unknown }).code === 'PLAN_NOT_SUPPORTED';

/**
 * The definition, ready for `CollectorSchedulerService.register`. Build only
 * when credentials exist (`neonApiFromEnv` returned a client); with none,
 * register nothing and the provider reads UNKNOWN.
 */
export function neonPostgresCollector(
  db: Db,
  client: NeonUsagePort,
  options: NeonCollectorOptions = {},
): CollectorDefinition {
  const now = options.now ?? (() => new Date());
  /** UTC day on which the history endpoint last answered 403; re-probed the next day. */
  let historyUnsupportedOn: string | null = null;
  return {
    id: NEON_POSTGRES_COLLECTOR_ID,
    providerId: PROVIDER,
    serviceId: POSTGRES,
    capability: 'USAGE_COLLECTOR',
    frequencyMs: options.frequencyMs ?? DEFAULTS.frequencyMs,
    staleAfterMs: options.staleAfterMs ?? DEFAULTS.staleAfterMs,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    retry: { maxAttemptsPerTick: 1 },
    maxCallsPerDay: options.maxCallsPerDay ?? DEFAULTS.maxCallsPerDay,
    enabledEnvironments: 'all',
    essential: false,
    monitoringCost: {
      model: 'FREE',
      estimatedMonthlyMicros: 0,
      currency: 'USD',
      expectedRequestsPerMonth: 2 * 4 * 30,
      pricingSource:
        'Neon API calls are not charged and do not wake computes (api-docs.neon.tech, checked 2026-09-03). At most two GETs per run — history plus project — four runs a day.',
      lastPricingReview: '2026-09-03',
    },
    run: async (ctx: CollectorRunContext) => {
      const at = now();
      const yesterday = previousDay(ctx.day);
      const state = await readNeonState(db, ctx.environment, ctx.day);

      let history: NeonConsumptionDay[] | null = null;
      if (historyUnsupportedOn !== ctx.day) {
        try {
          history = await client.consumptionHistory({
            from: new Date(`${yesterday}T00:00:00Z`),
            to: at,
            signal: ctx.signal,
          });
        } catch (err) {
          if (!isPlanNotSupported(err)) throw err;
          historyUnsupportedOn = ctx.day;
        }
      }
      const snapshot = await client.project({ signal: ctx.signal });

      const todayCtx: NeonSampleContext = {
        day: ctx.day,
        today: ctx.day,
        environment: ctx.environment,
        now: at,
      };
      const samples: UsageSample[] = [];
      if (history === null) {
        samples.push(
          ...deltaSamples(todayCtx, snapshot, state.baseline, {
            storage: true,
            storedPeakBytes: state.storagePeakBytes,
            historyStatus: 'PLAN_NOT_SUPPORTED',
          }).samples,
        );
      } else {
        for (const day of [yesterday, ctx.day]) {
          const entry = history.find((h) => h.day === day);
          if (entry === undefined) continue;
          const isToday = day === ctx.day;
          samples.push(
            ...historySamples({ ...todayCtx, day }, entry, {
              liveStorageBytes: isToday ? snapshot.syntheticStorageSizeBytes : null,
              storedPeakBytes: isToday ? state.storagePeakBytes : null,
            }),
          );
        }
        const todayEntry = history.find((h) => h.day === ctx.day);
        if (todayEntry?.dataTransferBytes == null) {
          samples.push(
            ...deltaSamples(todayCtx, snapshot, state.baseline, {
              meters: ['data_transfer_gb'],
              storage: false,
              historyStatus: 'not_listed',
            }).samples,
          );
        }
      }
      const written = await upsertUsageSamples(db, samples);
      return { sourceAsOf: at, samples: written };
    },
  };
}

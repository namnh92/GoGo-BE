import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import type { CollectorDefinition } from '../domain/collector';
import { COST_REGISTRY } from '../domain/registry';
import { CollectorSchedulerService } from './collector-scheduler.service';

/**
 * The scheduler against a fake `db` that remembers freshness rows in memory.
 * What is pinned here is the *policy*: due/backoff, isolation, budget pause,
 * calls cap, registration refusals. The SQL shapes and the real upsert are
 * covered by `cost-collectors.int.spec.ts`.
 */
const dialect = new PgDialect();

type Row = {
  source_id: string;
  last_successful_at: Date | null;
  last_attempt_at: Date | null;
  consecutive_failures: number;
  calls_day: string | null;
  calls_count: number;
  status: string;
  last_error_code: string | null;
};

function fakeDb() {
  const rows = new Map<string, Row>();
  const statements: string[] = [];
  const db = {
    execute: vi.fn(async (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      statements.push(sql);
      if (sql.includes('from cost_source_freshness')) {
        return { rows: [...rows.values()] };
      }
      if (sql.includes('insert into cost_source_freshness')) {
        // params: env, source_id, provider, service, last_success, last_attempt, source_as_of, stale, status, err, failures, day, calls
        const [
          ,
          sourceId,
          ,
          ,
          lastSuccess,
          lastAttempt,
          ,
          ,
          status,
          errorCode,
          failures,
          day,
          calls,
        ] = params as [
          string,
          string,
          string,
          string | null,
          string | null,
          string,
          string | null,
          number,
          string,
          string | null,
          number,
          string,
          number,
        ];
        const prior = rows.get(sourceId);
        const success = lastSuccess !== null;
        rows.set(sourceId, {
          source_id: sourceId,
          last_successful_at: success ? new Date(lastSuccess) : (prior?.last_successful_at ?? null),
          last_attempt_at: new Date(lastAttempt),
          consecutive_failures: success ? 0 : failures,
          calls_day: day,
          calls_count: prior?.calls_day === day ? Math.max(prior.calls_count, calls) : calls,
          status: success ? status : prior?.last_successful_at ? 'STALE' : 'UNAVAILABLE',
          last_error_code: success ? null : errorCode,
        });
        return { rows: [] };
      }
      if (sql.includes('update cost_source_freshness')) {
        const sourceId = (params as string[])[1]!;
        const prior = rows.get(sourceId);
        if (prior && prior.status !== 'UNKNOWN') prior.status = 'STALE';
        return { rows: [] };
      }
      return { rows: [] };
    }),
  } as unknown as Db;
  return { db, rows, statements };
}

function metricsRecorder() {
  const counts: { name: string; labels: Record<string, unknown> }[] = [];
  return {
    counts,
    increment: (name: string, labels: Record<string, unknown> = {}) =>
      void counts.push({ name, labels }),
    observe: () => undefined,
  };
}

const NOW = new Date('2026-09-02T12:00:00Z');

function collector(over: Partial<CollectorDefinition> & { id: string }): CollectorDefinition {
  return {
    providerId: 'google',
    serviceId: null,
    capability: 'USAGE_COLLECTOR',
    frequencyMs: 60_000,
    staleAfterMs: 3_600_000,
    timeoutMs: 1_000,
    retry: { maxAttemptsPerTick: 1 },
    maxCallsPerDay: null,
    enabledEnvironments: 'all',
    essential: false,
    monitoringCost: {
      model: 'FREE',
      estimatedMonthlyMicros: 0,
      currency: 'USD',
      expectedRequestsPerMonth: null,
      pricingSource: 'test',
      lastPricingReview: '2026-09-02',
    },
    run: async () => ({ sourceAsOf: null, samples: 1 }),
    ...over,
  };
}

function scheduler(
  db: Db,
  over: Partial<ConstructorParameters<typeof CollectorSchedulerService>[2]> = {},
) {
  return new CollectorSchedulerService(db, COST_REGISTRY, {
    environment: 'dev',
    now: () => NOW,
    ...over,
  });
}

describe('registration (epic §6/§7)', () => {
  it('refuses an unknown provider, an undeclared capability, a foreign service, a paid essential', () => {
    const { db } = fakeDb();
    const s = scheduler(db);
    expect(() => s.register(collector({ id: 'x', providerId: 'vietmap' }))).toThrow(
      /unknown provider/,
    );
    expect(() => s.register(collector({ id: 'y', providerId: 'neon' }))).toThrow(
      /does not declare/,
    );
    expect(() => s.register(collector({ id: 'z', serviceId: 'neon.postgres' }))).toThrow(
      /is not google's/,
    );
    expect(() =>
      s.register(
        collector({
          id: 'w',
          essential: true,
          monitoringCost: {
            model: 'PER_REQUEST',
            estimatedMonthlyMicros: 10,
            currency: 'USD',
            expectedRequestsPerMonth: 1,
            pricingSource: 't',
            lastPricingReview: '2026-09-02',
          },
        }),
      ),
    ).toThrow(/only a FREE collector may be essential/);
    expect(() => s.register(collector({ id: 'ok' })).register(collector({ id: 'ok' }))).toThrow(
      /already registered/,
    );
  });
});

describe('tick policy (epic §19, §22, §38)', () => {
  it('runs a due collector, records success, and skips it until its frequency elapses', async () => {
    const { db, rows } = fakeDb();
    const run = vi.fn(async () => ({ sourceAsOf: new Date('2026-09-02T11:59:00Z'), samples: 3 }));
    const s = scheduler(db).register(collector({ id: 'a', run }));
    const first = await s.tick();
    expect(first.results).toEqual([{ collector: 'a', outcome: 'ok', samples: 3 }]);
    expect(rows.get('a')).toMatchObject({
      status: 'FRESH',
      consecutive_failures: 0,
      calls_count: 1,
    });
    const second = await s.tick();
    expect(second.results).toEqual([{ collector: 'a', outcome: 'skipped_not_due' }]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('isolates a failing collector: it backs off, the next one still runs', async () => {
    const { db, rows } = fakeDb();
    const good = vi.fn(async () => ({ sourceAsOf: null, samples: 0 }));
    const s = scheduler(db)
      .register(
        collector({
          id: 'bad',
          run: async () => {
            throw Object.assign(new Error('boom'), { code: 'UPSTREAM_503' });
          },
        }),
      )
      .register(collector({ id: 'good', run: good }));
    const report = await s.tick();
    expect(report.results).toEqual([
      { collector: 'bad', outcome: 'failed', errorCode: 'UPSTREAM_503' },
      { collector: 'good', outcome: 'ok', samples: 0 },
    ]);
    expect(rows.get('bad')).toMatchObject({
      status: 'UNAVAILABLE',
      consecutive_failures: 1,
      last_error_code: 'UPSTREAM_503',
    });
    // Not due again at +1 frequency: the backoff doubled it.
    const later = scheduler(db, { now: () => new Date(NOW.getTime() + 60_001) })
      .register(collector({ id: 'bad' }))
      .register(collector({ id: 'good', run: good }));
    const r2 = await later.tick();
    expect(r2.results.find((r) => r.collector === 'bad')?.outcome).toBe('skipped_not_due');
    expect(r2.results.find((r) => r.collector === 'good')?.outcome).toBe('ok');
  });

  it('times out a slow collector without retrying it in the same tick', async () => {
    const { db, rows } = fakeDb();
    const run = vi.fn(() => new Promise<never>(() => undefined));
    const s = scheduler(db).register(
      collector({ id: 'slow', timeoutMs: 20, retry: { maxAttemptsPerTick: 3 }, run }),
    );
    const report = await s.tick();
    expect(report.results).toEqual([
      { collector: 'slow', outcome: 'timeout', errorCode: 'TIMEOUT' },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(rows.get('slow')?.status).toBe('UNAVAILABLE');
  });

  it('retries within a tick up to the policy, then records one failure', async () => {
    const { db, rows } = fakeDb();
    let calls = 0;
    const s = scheduler(db).register(
      collector({
        id: 'flaky',
        retry: { maxAttemptsPerTick: 3 },
        run: async () => {
          calls += 1;
          if (calls < 3) throw new Error('transient');
          return { sourceAsOf: null, samples: 1 };
        },
      }),
    );
    const report = await s.tick();
    expect(report.results[0]?.outcome).toBe('ok');
    expect(calls).toBe(3);
    expect(rows.get('flaky')?.calls_count).toBe(3);
  });

  it('enforces maxCallsPerDay across ticks', async () => {
    const { db } = fakeDb();
    const run = vi.fn(async () => ({ sourceAsOf: null, samples: 1 }));
    const s = scheduler(db).register(
      collector({ id: 'capped', frequencyMs: 1, maxCallsPerDay: 1, run }),
    );
    await s.tick();
    const second = await scheduler(db, { now: () => new Date(NOW.getTime() + 10) })
      .register(collector({ id: 'capped', frequencyMs: 1, maxCallsPerDay: 1, run }))
      .tick();
    expect(second.results).toEqual([{ collector: 'capped', outcome: 'skipped_calls_cap' }]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('skips collectors not enabled in this environment', async () => {
    const { db } = fakeDb();
    const run = vi.fn(async () => ({ sourceAsOf: null, samples: 1 }));
    const s = scheduler(db).register(
      collector({ id: 'prod_only', enabledEnvironments: ['prod'], run }),
    );
    const report = await s.tick();
    expect(report.results).toEqual([{ collector: 'prod_only', outcome: 'skipped_env' }]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('cost of cost (epic §20–§22)', () => {
  const paid = (id: string, micros: number, essential = false) =>
    collector({
      id,
      essential,
      monitoringCost: {
        model: 'PER_REQUEST',
        estimatedMonthlyMicros: micros,
        currency: 'USD',
        expectedRequestsPerMonth: 30,
        pricingSource: 't',
        lastPricingReview: '2026-09-02',
      },
    });

  it('pauses non-essential collectors over budget, keeps the essential FREE one, and counts it', async () => {
    const { db, rows } = fakeDb();
    const metrics = metricsRecorder();
    const s = scheduler(db, { monitoringBudgetMicros: 1_000_000, metrics })
      .register(collector({ id: 'ledger', essential: true }))
      .register(paid('aws_ce', 900_000))
      .register(paid('gcp_billing', 300_000));
    // Seed a prior success for gcp_billing (two minutes ago, so it is due
    // again now) so the pause has a status to move.
    await scheduler(db, { now: () => new Date(NOW.getTime() - 120_000) })
      .register(paid('gcp_billing', 300_000))
      .tick();

    const report = await s.tick();
    expect(report.monitoring).toMatchObject({
      knownMonthlyMicros: 1_200_000,
      budgetMicros: 1_000_000,
      overBudget: true,
      unknown: [],
    });
    expect(report.results).toEqual([
      { collector: 'ledger', outcome: 'ok', samples: 1 },
      { collector: 'aws_ce', outcome: 'skipped_budget' },
      { collector: 'gcp_billing', outcome: 'skipped_budget' },
    ]);
    expect(rows.get('gcp_billing')?.status).toBe('STALE');
    expect(metrics.counts.some((c) => c.name === 'cost_monitoring_over_budget_total')).toBe(true);
    expect(
      metrics.counts.filter((c) => c.name === 'cost_collector_runs_total').map((c) => c.labels),
    ).toEqual([
      { collector: 'ledger', outcome: 'ok' },
      { collector: 'aws_ce', outcome: 'skipped_budget' },
      { collector: 'gcp_billing', outcome: 'skipped_budget' },
    ]);
  });

  it('reports an unknown-cost collector as unknown, never as zero', () => {
    const { db } = fakeDb();
    const s = scheduler(db).register(
      collector({
        id: 'mystery',
        monitoringCost: {
          model: 'UNKNOWN',
          estimatedMonthlyMicros: null,
          currency: 'USD',
          expectedRequestsPerMonth: null,
          pricingSource: '?',
          lastPricingReview: '2026-09-02',
        },
      }),
    );
    expect(s.monitoring()).toMatchObject({
      knownMonthlyMicros: 0,
      unknown: ['mystery'],
      overBudget: false,
    });
  });
});

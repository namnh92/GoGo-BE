import { describe, expect, it } from 'vitest';
import type { SentryDayStats, SentryProject, SentryStatsPort } from '@gogo/providers';
import { COST_REGISTRY } from '../../domain/registry';
import { CollectorSchedulerService } from '../../application/collector-scheduler.service';
import {
  SENTRY_EVENTS_COLLECTOR_ID,
  SENTRY_SOURCE,
  eventsSamples,
  sentryEventsCollector,
} from './sentry.collector';

/**
 * BE#696 — the pure parts: one day's stats_v2 totals → the `events` meter
 * row, and the collector definition. Ids are the gogo-vn projects.
 */

const NOW = new Date('2026-10-15T06:00:00Z');
const CTX = { today: '2026-10-15', environment: 'dev', now: NOW };

const PROJECTS: SentryProject[] = [
  { id: '4512201628254209', slug: 'gogo-be' },
  { id: '4512252504178689', slug: 'gogo-cms' },
  { id: '4512252504178688', slug: 'gogo-mobile' },
];

const day = (d: string, totals: SentryDayStats['totals']): SentryDayStats => ({ day: d, totals });

const NO_DROPS = {
  filtered: 0,
  rate_limited: 0,
  invalid: 0,
  abuse: 0,
  client_discard: 0,
  cardinality_limited: 0,
};

describe('eventsSamples', () => {
  it('sums accepted across projects into one HIGH row for yesterday, every slug listed', () => {
    const rows = eventsSamples(
      CTX,
      day('2026-10-14', [
        { projectId: '4512252504178688', outcome: 'accepted', quantity: 8 },
        { projectId: '4512252504178689', outcome: 'accepted', quantity: 5 },
        { projectId: '4512252504178689', outcome: 'rate_limited', quantity: 3 },
        { projectId: '4512252504178688', outcome: 'filtered', quantity: 2 },
      ]),
      PROJECTS,
    );
    expect(rows).toEqual([
      {
        day: '2026-10-14',
        environment: 'dev',
        providerId: 'sentry',
        serviceId: 'sentry.errors',
        operationId: null,
        usageMetricId: 'events',
        billingSkuId: 'errors.events',
        quantity: 13,
        unit: 'event',
        source: SENTRY_SOURCE,
        confidence: 'HIGH',
        sourceAsOf: NOW,
        metadata: {
          from: 'stats_v2',
          definition: expect.any(String),
          byProject: { 'gogo-be': 0, 'gogo-cms': 5, 'gogo-mobile': 8 },
          dropped: { ...NO_DROPS, rate_limited: 3, filtered: 2 },
        },
      },
    ]);
  });

  it("today's row is MEDIUM", () => {
    const [row] = eventsSamples(
      CTX,
      day('2026-10-15', [{ projectId: '4512201628254209', outcome: 'accepted', quantity: 1 }]),
      PROJECTS,
    );
    expect(row!.confidence).toBe('MEDIUM');
    expect(row!.quantity).toBe(1);
  });

  it('a day with no groups is a measured zero, not a missing row', () => {
    const rows = eventsSamples(CTX, day('2026-10-14', []), PROJECTS);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(0);
    expect(rows[0]!.metadata).toMatchObject({
      byProject: { 'gogo-be': 0, 'gogo-cms': 0, 'gogo-mobile': 0 },
      dropped: NO_DROPS,
    });
  });

  it('keeps an unknown project id as project:<id> and passes an unknown outcome through', () => {
    const [row] = eventsSamples(
      CTX,
      day('2026-10-14', [
        { projectId: '999', outcome: 'accepted', quantity: 4 },
        { projectId: '999', outcome: 'new_outcome', quantity: 1 },
      ]),
      PROJECTS,
    );
    expect(row!.quantity).toBe(4);
    expect(row!.metadata).toMatchObject({
      byProject: { 'project:999': 4, 'gogo-be': 0 },
      dropped: { new_outcome: 1 },
    });
  });
});

describe('collector definition', () => {
  const fake: SentryStatsPort = {
    errorsForDay: async ({ day: d }) => day(d, []),
    projects: async () => PROJECTS,
  };

  it('is a free, non-essential collector on the usual 6h cadence', () => {
    expect(sentryEventsCollector({} as never, fake)).toMatchObject({
      id: SENTRY_EVENTS_COLLECTOR_ID,
      providerId: 'sentry',
      serviceId: 'sentry.errors',
      capability: 'USAGE_COLLECTOR',
      frequencyMs: 6 * 60 * 60 * 1000,
      staleAfterMs: 24 * 60 * 60 * 1000,
      timeoutMs: 15_000,
      retry: { maxAttemptsPerTick: 1 },
      maxCallsPerDay: 8,
      enabledEnvironments: 'all',
      essential: false,
      monitoringCost: { model: 'FREE', estimatedMonthlyMicros: 0, expectedRequestsPerMonth: 360 },
    });
  });

  it('registers because the registry declares USAGE_COLLECTOR for sentry.errors, and costs nothing', () => {
    const s = new CollectorSchedulerService({} as never, COST_REGISTRY, { environment: 'dev' });
    s.register(sentryEventsCollector({} as never, fake));
    expect(s.registered().map((c) => c.id)).toEqual([SENTRY_EVENTS_COLLECTOR_ID]);
    expect(s.monitoring()).toMatchObject({ knownMonthlyMicros: 0, unknown: [], overBudget: false });
  });

  const runDb = () => {
    const executed: unknown[] = [];
    const db = {
      execute: async (q: unknown) => {
        executed.push(q);
        return { rows: [] };
      },
    };
    return { db, executed };
  };

  it('asks for the projects once, then yesterday and today, and writes one row per day', async () => {
    const asked: string[] = [];
    const recording: SentryStatsPort = {
      errorsForDay: async (q) => {
        asked.push(q.day);
        expect(q.signal).toBeInstanceOf(AbortSignal);
        return day(q.day, [{ projectId: '4512252504178688', outcome: 'accepted', quantity: 2 }]);
      },
      projects: async (signal) => {
        asked.push('projects');
        expect(signal).toBeInstanceOf(AbortSignal);
        return PROJECTS;
      },
    };
    const { db, executed } = runDb();
    const result = await sentryEventsCollector(db as never, recording, { now: () => NOW }).run({
      environment: 'dev',
      now: NOW,
      day: '2026-10-01',
      signal: new AbortController().signal,
    });
    expect(asked).toEqual(['projects', '2026-09-30', '2026-10-01']);
    expect(result).toEqual({ sourceAsOf: NOW, samples: 2 });
    expect(executed).toHaveLength(2);
  });

  it('writes nothing when one day fails — the run fails and freshness shows it', async () => {
    const failing: SentryStatsPort = {
      errorsForDay: async (q) => {
        if (q.day === '2026-10-15') throw new Error('sentry stats 401');
        return day(q.day, []);
      },
      projects: async () => PROJECTS,
    };
    const { db, executed } = runDb();
    await expect(
      sentryEventsCollector(db as never, failing, { now: () => NOW }).run({
        environment: 'dev',
        now: NOW,
        day: '2026-10-15',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('sentry stats 401');
    expect(executed).toHaveLength(0);
  });
});

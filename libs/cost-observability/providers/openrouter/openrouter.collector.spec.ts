import { describe, expect, it } from 'vitest';
import type {
  OpenRouterActivityItem,
  OpenRouterKeyUsage,
  OpenRouterUsagePort,
} from '@gogo/providers';
import { COST_REGISTRY } from '../../domain/registry';
import { CollectorSchedulerService } from '../../application/collector-scheduler.service';
import {
  ANTHROPIC_BYOK_COLLECTOR_ID,
  OPENROUTER_ACTIVITY_COLLECTOR_ID,
  OPENROUTER_SOURCE,
  activitySamples,
  anthropicByokCollector,
  anthropicByokSamples,
  openRouterActivityCollector,
  openRouterServiceFor,
  todaySamples,
} from './openrouter.collector';

/**
 * GoGo-BE#709 — the pure parts: keys + activity → ACTUAL cost rows and meter
 * rows per (day, service), and the collector definition. Nothing here talks
 * to OpenRouter.
 */

const NOW = new Date('2026-10-22T06:00:00Z');
const CTX = { today: '2026-10-22', environment: 'dev', now: NOW };

const key = (name: string, hash: string, daily = 0): OpenRouterKeyUsage => ({
  hash,
  name,
  disabled: false,
  usageDailyUsd: daily,
  usageMonthlyUsd: daily,
});
const BE = key('gogo-be-dev', 'aaaaaaaa1111', 0.0004);
const HARNESS = key('gogo-ai-harness-dev', 'bbbbbbbb2222', 0.0002);
const OTHER = key('playground', 'cccccccc3333');

const item = (
  day: string,
  model: string,
  usd: number,
  extra: Partial<OpenRouterActivityItem> = {},
) => ({
  day,
  model,
  modelPermaslug: null,
  providerName: null,
  usageUsd: usd,
  byokUsageUsd: 0,
  requests: 10,
  promptTokens: 1000,
  completionTokens: 20,
  reasoningTokens: 0,
  ...extra,
});

describe('openRouterServiceFor', () => {
  it('routes by the name convention, - or _, anything else to other_keys', () => {
    expect(openRouterServiceFor('gogo-be-dev')).toBe('openrouter.decisions');
    expect(openRouterServiceFor('gogo_be_dev')).toBe('openrouter.decisions');
    expect(openRouterServiceFor('gogo-be')).toBe('openrouter.decisions');
    expect(openRouterServiceFor('GoGo-AI-Harness-dev')).toBe('openrouter.dev_tooling');
    expect(openRouterServiceFor('gogo_ai_harness_dev')).toBe('openrouter.dev_tooling');
    expect(openRouterServiceFor('gogo-bex')).toBe('openrouter.other_keys');
    expect(openRouterServiceFor('playground')).toBe('openrouter.other_keys');
  });

  it('files the keys on the live account after the split (2026-10-22)', () => {
    expect(openRouterServiceFor('gogo_ai_harness_dev')).toBe('openrouter.dev_tooling');
    expect(openRouterServiceFor('gogo-claude-dev')).toBe('openrouter.claude_byok');
  });

  it('files the two keys GoGo held before the split where they belong', () => {
    // One JEV key shared by the harness and the backend: unsplit, not either.
    expect(openRouterServiceFor('gogo_jev_dev')).toBe('openrouter.jev_shared');
    expect(openRouterServiceFor('gogo_claude_dev')).toBe('openrouter.claude_byok');
    expect(openRouterServiceFor('gogo_jevx_dev')).toBe('openrouter.other_keys');
    expect(openRouterServiceFor('gogo_claudette')).toBe('openrouter.other_keys');
  });
});

describe('activitySamples', () => {
  it('sums a service per completed day into one HIGH ACTUAL row in USD micros, with meters', () => {
    const out = activitySamples(CTX, [
      {
        key: BE,
        items: [
          item('2026-10-21', 'typesafe/jev-1.14', 0.000042, { byokUsageUsd: 0.5 }),
          item('2026-10-21', 'other/model', 0.001, {
            requests: 2,
            promptTokens: 50,
            completionTokens: 5,
          }),
        ],
      },
    ]);
    expect(out.cost).toEqual([
      {
        day: '2026-10-21',
        environment: 'dev',
        providerId: 'openrouter',
        serviceId: 'openrouter.decisions',
        operationId: null,
        usageMetricId: null,
        billingSkuId: null,
        billableQuantity: null,
        billableUnit: null,
        amountMicros: 1042,
        currency: 'USD',
        basis: 'ACTUAL',
        confidence: 'HIGH',
        source: OPENROUTER_SOURCE,
        costKind: 'USAGE',
        sourceAsOf: NOW,
        metadata: {
          from: 'activity',
          byModel: { 'typesafe/jev-1.14': 42, 'other/model': 1000 },
          byokUsageMicros: 500000,
          reasoningTokens: 0,
          keys: [{ name: 'gogo-be-dev', hash: 'aaaaaaaa' }],
        },
      },
    ]);
    expect(
      out.usage.map((u) => [u.day, u.serviceId, u.usageMetricId, u.quantity, u.unit, u.confidence]),
    ).toEqual([
      ['2026-10-21', 'openrouter.decisions', 'requests', 12, 'request', 'HIGH'],
      ['2026-10-21', 'openrouter.decisions', 'input_tokens', 1050, 'token', 'HIGH'],
      ['2026-10-21', 'openrouter.decisions', 'output_tokens', 25, 'token', 'HIGH'],
    ]);
  });

  it('keeps key holders apart and never sums them into one service', () => {
    const out = activitySamples(CTX, [
      { key: BE, items: [item('2026-10-20', 'm', 0.01)] },
      { key: HARNESS, items: [item('2026-10-20', 'm', 0.02)] },
      { key: OTHER, items: [item('2026-10-20', 'm', 0.03)] },
    ]);
    const older = out.cost.filter((c) => c.day === '2026-10-20');
    expect(older.map((c) => [c.serviceId, c.amountMicros])).toEqual([
      ['openrouter.decisions', 10000],
      ['openrouter.dev_tooling', 20000],
      ['openrouter.other_keys', 30000],
    ]);
  });

  it('a day with no item gets no row, yesterday included — absence is not zero (#710 r4)', () => {
    // Yesterday's row may hold the partial `/keys usage_daily` figure written
    // before midnight; a $0 here would replace real spend until OpenRouter
    // folds the day. Leaving it lets the HIGH row replace it instead.
    const out = activitySamples(CTX, [
      { key: BE, items: [item('2026-10-19', 'm', 0.01)] },
      { key: HARNESS, items: [] },
    ]);
    expect(out.cost.map((c) => [c.day, c.serviceId, c.amountMicros, c.confidence])).toEqual([
      ['2026-10-19', 'openrouter.decisions', 10000, 'HIGH'],
    ]);
    expect(out.cost.some((c) => c.amountMicros === 0)).toBe(false);
  });

  it('ignores items dated today or later — that day belongs to the /keys row', () => {
    const out = activitySamples(CTX, [
      { key: BE, items: [item('2026-10-22', 'm', 9), item('2026-10-23', 'm', 9)] },
    ]);
    expect(out.cost.every((c) => c.day < '2026-10-22')).toBe(true);
    expect(out.usage).toEqual([]);
  });

  it('a BYOK figure absent from every item is unknown (null), not a measured zero', () => {
    const out = activitySamples(CTX, [
      { key: BE, items: [item('2026-10-21', 'm', 0.01, { byokUsageUsd: null })] },
    ]);
    expect(out.cost[0]?.metadata?.byokUsageMicros).toBeNull();
  });

  it('never carries a full key hash or anything beyond name + prefix', () => {
    const out = activitySamples(CTX, [{ key: BE, items: [item('2026-10-21', 'm', 0.01)] }]);
    expect(JSON.stringify(out)).not.toContain(BE.hash);
  });
});

describe('todaySamples', () => {
  it("is one MEDIUM ACTUAL row per service from usage_daily, today's day", () => {
    const rows = todaySamples(CTX, [BE, HARNESS, key('gogo-be-stag', 'dddddddd4444', 0.0001)]);
    expect(
      rows.map((r) => [
        r.day,
        r.serviceId,
        r.amountMicros,
        r.confidence,
        r.basis,
        r.metadata?.from,
      ]),
    ).toEqual([
      ['2026-10-22', 'openrouter.decisions', 500, 'MEDIUM', 'ACTUAL', 'keys.usage_daily'],
      ['2026-10-22', 'openrouter.dev_tooling', 200, 'MEDIUM', 'ACTUAL', 'keys.usage_daily'],
    ]);
  });

  it('no keys → no rows (not a zero)', () => {
    expect(todaySamples(CTX, [])).toEqual([]);
  });
});

const CLAUDE = key('gogo_claude_dev', 'eeeeeeee5555');

describe('anthropicByokSamples', () => {
  it('writes the Claude BYOK spend as Anthropic money, MEDIUM, per completed day', () => {
    const rows = anthropicByokSamples(CTX, [
      {
        key: CLAUDE,
        items: [
          item('2026-10-21', 'anthropic/claude-sonnet-5.5', 0.0002, { byokUsageUsd: 0.004 }),
          item('2026-10-21', 'anthropic/claude-haiku-5.5', 0.00005, { byokUsageUsd: 0.001 }),
          item('2026-10-22', 'anthropic/claude-sonnet-5.5', 0.1, { byokUsageUsd: 2 }),
        ],
      },
    ]);
    expect(rows).toEqual([
      {
        day: '2026-10-21',
        environment: 'dev',
        providerId: 'anthropic',
        serviceId: 'anthropic.claude_byok',
        operationId: null,
        usageMetricId: null,
        billingSkuId: null,
        billableQuantity: null,
        billableUnit: null,
        amountMicros: 5000,
        currency: 'USD',
        basis: 'ACTUAL',
        confidence: 'MEDIUM',
        source: OPENROUTER_SOURCE,
        costKind: 'USAGE',
        sourceAsOf: NOW,
        metadata: {
          from: 'openrouter.activity.byok_usage_inference',
          byModel: { 'anthropic/claude-sonnet-5.5': 4000, 'anthropic/claude-haiku-5.5': 1000 },
          keys: [{ name: 'gogo_claude_dev', hash: 'eeeeeeee' }],
        },
      },
    ]);
  });

  it('the OpenRouter fee and the Anthropic charge never land on the same row', () => {
    const keyed = [
      {
        key: CLAUDE,
        items: [item('2026-10-21', 'anthropic/claude-sonnet-5.5', 0.0002, { byokUsageUsd: 0.004 })],
      },
    ];
    const gateway = activitySamples(CTX, keyed).cost.filter((c) => c.day === '2026-10-21');
    expect(gateway.map((c) => [c.providerId, c.serviceId, c.amountMicros])).toEqual([
      ['openrouter', 'openrouter.claude_byok', 200],
    ]);
    expect(anthropicByokSamples(CTX, keyed).map((c) => [c.providerId, c.amountMicros])).toEqual([
      ['anthropic', 4000],
    ]);
  });

  it('skips non-Anthropic BYOK and items without the field; a day with none gets no row', () => {
    const rows = anthropicByokSamples(CTX, [
      {
        key: CLAUDE,
        items: [
          item('2026-10-20', 'openai/gpt-x', 0.0001, { byokUsageUsd: 0.5 }),
          item('2026-10-21', 'anthropic/claude-sonnet-5.5', 0.0001, { byokUsageUsd: null }),
          item('2026-10-19', 'claude-alias', 0, { byokUsageUsd: 0, providerName: 'Anthropic' }),
        ],
      },
    ]);
    expect(rows.map((r) => [r.day, r.amountMicros])).toEqual([['2026-10-19', 0]]);
  });

  it('is its own collector on provider anthropic, registered by the registry, free', () => {
    const fake: OpenRouterUsagePort = { keys: async () => [], activity: async () => [] };
    const def = anthropicByokCollector({} as never, fake);
    expect(def).toMatchObject({
      id: ANTHROPIC_BYOK_COLLECTOR_ID,
      providerId: 'anthropic',
      serviceId: 'anthropic.claude_byok',
      capability: 'ACTUAL_COST_COLLECTOR',
      essential: false,
      monitoringCost: { model: 'FREE', estimatedMonthlyMicros: 0 },
    });
    const s = new CollectorSchedulerService({} as never, COST_REGISTRY, { environment: 'dev' });
    s.register(openRouterActivityCollector({} as never, fake));
    s.register(def);
    expect(s.registered().map((c) => c.id)).toEqual([
      OPENROUTER_ACTIVITY_COLLECTOR_ID,
      ANTHROPIC_BYOK_COLLECTOR_ID,
    ]);
  });
});

describe('collector definition', () => {
  const fake: OpenRouterUsagePort = { keys: async () => [], activity: async () => [] };

  it('is a free, non-essential ACTUAL cost collector on the usual 6h cadence', () => {
    const def = openRouterActivityCollector({} as never, fake);
    expect(def).toMatchObject({
      id: OPENROUTER_ACTIVITY_COLLECTOR_ID,
      providerId: 'openrouter',
      serviceId: null,
      capability: 'ACTUAL_COST_COLLECTOR',
      frequencyMs: 6 * 60 * 60 * 1000,
      staleAfterMs: 24 * 60 * 60 * 1000,
      timeoutMs: 15_000,
      maxCallsPerDay: 8,
      enabledEnvironments: 'all',
      essential: false,
      monitoringCost: { model: 'FREE', estimatedMonthlyMicros: 0, currency: 'USD' },
    });
  });

  it('registers because the registry declares ACTUAL_COST_COLLECTOR for openrouter, and costs nothing', () => {
    const s = new CollectorSchedulerService({} as never, COST_REGISTRY, { environment: 'dev' });
    s.register(openRouterActivityCollector({} as never, fake));
    expect(s.registered().map((c) => c.id)).toEqual([OPENROUTER_ACTIVITY_COLLECTOR_ID]);
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

  it('reads /keys once, /activity once per key, then writes cost and meter rows', async () => {
    const asked: string[] = [];
    const recording: OpenRouterUsagePort = {
      keys: async (signal) => {
        asked.push('keys');
        expect(signal).toBeInstanceOf(AbortSignal);
        return [BE, HARNESS];
      },
      activity: async (hash, signal) => {
        asked.push(hash);
        expect(signal).toBeInstanceOf(AbortSignal);
        return hash === BE.hash ? [item('2026-10-21', 'm', 0.01)] : [];
      },
    };
    const { db, executed } = runDb();
    const result = await openRouterActivityCollector(db as never, recording, {
      now: () => NOW,
    }).run({
      environment: 'dev',
      now: NOW,
      day: '2026-10-22',
      signal: new AbortController().signal,
    });
    expect(asked).toEqual(['keys', BE.hash, HARNESS.hash]);
    // cost: decisions 10-21 (HIGH) + two today rows; usage: 3 meters. No zero for dev_tooling 10-21.
    expect(result).toEqual({ sourceAsOf: NOW, samples: 6 });
    expect(executed).toHaveLength(2);
  });

  it('writes nothing when one key’s activity fails — the run fails and freshness shows it', async () => {
    const failing: OpenRouterUsagePort = {
      keys: async () => [BE, HARNESS],
      activity: async (hash) => {
        if (hash === HARNESS.hash) throw new Error('openrouter activity 403');
        return [];
      },
    };
    const { db, executed } = runDb();
    await expect(
      openRouterActivityCollector(db as never, failing, { now: () => NOW }).run({
        environment: 'dev',
        now: NOW,
        day: '2026-10-22',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('openrouter activity 403');
    expect(executed).toHaveLength(0);
  });
});

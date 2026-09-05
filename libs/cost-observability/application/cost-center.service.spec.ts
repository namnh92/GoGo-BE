import { describe, expect, it } from 'vitest';
import { COST_REGISTRY, COST_REGISTRY_DATA, CostRegistry } from '../domain/registry';
import {
  buildProviderRow,
  buildServiceDetail,
  buildServiceRow,
  costCard,
  moneyFacts,
  rowFreshness,
  sourcesForService,
  usageLines,
  windowRange,
  type CostRowWithMeta,
  type FreshnessSourceRow,
  type RowInputs,
  type UsageRow,
} from './cost-center.service';

const NOW = new Date('2026-09-10T12:00:00Z');

const cost = (over: Partial<CostRowWithMeta> = {}): CostRowWithMeta => ({
  day: '2026-09-09',
  providerId: 'google',
  serviceId: 'google.places',
  operationId: 'google.details.quality',
  usageMetricId: 'requests',
  billingSkuId: 'places.details.enterprise',
  amountMicros: 1_000_000,
  currency: 'USD',
  basis: 'ESTIMATED',
  confidence: 'MEDIUM',
  source: 'estimator',
  updatedAt: '2026-09-09T10:00:00.000Z',
  ...over,
});

const usage = (over: Partial<UsageRow> = {}): UsageRow => ({
  day: '2026-09-09',
  providerId: 'google',
  serviceId: 'google.routes',
  operationId: 'google.routeMatrix',
  usageMetricId: 'billable_elements',
  billingSkuId: 'routes.computeRouteMatrix',
  quantity: 50,
  unit: 'matrix_element',
  source: 'ledger',
  confidence: 'HIGH',
  updatedAt: '2026-09-09T10:00:00.000Z',
  ...over,
});

const fresh = (over: Partial<FreshnessSourceRow> = {}): FreshnessSourceRow => ({
  sourceId: 'ledger',
  providerId: 'google',
  serviceId: null,
  lastSuccessfulAt: new Date('2026-09-10T11:55:00Z'),
  lastAttemptAt: new Date('2026-09-10T11:55:00Z'),
  sourceAsOf: new Date('2026-09-10T11:50:00Z'),
  staleAfterS: 24 * 3600,
  consecutiveFailures: 0,
  ...over,
});

const inputs = (over: Partial<RowInputs> = {}): RowInputs => ({
  costRows: [],
  usageRows: [],
  freshness: [],
  now: NOW,
  ...over,
});

describe('windowRange', () => {
  it('is day-shaped, ends today, and mtd starts on the first', () => {
    expect(windowRange('today', '2026-09-10')).toEqual({ from: '2026-09-10', to: '2026-09-10' });
    expect(windowRange('7d', '2026-09-10')).toEqual({ from: '2026-09-04', to: '2026-09-10' });
    expect(windowRange('30d', '2026-09-10')).toEqual({ from: '2026-08-12', to: '2026-09-10' });
    expect(windowRange('mtd', '2026-09-10')).toEqual({ from: '2026-09-01', to: '2026-09-10' });
    // Across a month boundary and a year boundary.
    expect(windowRange('7d', '2026-03-02')).toEqual({ from: '2026-02-24', to: '2026-03-02' });
    expect(windowRange('30d', '2026-01-05')).toEqual({ from: '2025-12-07', to: '2026-01-05' });
  });
});

describe('usageLines — one source per day, summed over days', () => {
  it('takes the most confident source for a day and never adds two sources', () => {
    const lines = usageLines(
      [
        usage({ day: '2026-09-08', quantity: 10, source: 'ledger', confidence: 'HIGH' }),
        usage({
          day: '2026-09-08',
          quantity: 12,
          source: 'prometheus_backfill',
          confidence: 'LOW',
        }),
        usage({
          day: '2026-09-09',
          quantity: 40,
          source: 'prometheus_backfill',
          confidence: 'LOW',
        }),
      ],
      COST_REGISTRY,
    );
    expect(lines).toHaveLength(1);
    // Day 8: ledger wins (10, not 22). Day 9: only the backfill exists (40).
    expect(lines[0]).toMatchObject({
      meterId: 'google.routeMatrix/billable_elements',
      quantity: 50,
      billable: true,
      unit: 'matrix_element',
      sources: ['ledger', 'prometheus_backfill'],
    });
  });

  it('keeps calls and billable elements as two lines, and an unregistered meter as a line with no id', () => {
    const lines = usageLines(
      [
        usage({ usageMetricId: 'calls', billingSkuId: null, unit: 'request', quantity: 12 }),
        usage({ quantity: 50 }),
        usage({
          operationId: 'google.routeMatrix',
          usageMetricId: 'mystery',
          billingSkuId: null,
          unit: 'request',
          quantity: 1,
        }),
      ],
      COST_REGISTRY,
    );
    expect(lines.map((l) => [l.meterId, l.quantity, l.billable])).toEqual([
      ['google.routeMatrix/billable_elements', 50, true],
      ['google.routeMatrix/calls', 12, false],
      [null, 1, false],
    ]);
  });
});

describe('rowFreshness — worst covering source, epic §23', () => {
  it('is UNKNOWN with no source, FRESH inside the window, STALE past it', () => {
    expect(rowFreshness([], NOW)).toEqual({ status: 'UNKNOWN', sourceAsOf: null, sources: [] });
    expect(rowFreshness([fresh()], NOW).status).toBe('FRESH');
    const stale = rowFreshness(
      [fresh({ lastSuccessfulAt: new Date('2026-09-08T00:00:00Z') })],
      NOW,
    );
    expect(stale.status).toBe('STALE');
    expect(stale.sourceAsOf).toBe('2026-09-10T11:50:00.000Z');
  });

  it('one bad source taints the row, and the newest sourceAsOf is reported', () => {
    const r = rowFreshness(
      [
        fresh(),
        fresh({
          sourceId: 'gcp_billing_export',
          lastSuccessfulAt: null,
          lastAttemptAt: new Date('2026-09-10T11:00:00Z'),
          sourceAsOf: null,
          consecutiveFailures: 3,
        }),
        fresh({ sourceId: 'zzz', sourceAsOf: new Date('2026-09-10T11:59:00Z') }),
      ],
      NOW,
    );
    expect(r.status).toBe('UNAVAILABLE');
    expect(r.sourceAsOf).toBe('2026-09-10T11:59:00.000Z');
    expect(r.sources.map((s) => [s.sourceId, s.status])).toEqual([
      ['gcp_billing_export', 'UNAVAILABLE'],
      ['ledger', 'FRESH'],
      ['zzz', 'FRESH'],
    ]);
  });

  it('a provider-wide source covers every service; a service source covers only its own', () => {
    const all = [fresh(), fresh({ sourceId: 'routes_only', serviceId: 'google.routes' })];
    expect(sourcesForService(all, 'google', 'google.places').map((s) => s.sourceId)).toEqual([
      'ledger',
    ]);
    expect(sourcesForService(all, 'google', 'google.routes').map((s) => s.sourceId)).toEqual([
      'ledger',
      'routes_only',
    ]);
    expect(sourcesForService(all, 'upstash', 'upstash.redis')).toEqual([]);
  });
});

describe('moneyFacts — epic §12 on a row', () => {
  it('no row is unknown (null), never zero', () => {
    const m = moneyFacts([], false);
    expect(m.spendMicros).toBeNull();
    expect(m.costStatus).toBe('UNKNOWN');
    expect(m.basis).toBe('UNKNOWN');
    expect(m.estimatedMicros).toBeNull();
  });

  it('a measured zero is 0 and says it is one', () => {
    const m = moneyFacts([], true);
    expect(m).toMatchObject({ spendMicros: 0, costStatus: 'MEASURED_ZERO', basis: 'ESTIMATED' });
  });

  it('ACTUAL shadows ESTIMATED for the same key: spend is the actual, both figures are kept, never summed', () => {
    const m = moneyFacts(
      [
        cost({ amountMicros: 8_200_000 }),
        cost({
          amountMicros: 8_310_000,
          basis: 'ACTUAL',
          confidence: 'HIGH',
          source: 'gcp_billing_export',
        }),
      ],
      false,
    );
    expect(m.spendMicros).toBe(8_310_000);
    expect(m.actualMicros).toBe(8_310_000);
    expect(m.estimatedMicros).toBe(8_200_000);
    expect(m.shadowedEstimatedMicros).toBe(8_200_000);
    expect(m.basis).toBe('ACTUAL');
    expect(m.confidence).toBe('HIGH');
    expect(m.costStatus).toBe('KNOWN');
  });

  it('a FIXED row beside an estimate is MIXED at the lowest confidence', () => {
    const m = moneyFacts(
      [
        cost({ amountMicros: 1_000_000 }),
        cost({
          day: '2026-09-09',
          serviceId: 'gogo.cost_observability',
          providerId: 'gogo',
          operationId: null,
          usageMetricId: null,
          billingSkuId: null,
          amountMicros: 10_000,
          basis: 'FIXED',
          confidence: 'LOW',
          source: 'monitoring_cost_model',
        }),
      ],
      false,
    );
    expect(m).toMatchObject({
      spendMicros: 1_010_000,
      estimatedMicros: 1_000_000,
      fixedMicros: 10_000,
      actualMicros: null,
      manualMicros: null,
      basis: 'MIXED',
      confidence: 'LOW',
      currency: 'USD',
      mixedCurrency: false,
    });
  });
});

describe('buildServiceRow / buildProviderRow', () => {
  const places = COST_REGISTRY.service('google.places')!;
  const routes = COST_REGISTRY.service('google.routes')!;
  const mapsIos = COST_REGISTRY.service('google.maps_sdk_ios')!;

  it('usage without a cost row is UNKNOWN with the usage lines shown', () => {
    const row = buildServiceRow(
      routes,
      COST_REGISTRY,
      inputs({ usageRows: [usage()], freshness: [fresh()] }),
    );
    expect(row.costStatus).toBe('UNKNOWN');
    expect(row.spendMicros).toBeNull();
    expect(row.usage.map((l) => l.quantity)).toEqual([50]);
    expect(row.freshness.status).toBe('FRESH');
    expect(row.quota).toBeNull();
    expect(row.lastUpdated).toBe('2026-09-09T10:00:00.000Z');
  });

  it('MEASURED_ZERO needs an instrumented operation and a FRESH or STALE source; otherwise UNKNOWN', () => {
    expect(
      buildServiceRow(places, COST_REGISTRY, inputs({ freshness: [fresh()] })).costStatus,
    ).toBe('MEASURED_ZERO');
    expect(
      buildServiceRow(
        places,
        COST_REGISTRY,
        inputs({ freshness: [fresh({ lastSuccessfulAt: new Date('2026-09-01T00:00:00Z') })] }),
      ).costStatus,
    ).toBe('MEASURED_ZERO');
    // No source at all: nobody was counting.
    expect(buildServiceRow(places, COST_REGISTRY, inputs()).costStatus).toBe('UNKNOWN');
    // The SDK renders on the handset: not instrumented, so never a measured zero.
    expect(buildServiceRow(mapsIos, COST_REGISTRY, inputs({ freshness: [fresh()] }))).toMatchObject(
      { costStatus: 'UNKNOWN', instrumented: false, spendMicros: null },
    );
  });

  it('the provider row counts every row of its own and lists its unknown services', () => {
    const google = COST_REGISTRY.provider('google')!;
    const row = buildProviderRow(
      google,
      COST_REGISTRY,
      inputs({
        costRows: [
          cost({ amountMicros: 2_000_000 }),
          // A service id the registry no longer knows: still the provider's money.
          cost({
            serviceId: 'google.legacy_thing',
            amountMicros: 5,
            source: 'manual_cost_items',
            basis: 'MANUAL',
          }),
        ],
        usageRows: [usage()],
        freshness: [fresh()],
      }),
    );
    expect(row.spendMicros).toBe(2_000_005);
    expect(row.basis).toBe('MIXED');
    expect(row.costStatus).toBe('KNOWN');
    expect(row.services.find((s) => s.serviceId === 'google.places')?.spendMicros).toBe(2_000_000);
    expect(row.services.find((s) => s.serviceId === 'google.routes')?.costStatus).toBe('UNKNOWN');
    expect(row.services.find((s) => s.serviceId === 'google.sheets')?.costStatus).toBe(
      'MEASURED_ZERO',
    );
    expect(row.unknownServices).toEqual([
      'google.routes',
      'google.maps_sdk_ios',
      'google.maps_sdk_android',
      'google.play_console',
    ]);
    expect(row.freshness.status).toBe('FRESH');
  });

  it('a provider whose instrumented services all measured zero is itself a measured zero', () => {
    const google = COST_REGISTRY.provider('google')!;
    const row = buildProviderRow(google, COST_REGISTRY, inputs({ freshness: [fresh()] }));
    expect(row.costStatus).toBe('MEASURED_ZERO');
    expect(row.spendMicros).toBe(0);
    // A planned provider with no source is unknown, and says so.
    const onesignal = COST_REGISTRY.provider('onesignal')!;
    expect(buildProviderRow(onesignal, COST_REGISTRY, inputs())).toMatchObject({
      costStatus: 'UNKNOWN',
      spendMicros: null,
      status: 'planned',
      unknownServices: ['onesignal.push'],
    });
    // An active provider whose collector is unconfigured (#384) is unknown too — not zero.
    const upstash = COST_REGISTRY.provider('upstash')!;
    expect(buildProviderRow(upstash, COST_REGISTRY, inputs())).toMatchObject({
      costStatus: 'UNKNOWN',
      spendMicros: null,
      status: 'active',
      unknownServices: ['upstash.redis'],
    });
  });

  it('the service detail groups meters by operation and keeps an unregistered label visible', () => {
    const detail = buildServiceDetail(
      routes,
      COST_REGISTRY,
      inputs({
        usageRows: [
          usage(),
          usage({ usageMetricId: 'calls', billingSkuId: null, unit: 'request', quantity: 12 }),
          usage({
            operationId: 'routes.somethingNew',
            usageMetricId: 'calls',
            billingSkuId: null,
            unit: 'request',
            quantity: 3,
          }),
        ],
      }),
    );
    expect(detail.operations.map((o) => [o.operationId, o.unregistered, o.meters.length])).toEqual([
      ['google.routeMatrix', false, 2],
      ['routes.somethingNew', true, 1],
    ]);
  });

  it('epic §44.2 — a provider added to the registry data appears as a row with no code change', () => {
    const acme = {
      id: 'acme',
      displayName: 'Acme',
      status: 'planned' as const,
      capabilities: [],
      services: [
        {
          id: 'acme.widgets',
          providerId: 'acme',
          displayName: 'Widgets',
          category: 'edge_compute' as const,
          runtime: 'none' as const,
          capabilities: [],
          operations: [],
        },
      ],
    };
    const registry = new CostRegistry({
      ...COST_REGISTRY_DATA,
      providers: [...COST_REGISTRY_DATA.providers, acme],
    });
    const row = buildProviderRow(
      acme,
      registry,
      inputs({
        costRows: [
          cost({
            providerId: 'acme',
            serviceId: 'acme.widgets',
            operationId: null,
            usageMetricId: null,
            billingSkuId: null,
            amountMicros: 42,
            basis: 'MANUAL',
            confidence: 'HIGH',
            source: 'manual_cost_items',
          }),
        ],
      }),
    );
    expect(row).toMatchObject({
      providerId: 'acme',
      spendMicros: 42,
      manualMicros: 42,
      basis: 'MANUAL',
      costStatus: 'KNOWN',
    });
    expect(row.services[0]).toMatchObject({ serviceId: 'acme.widgets', spendMicros: 42 });
  });
});

describe('ADR-0014 — the four dimensions on a row are independent', () => {
  const registry = COST_REGISTRY;
  const provider = (id: string) => registry.provider(id)!;
  const service = (id: string) => registry.service(id)!;

  it('Google is PARTIAL — three runtime services measured, the two Maps SDKs not — whatever its cost says', () => {
    const row = buildProviderRow(provider('google'), registry, inputs());
    expect(row.runtime).toEqual({
      coverage: 'PARTIAL',
      services: { full: 3, partial: 0, notInstrumented: 2 },
      operations: { instrumented: 10, total: 12 },
    });
    // No cost row and no source in this input: the cost dimension says so on
    // its own, and the runtime dimension above did not move.
    expect(row.cost).toEqual({ kind: 'AUTO', freshness: 'ERROR' });
    expect(row.status).toBe('active');
  });

  it('a collector-only provider is NOT_INSTRUMENTED at runtime and AUTO for cost; a fee is N/A and MANUAL; planned is N/A and NONE', () => {
    const upstash = buildProviderRow(provider('upstash'), registry, inputs());
    expect(upstash.runtime).toEqual({
      coverage: 'NOT_INSTRUMENTED',
      services: { full: 0, partial: 0, notInstrumented: 1 },
      operations: { instrumented: 0, total: 0 },
    });
    expect(upstash.cost.kind).toBe('AUTO');

    const apple = buildProviderRow(provider('apple'), registry, inputs());
    expect(apple.status).toBe('active');
    expect(apple.runtime.coverage).toBe('N/A');
    expect(apple.cost).toEqual({ kind: 'MANUAL', freshness: null });

    const onesignal = buildProviderRow(provider('onesignal'), registry, inputs());
    expect(onesignal.status).toBe('planned');
    expect(onesignal.runtime.coverage).toBe('N/A');
    expect(onesignal.cost).toEqual({ kind: 'NONE', freshness: null });

    // Nothing calls GitHub Actions from here, and its bill still arrives by code.
    const github = buildProviderRow(provider('github'), registry, inputs());
    expect(github.runtime.coverage).toBe('N/A');
    expect(github.cost.kind).toBe('AUTO');
  });

  it('AUTO freshness follows the §23 sources: FRESH and STALE as they are, UNAVAILABLE and never-ran both ERROR', () => {
    const google = provider('google');
    expect(
      buildProviderRow(google, registry, inputs({ freshness: [fresh()] })).cost.freshness,
    ).toBe('FRESH');
    expect(
      buildProviderRow(
        google,
        registry,
        inputs({ freshness: [fresh({ lastSuccessfulAt: new Date('2026-09-01T00:00:00Z') })] }),
      ).cost.freshness,
    ).toBe('STALE');
    expect(
      buildProviderRow(
        google,
        registry,
        inputs({ freshness: [fresh({ lastSuccessfulAt: null, consecutiveFailures: 3 })] }),
      ).cost.freshness,
    ).toBe('ERROR');
    expect(
      buildProviderRow(
        google,
        registry,
        inputs({ freshness: [fresh({ lastSuccessfulAt: null, lastAttemptAt: null })] }),
      ).cost.freshness,
    ).toBe('ERROR');
  });

  it('AUTO with no covering source is judged by its rows: a FIXED row today is FRESH, yesterday STALE, none ERROR', () => {
    const gogo = provider('gogo');
    const fixed = (day: string) =>
      cost({
        providerId: 'gogo',
        serviceId: 'gogo.cost_observability',
        operationId: null,
        usageMetricId: null,
        billingSkuId: null,
        basis: 'FIXED',
        confidence: 'HIGH',
        source: 'monitoring_cost_model',
        day,
      });
    expect(
      buildProviderRow(gogo, registry, inputs({ costRows: [fixed('2026-09-10')] })).cost,
    ).toEqual({
      kind: 'AUTO',
      freshness: 'FRESH',
    });
    expect(
      buildProviderRow(gogo, registry, inputs({ costRows: [fixed('2026-09-09')] })).cost,
    ).toEqual({
      kind: 'AUTO',
      freshness: 'STALE',
    });
    expect(buildProviderRow(gogo, registry, inputs()).cost).toEqual({
      kind: 'AUTO',
      freshness: 'ERROR',
    });
  });

  it('MANUAL freshness ignores collectors and reads the materialised rows: today FRESH, older STALE, nothing entered null', () => {
    const apple = provider('apple');
    const manual = (day: string) =>
      cost({
        providerId: 'apple',
        serviceId: 'apple.developer_program',
        operationId: null,
        usageMetricId: null,
        billingSkuId: null,
        basis: 'MANUAL',
        confidence: 'HIGH',
        source: 'manual_cost_items:1',
        day,
      });
    expect(
      buildProviderRow(apple, registry, inputs({ costRows: [manual('2026-09-10')] })).cost
        .freshness,
    ).toBe('FRESH');
    expect(
      buildProviderRow(apple, registry, inputs({ costRows: [manual('2026-09-01')] })).cost
        .freshness,
    ).toBe('STALE');
    // A stray freshness row under the provider changes nothing for a fee.
    expect(
      buildProviderRow(
        apple,
        registry,
        inputs({
          freshness: [fresh({ providerId: 'apple', sourceId: 'x', lastSuccessfulAt: null })],
        }),
      ).cost,
    ).toEqual({ kind: 'MANUAL', freshness: null });
  });

  it('service rows carry their own surface and kind: Play Console is MANUAL under an AUTO Google; a Maps SDK inherits AUTO and is NOT_INSTRUMENTED', () => {
    const play = buildServiceRow(service('google.play_console'), registry, inputs());
    expect(play.runtime).toEqual({
      surface: 'none',
      coverage: 'N/A',
      operations: { instrumented: 0, total: 0 },
    });
    expect(play.cost).toEqual({ kind: 'MANUAL', freshness: null });

    const sdk = buildServiceRow(
      service('google.maps_sdk_ios'),
      registry,
      inputs({ freshness: [fresh()] }),
    );
    expect(sdk.runtime).toEqual({
      surface: 'client_sdk',
      coverage: 'NOT_INSTRUMENTED',
      operations: { instrumented: 0, total: 1 },
    });
    expect(sdk.instrumented).toBe(false);
    expect(sdk.cost).toEqual({ kind: 'AUTO', freshness: 'FRESH' });

    const places = buildServiceRow(
      service('google.places'),
      registry,
      inputs({ freshness: [fresh()] }),
    );
    expect(places.runtime).toEqual({
      surface: 'in_process',
      coverage: 'FULL',
      operations: { instrumented: 7, total: 7 },
    });
    expect(places.instrumented).toBe(true);
  });
});

describe('costCard', () => {
  it('is null with no rows and counts contributing services otherwise', () => {
    expect(costCard([])).toEqual({
      spendMicros: null,
      byBasis: null,
      currency: null,
      mixedCurrency: false,
      services: 0,
    });
    const c = costCard([cost(), cost({ serviceId: 'google.routes', amountMicros: 5 })]);
    expect(c.spendMicros).toBe(1_000_005);
    expect(c.services).toBe(2);
  });
});

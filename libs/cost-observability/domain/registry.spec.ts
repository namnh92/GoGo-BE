import { describe, expect, it } from 'vitest';
import { PRICING_RULES, ruleInForce } from '../pricing/pricing-rules';
import {
  COST_REGISTRY,
  COST_REGISTRY_DATA,
  CostRegistry,
  RegistryError,
  assertCapabilitiesKnown,
  type RegistryData,
} from './registry';

const TODAY = '2026-09-03';

/** Epic §5 stable ids — the registry must name every one, immutable. */
const EPIC_PROVIDER_IDS = [
  'google',
  'aws',
  'cloudflare',
  'upstash',
  'neon',
  'onesignal',
  'tenjin',
  'grafana',
  'github',
  'sentry',
  'gogo',
];

/** Epic §3 P0 + P1 services. */
const EPIC_SERVICE_IDS = [
  'google.places',
  'google.routes',
  'google.maps_sdk_ios',
  'google.maps_sdk_android',
  'google.sheets',
  'cloudflare.r2',
  'cloudflare.workers',
  'upstash.redis',
  'neon.postgres',
  'aws.aggregate_billing',
  'github.actions',
  'gogo.cost_observability',
  'onesignal.push',
  'tenjin.attribution',
  'grafana.metrics',
  'sentry.errors',
];

describe('cost registry — epic §5 inventory', () => {
  it('names every stable provider id the epic lists', () => {
    for (const id of EPIC_PROVIDER_IDS) {
      expect(COST_REGISTRY.provider(id), id).not.toBeNull();
    }
  });

  it('names every P0/P1 service the epic lists, under its provider', () => {
    for (const id of EPIC_SERVICE_IDS) {
      const service = COST_REGISTRY.service(id);
      expect(service, id).not.toBeNull();
      expect(id.startsWith(`${service!.providerId}.`)).toBe(true);
    }
  });

  it('keeps Google as five services, not one bucket (epic §4)', () => {
    const ids = COST_REGISTRY.services('google').map((s) => s.id);
    for (const id of [
      'google.places',
      'google.routes',
      'google.maps_sdk_ios',
      'google.maps_sdk_android',
      'google.sheets',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('uses no display name as an identifier', () => {
    const idPattern = /^[a-z][a-z0-9_]*(\.[a-z][a-zA-Z0-9_]*)*(\/[a-z][a-z0-9_]*)?$/;
    for (const p of COST_REGISTRY.providers()) expect(p.id).toMatch(idPattern);
    for (const s of COST_REGISTRY.services()) expect(s.id).toMatch(idPattern);
    for (const m of COST_REGISTRY.meters()) expect(m.id).toMatch(idPattern);
    for (const o of COST_REGISTRY.operations()) expect(o.id).toMatch(/^[a-z][a-zA-Z0-9_.]*$/);
  });

  it('declares only real capabilities: active ≥ one, planned none; a status is never a cost fact (ADR-0014)', () => {
    expect(() => assertCapabilitiesKnown(COST_REGISTRY_DATA)).not.toThrow();
    for (const p of COST_REGISTRY.providers()) {
      expect(['active', 'planned'], p.id).toContain(p.status);
      if (p.status === 'active') expect(p.capabilities.length, p.id).toBeGreaterThan(0);
      if (p.status === 'planned') expect(p.capabilities, p.id).toEqual([]);
    }
    // Manual-only providers are integrated (the form exists), so they are
    // active; what makes them manual is the capability, and only that.
    for (const id of ['apple', 'hosting', 'registrar']) {
      const p = COST_REGISTRY.provider(id)!;
      expect(p.status, id).toBe('active');
      expect(p.capabilities, id).toEqual(['MANUAL_COST']);
      for (const s of p.services) {
        expect(s.capabilities, s.id).toEqual(['MANUAL_COST']);
        expect(s.runtime, s.id).toBe('none');
      }
    }
  });

  it('declares a runtime surface per service, independent of how its cost arrives (ADR-0014)', () => {
    const surface = (id: string) => COST_REGISTRY.service(id)!.runtime;
    for (const id of [
      'google.places',
      'google.routes',
      'google.sheets',
      'cloudflare.r2',
      'upstash.redis',
      'neon.postgres',
    ]) {
      expect(surface(id), id).toBe('in_process');
    }
    for (const id of ['google.maps_sdk_ios', 'google.maps_sdk_android']) {
      expect(surface(id), id).toBe('client_sdk');
    }
    // Collected or billed, and never called from here.
    for (const id of [
      'github.actions',
      'aws.aggregate_billing',
      'aws.ssm',
      'cloudflare.workers',
      'gogo.cost_observability',
      'google.play_console',
    ]) {
      expect(surface(id), id).toBe('none');
    }
    for (const p of COST_REGISTRY.providers().filter((p) => p.status === 'planned')) {
      for (const s of p.services) expect(s.runtime, s.id).toBe('none');
    }
  });

  it('answers MANUAL_COST per service — manual providers wholesale, Play Console alone under Google (#382)', () => {
    const manual = COST_REGISTRY.servicesWith('MANUAL_COST').map((s) => s.id);
    expect(manual).toEqual([
      'google.play_console',
      'apple.developer_program',
      'hosting.vps',
      'registrar.domain',
    ]);
    expect(COST_REGISTRY.serviceHasCapability('google.play_console', 'MANUAL_COST')).toBe(true);
    expect(COST_REGISTRY.serviceHasCapability('google.places', 'MANUAL_COST')).toBe(false);
    expect(COST_REGISTRY.hasCapability('google', 'MANUAL_COST')).toBe(false);
    expect(COST_REGISTRY.serviceHasCapability('hosting.vps', 'MANUAL_COST')).toBe(true);
    expect(COST_REGISTRY.serviceHasCapability('nope.nothing', 'MANUAL_COST')).toBe(false);
    expect(COST_REGISTRY.providersWith('MANUAL_COST').map((p) => p.id)).toEqual([
      'apple',
      'hosting',
      'registrar',
    ]);
  });
});

describe('cost registry — operation ≠ SKU ≠ unit (epic §4, §44.21–.22)', () => {
  it('counts Routes with two meters: calls (not billed) and matrix elements (billed)', () => {
    const op = COST_REGISTRY.operation('google.routeMatrix')!;
    const byMetric = Object.fromEntries(op.usageMeters.map((m) => [m.metric, m]));
    expect(byMetric['calls']).toMatchObject({
      unit: 'request',
      billable: false,
      billingSkuId: null,
    });
    expect(byMetric['billable_elements']).toMatchObject({
      unit: 'matrix_element',
      billable: true,
      billingSkuId: 'routes.computeRouteMatrix',
    });
  });

  it('folds a billing SKU back onto the operation that spent it', () => {
    expect(COST_REGISTRY.operationForBillingSku('routes.computeRouteMatrix')).toBe(
      'google.routeMatrix',
    );
    // An unregistered SKU folds onto itself, so it surfaces as a gap.
    expect(COST_REGISTRY.operationForBillingSku('vietmap.search')).toBe('vietmap.search');
  });

  it('keeps every billing SKU claimed by exactly one operation', () => {
    const claims = new Map<string, string>();
    for (const m of COST_REGISTRY.meters()) {
      if (m.billingSkuId === null || m.operationId === null) continue;
      const prior = claims.get(m.billingSkuId);
      expect(prior === undefined || prior === m.operationId, m.billingSkuId).toBe(true);
      claims.set(m.billingSkuId, m.operationId);
    }
  });

  it('prices every billable meter with a rule, or explicitly with an unknown price', () => {
    for (const m of COST_REGISTRY.meters()) {
      if (!m.billable) continue;
      const rule = ruleInForce(PRICING_RULES, { billingSkuId: m.billingSkuId }, TODAY);
      expect(rule, `no pricing rule for ${m.id}`).not.toBeNull();
      // `null` is an explicit "unknown"; 0 only under FREE. Never undefined.
      expect(rule!.unitPriceMicros === null || typeof rule!.unitPriceMicros === 'number').toBe(
        true,
      );
    }
  });
});

describe('cost registry — attribution', () => {
  it('routes exact operation ids to their service', () => {
    expect(COST_REGISTRY.serviceForOperation('google.details.core')?.id).toBe('google.places');
    expect(COST_REGISTRY.serviceForOperation('google.sheets.values')?.id).toBe('google.sheets');
    expect(COST_REGISTRY.providerForOperation('google.maps_sdk_ios')?.id).toBe('google');
  });

  it('attributes an unregistered label by the longest declared prefix, or not at all', () => {
    // Data on the service, not a switch in code (epic §44.3).
    expect(COST_REGISTRY.serviceForOperation('google.details.somethingNew')?.id).toBe(
      'google.places',
    );
    expect(COST_REGISTRY.serviceForOperation('google.sheets.batch')?.id).toBe('google.sheets');
    expect(COST_REGISTRY.serviceForOperation('routes.computeRoutes')?.id).toBe('google.routes');
    expect(COST_REGISTRY.serviceForOperation('vietmap.search')).toBeNull();
  });

  it('discovers capabilities from the registry, never from a name', () => {
    expect(COST_REGISTRY.hasCapability('google', 'USAGE_COLLECTOR')).toBe(true);
    expect(COST_REGISTRY.hasCapability('google', 'ACTUAL_COST_COLLECTOR')).toBe(false);
    expect(COST_REGISTRY.providersWith('BUDGET').map((p) => p.id)).toEqual(['google']);
    expect(COST_REGISTRY.hasCapability('nobody', 'QUOTA')).toBe(false);
  });
});

describe('cost registry — invariants at construction', () => {
  const minimal = (): RegistryData => ({
    billingSkus: [{ id: 'x.sku', providerId: 'x', displayName: 'X' }],
    providers: [
      {
        id: 'x',
        displayName: 'X',
        status: 'active',
        capabilities: ['USAGE_COLLECTOR'],
        services: [
          {
            id: 'x.svc',
            providerId: 'x',
            displayName: 'Svc',
            category: 'internal',
            runtime: 'in_process',
            capabilities: [],
            operations: [
              {
                id: 'x.op',
                serviceId: 'x.svc',
                displayName: 'Op',
                instrumented: true,
                usageMeters: [
                  {
                    id: 'x.op/requests',
                    metric: 'requests',
                    serviceId: 'x.svc',
                    operationId: 'x.op',
                    billingSkuId: 'x.sku',
                    unit: 'request',
                    billable: true,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  it('accepts a well-formed registry', () => {
    expect(() => new CostRegistry(minimal())).not.toThrow();
  });

  it('refuses an instrumented operation on a service that declares no runtime', () => {
    const data = minimal();
    (data.providers[0]!.services[0] as { runtime: string }).runtime = 'none';
    expect(() => new CostRegistry(data)).toThrow(/declares no runtime/);
  });

  it('refuses a service filed under the wrong provider', () => {
    const data = minimal();
    (data.providers[0]!.services[0] as { providerId: string }).providerId = 'y';
    expect(() => new CostRegistry(data)).toThrow(RegistryError);
  });

  it('refuses a billable meter without a billing SKU', () => {
    const data = minimal();
    (
      data.providers[0]!.services[0]!.operations[0]!.usageMeters[0] as {
        billingSkuId: string | null;
      }
    ).billingSkuId = null;
    expect(() => new CostRegistry(data)).toThrow(/names no billing sku/);
  });

  it('refuses a meter that names an unknown SKU', () => {
    const data = minimal();
    (
      data.providers[0]!.services[0]!.operations[0]!.usageMeters[0] as {
        billingSkuId: string | null;
      }
    ).billingSkuId = 'x.nope';
    expect(() => new CostRegistry(data)).toThrow(/unknown billing sku/);
  });

  it('refuses duplicate ids', () => {
    const data = minimal();
    const dup = { ...data.providers[0]! };
    expect(() => new CostRegistry({ ...data, providers: [data.providers[0]!, dup] })).toThrow(
      /duplicate provider/,
    );
  });
});

describe('adding a provider (epic §40)', () => {
  it('is data only: a new provider with a service and meter is attributable with no code change', () => {
    const data: RegistryData = {
      billingSkus: [
        ...COST_REGISTRY_DATA.billingSkus,
        { id: 'openai.tokens', providerId: 'openai', displayName: 'Tokens' },
      ],
      providers: [
        ...COST_REGISTRY_DATA.providers,
        {
          id: 'openai',
          displayName: 'OpenAI',
          status: 'active',
          capabilities: ['USAGE_COLLECTOR', 'ESTIMATED_COST'],
          services: [
            {
              id: 'openai.responses',
              providerId: 'openai',
              displayName: 'Responses',
              category: 'internal',
              runtime: 'in_process',
              capabilities: ['USAGE_COLLECTOR'],
              operationPrefixes: ['openai.'],
              operations: [
                {
                  id: 'openai.responses.create',
                  serviceId: 'openai.responses',
                  displayName: 'Create response',
                  instrumented: true,
                  usageMeters: [
                    {
                      id: 'openai.responses.create/tokens',
                      metric: 'tokens',
                      serviceId: 'openai.responses',
                      operationId: 'openai.responses.create',
                      billingSkuId: 'openai.tokens',
                      unit: 'request',
                      billable: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const registry = new CostRegistry(data);
    expect(registry.providerForOperation('openai.responses.create')?.id).toBe('openai');
    expect(registry.providerForOperation('openai.embeddings.create')?.id).toBe('openai');
    expect(registry.providersWith('USAGE_COLLECTOR').map((p) => p.id)).toEqual([
      'google',
      'cloudflare',
      'upstash',
      'neon',
      'github',
      'openai',
    ]);
    // The existing Google attribution is untouched by the addition.
    expect(registry.serviceForOperation('google.routeMatrix')?.id).toBe('google.routes');
  });
});

describe('aws and github (#386)', () => {
  it('aws is an actual-bill provider: no usage collector, no estimate, no billable meter', () => {
    const aws = COST_REGISTRY.provider('aws')!;
    expect(aws.status).toBe('active');
    expect(aws.capabilities).toEqual(['ACTUAL_COST_COLLECTOR']);
    expect(COST_REGISTRY.providersWith('ACTUAL_COST_COLLECTOR').map((p) => p.id)).toEqual([
      'aws',
      'github',
    ]);
    const meters = COST_REGISTRY.meters()
      .filter((m) => m.serviceId.startsWith('aws.'))
      .map((m) => [m.id, m.billingSkuId, m.unit, m.billable]);
    expect(meters).toEqual([
      ['aws.aggregate_billing/billed_usd_micros', null, 'usd_micros', false],
      ['aws.ssm/api_requests', null, 'request', false],
    ]);
    // Nothing prices AWS: the money comes from Cost Explorer, not a rule.
    expect(PRICING_RULES.filter((r) => r.providerId === 'aws')).toEqual([]);
  });

  it('github is metered, estimated and actual at once, with one billed minute meter', () => {
    const github = COST_REGISTRY.provider('github')!;
    expect(github.status).toBe('active');
    expect(github.capabilities).toEqual([
      'USAGE_COLLECTOR',
      'ESTIMATED_COST',
      'ACTUAL_COST_COLLECTOR',
    ]);
    const meters = COST_REGISTRY.meters()
      .filter((m) => m.serviceId === 'github.actions')
      .map((m) => [m.id, m.billingSkuId, m.unit, m.billable]);
    expect(meters).toEqual([['github.actions/minutes', 'actions.minutes', 'minute', true]]);
    expect(COST_REGISTRY.billingSku('actions.minutes')).toMatchObject({ providerId: 'github' });
    expect(ruleInForce(PRICING_RULES, { billingSkuId: 'actions.minutes' }, TODAY)).not.toBeNull();
  });
});

describe('neon (#385)', () => {
  it('is active with USAGE_COLLECTOR + ESTIMATED_COST; three billed meters, two collected-only', () => {
    const neon = COST_REGISTRY.provider('neon')!;
    expect(neon.status).toBe('active');
    expect(neon.capabilities).toEqual(['USAGE_COLLECTOR', 'ESTIMATED_COST']);
    const meters = COST_REGISTRY.meters()
      .filter((m) => m.serviceId === 'neon.postgres')
      .map((m) => [m.id, m.billingSkuId, m.unit, m.billable]);
    expect(meters).toEqual([
      ['neon.postgres/compute_hours', 'postgres.compute', 'compute_hour', true],
      ['neon.postgres/storage_gb_month', 'postgres.storage', 'gb_month', true],
      ['neon.postgres/data_transfer_gb', 'postgres.data_transfer', 'gb', true],
      ['neon.postgres/written_data_gb', null, 'gb', false],
      ['neon.postgres/storage_bytes', null, 'byte', false],
    ]);
    expect(COST_REGISTRY.billingSku('postgres.compute')).toMatchObject({ providerId: 'neon' });
  });
});

describe('cloudflare (#383)', () => {
  it('is active with USAGE_COLLECTOR + ESTIMATED_COST, and its billed meters name their SKUs', () => {
    const cf = COST_REGISTRY.provider('cloudflare')!;
    expect(cf.status).toBe('active');
    expect(cf.capabilities).toEqual(['USAGE_COLLECTOR', 'ESTIMATED_COST']);
    expect(COST_REGISTRY.providersWith('USAGE_COLLECTOR').map((p) => p.id)).toEqual([
      'google',
      'cloudflare',
      'upstash',
      'neon',
      'github',
    ]);
    const billed = COST_REGISTRY.meters()
      .filter((m) => m.serviceId.startsWith('cloudflare.') && m.billable)
      .map((m) => [m.id, m.billingSkuId, m.unit]);
    expect(billed).toEqual([
      ['cloudflare.r2/class_a', 'r2.class_a', 'operation'],
      ['cloudflare.r2/class_b', 'r2.class_b', 'operation'],
      ['cloudflare.r2/storage_gb_month', 'r2.storage', 'gb_month'],
      ['cloudflare.workers/requests', 'workers.requests', 'request'],
    ]);
    // Declared, not collected, not billed: no source exposes them (epic §44.8).
    expect(COST_REGISTRY.meter('cloudflare.r2/egress_gb')).toMatchObject({
      billable: false,
      billingSkuId: null,
    });
    expect(COST_REGISTRY.meter('cloudflare.workers/cpu_ms')).toMatchObject({
      billable: false,
      billingSkuId: null,
      unit: 'millisecond',
    });
  });
});

describe('upstash (#384)', () => {
  it('is active with USAGE_COLLECTOR + ESTIMATED_COST; commands is billed, the byte meters are not', () => {
    const up = COST_REGISTRY.provider('upstash')!;
    expect(up.status).toBe('active');
    expect(up.capabilities).toEqual(['USAGE_COLLECTOR', 'ESTIMATED_COST']);
    expect(COST_REGISTRY.serviceHasCapability('upstash.redis', 'USAGE_COLLECTOR')).toBe(true);
    const meters = COST_REGISTRY.meters()
      .filter((m) => m.serviceId === 'upstash.redis')
      .map((m) => [m.id, m.billingSkuId, m.unit, m.billable]);
    expect(meters).toEqual([
      ['upstash.redis/commands', 'redis.commands', 'command', true],
      ['upstash.redis/storage_bytes', null, 'byte', false],
      ['upstash.redis/bandwidth_bytes', null, 'byte', false],
    ]);
    expect(COST_REGISTRY.billingSku('redis.commands')).toMatchObject({ providerId: 'upstash' });
  });
});

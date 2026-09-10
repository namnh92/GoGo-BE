import type { RuntimeOperation } from '@gogo/observability';
import { CAPABILITIES, type Capability } from './capabilities';
import { NEON_POSTGRES_OPERATIONS, UPSTASH_REDIS_OPERATIONS } from './runtime-operations';

/**
 * COST-BE-015 (#367) — epic §5, the one canonical registry.
 *
 * Four kinds of definition, nested: a **provider** offers **services**, a
 * service exposes **operations** (what the code calls), and an operation is
 * counted by one or more **usage meters** (what is actually billed). The
 * distinction the epic §4 insists on lives in the last step: a Routes call is
 * one operation with two meters — `calls` (a request, not billed) and
 * `billable_elements` (matrix elements, billed) — and neither is the other.
 *
 * Ids are stable strings, immutable once anything persists them (the ledger
 * and cost tables in COST-BE-016 key on them). Display names are never
 * identifiers. Anything that is *not* the definition of a provider — its
 * price, its collector, its budget ceiling — lives elsewhere and refers here
 * by id; the registry knows what exists, not what it costs or how to read it.
 *
 * Generic code reads this through `CostRegistry` and asks questions
 * (`serviceForOperation`, `hasCapability`). It never compares an id to a
 * literal.
 */

/**
 * Integration lifecycle only. How a provider's cost gets in (a collector, a
 * hand-typed item, nothing) is a capability, read through `costSourceKind`;
 * whether its runtime is measured is `runtime` on each service, read through
 * `providerRuntime`. Neither is a status, and a status never encodes them —
 * the old `manual` value did, and ADR-0014 retired it.
 */
export type ProviderStatus =
  /** Integrated: at least one capability is implemented. */
  | 'active'
  /** Named in the epic inventory, no integration yet. Visible as "chưa nối". */
  | 'planned';

/**
 * Whether anything of GoGo's calls the service at runtime — the precondition
 * for request-level telemetry (calls, latency, errors), and a fact about the
 * deployment rather than about cost.
 *
 * - `in_process`: this API/worker process calls it (Places, Redis, Postgres…).
 * - `client_sdk`: a GoGo client calls it directly (the Maps SDKs); telemetry
 *   can only arrive through an ingestion endpoint.
 * - `none`: nobody calls it on a request path — a bill, a CI runner, a fee,
 *   or a provider nothing is wired to yet. Runtime coverage is N/A, not a gap.
 *
 * Declared, never inferred: a service with a cost collector and no runtime
 * (GitHub Actions) and one with a runtime and no cost collector are both
 * real, and inferring one dimension from the other is the confusion
 * ADR-0014 exists to end.
 */
export type RuntimeSurface = 'in_process' | 'client_sdk' | 'none';

export type ServiceCategory =
  | 'maps'
  | 'routing'
  | 'maps_sdk'
  | 'spreadsheet'
  | 'object_storage'
  | 'edge_compute'
  | 'cache'
  | 'database'
  | 'secrets'
  | 'billing'
  | 'ci'
  | 'push'
  | 'attribution'
  | 'observability'
  | 'errors'
  | 'internal'
  | 'platform_fee'
  | 'hosting'
  /**
   * COST-BE-040 (#563) — work and tools paid for by hand: development, bug
   * fixing, dev tooling. Not `platform_fee` (nobody's platform) and not
   * `internal` — `internal` is the cost of monitoring (§21), and
   * `costOfMonitoring` sums it.
   */
  | 'operations';

/**
 * Units a meter can count in. A closed list so a pricing rule and a meter can
 * be checked against each other, and so `unit` in the tables is never free
 * text.
 */
export type MeterUnit =
  | 'request'
  | 'matrix_element'
  | 'map_load'
  | 'command'
  | 'operation'
  | 'byte'
  | 'gb'
  | 'gb_month'
  | 'millisecond'
  | 'minute'
  | 'compute_hour'
  | 'notification'
  | 'conversion'
  | 'active_user'
  | 'series'
  | 'event'
  | 'run'
  | 'usd_micros';

export type ProviderDefinition = {
  id: string;
  displayName: string;
  status: ProviderStatus;
  services: readonly ServiceDefinition[];
  /** What the Cost Center can do for this provider today. Empty = nothing yet. */
  capabilities: readonly Capability[];
  /** Where the provider bills from, when not UTC (epic §16). */
  billingTimezone?: string;
};

export type ServiceDefinition = {
  /** `<providerId>.<service>` — `google.places`, `cloudflare.r2`. */
  id: string;
  providerId: string;
  displayName: string;
  category: ServiceCategory;
  /** See `RuntimeSurface`. Coverage is computed from this and `operations[].instrumented`. */
  runtime: RuntimeSurface;
  capabilities: readonly Capability[];
  operations: readonly OperationDefinition[];
  /**
   * Meters that belong to the service as a whole rather than to one call —
   * storage held, compute hours, series count. Operation meters live on the
   * operation.
   */
  meters?: readonly UsageMeterDefinition[];
  /**
   * Data, not code, for the backstop `providerOf` needs: an operation label
   * nobody registered (a SKU somebody forgot to fold) is attributed to the
   * service whose prefix matches longest, so a billed call never vanishes from
   * a provider row. Generic code matches prefixes; it does not know their
   * values.
   */
  operationPrefixes?: readonly string[];
};

export type OperationDefinition = {
  /** The adapter's `method` label, verbatim — `google.details.core`. */
  id: string;
  serviceId: string;
  displayName: string;
  /** False = this process emits no metric for it. Reported as a gap, never zero. */
  instrumented: boolean;
  /**
   * #427 — runs once per process boot (a warm-up connect), not on the request
   * path. Its last outcome in this process is reported on the service row as
   * `runtime.connection`; its counter still lands on the same series family.
   */
  bootstrap?: boolean;
  usageMeters: readonly UsageMeterDefinition[];
};

export type UsageMeterDefinition = {
  /** Unique across the registry: `<operationId|serviceId>/<metric>`. */
  id: string;
  /** Short name persisted as `usage_metric_id` — `calls`, `billable_elements`. */
  metric: string;
  serviceId: string;
  operationId: string | null;
  /** The billing SKU this meter is charged under, or `null` when not billed. */
  billingSkuId: string | null;
  unit: MeterUnit;
  billable: boolean;
  /**
   * Which pricing rules apply. Defaults to the SKU id; a meter billed under
   * no SKU has no pricing key and no price.
   */
  pricingKey?: string;
};

/**
 * A billing SKU as the provider names it. Not an epic table — kept so a
 * console can print "Place Details Enterprise" next to `google.details.quality`
 * without the display string leaking into an id.
 */
export type BillingSkuDefinition = {
  id: string;
  providerId: string;
  displayName: string;
};

export type RegistryData = {
  providers: readonly ProviderDefinition[];
  billingSkus: readonly BillingSkuDefinition[];
};

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * Read-only lookups over the definitions. Built once at module load and
 * validated on construction so a malformed registry fails at boot, not at the
 * first dashboard render.
 */
export class CostRegistry {
  private readonly providersById = new Map<string, ProviderDefinition>();
  private readonly servicesById = new Map<string, ServiceDefinition>();
  private readonly operationsById = new Map<string, OperationDefinition>();
  private readonly metersById = new Map<string, UsageMeterDefinition>();
  private readonly skusById = new Map<string, BillingSkuDefinition>();
  private readonly operationBySku = new Map<string, OperationDefinition>();
  private readonly prefixes: { prefix: string; serviceId: string }[] = [];

  constructor(readonly data: RegistryData) {
    for (const sku of data.billingSkus) {
      if (this.skusById.has(sku.id)) throw new RegistryError(`duplicate billing sku ${sku.id}`);
      this.skusById.set(sku.id, sku);
    }
    for (const provider of data.providers) {
      if (this.providersById.has(provider.id)) {
        throw new RegistryError(`duplicate provider ${provider.id}`);
      }
      this.providersById.set(provider.id, provider);
      for (const service of provider.services) {
        if (service.providerId !== provider.id) {
          throw new RegistryError(`service ${service.id} claims provider ${service.providerId}`);
        }
        if (!service.id.startsWith(`${provider.id}.`)) {
          throw new RegistryError(`service ${service.id} must be prefixed ${provider.id}.`);
        }
        if (this.servicesById.has(service.id)) {
          throw new RegistryError(`duplicate service ${service.id}`);
        }
        this.servicesById.set(service.id, service);
        for (const prefix of service.operationPrefixes ?? []) {
          this.prefixes.push({ prefix, serviceId: service.id });
        }
        for (const meter of service.meters ?? []) this.addMeter(meter, service.id, null);
        for (const operation of service.operations) {
          if (operation.serviceId !== service.id) {
            throw new RegistryError(
              `operation ${operation.id} claims service ${operation.serviceId}`,
            );
          }
          if (this.operationsById.has(operation.id)) {
            throw new RegistryError(`duplicate operation ${operation.id}`);
          }
          if (service.runtime === 'none' && operation.instrumented) {
            throw new RegistryError(
              `operation ${operation.id} is instrumented on ${service.id}, which declares no runtime`,
            );
          }
          this.operationsById.set(operation.id, operation);
          for (const meter of operation.usageMeters) this.addMeter(meter, service.id, operation.id);
        }
      }
    }
    // Longest prefix wins, so `google.sheets.` beats `google.`.
    this.prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  private addMeter(meter: UsageMeterDefinition, serviceId: string, operationId: string | null) {
    if (meter.serviceId !== serviceId || meter.operationId !== operationId) {
      throw new RegistryError(`meter ${meter.id} is filed under the wrong service/operation`);
    }
    if (this.metersById.has(meter.id)) throw new RegistryError(`duplicate meter ${meter.id}`);
    if (meter.billable && meter.billingSkuId === null) {
      throw new RegistryError(`billable meter ${meter.id} names no billing sku`);
    }
    if (meter.billingSkuId !== null && !this.skusById.has(meter.billingSkuId)) {
      throw new RegistryError(`meter ${meter.id} names unknown billing sku ${meter.billingSkuId}`);
    }
    this.metersById.set(meter.id, meter);
    if (meter.billingSkuId !== null && operationId !== null) {
      const existing = this.operationBySku.get(meter.billingSkuId);
      if (existing && existing.id !== operationId) {
        throw new RegistryError(
          `billing sku ${meter.billingSkuId} is claimed by ${existing.id} and ${operationId}`,
        );
      }
      this.operationBySku.set(meter.billingSkuId, this.operationsById.get(operationId)!);
    }
  }

  providers(): readonly ProviderDefinition[] {
    return this.data.providers;
  }

  provider(id: string): ProviderDefinition | null {
    return this.providersById.get(id) ?? null;
  }

  services(providerId?: string): readonly ServiceDefinition[] {
    const all = [...this.servicesById.values()];
    return providerId === undefined ? all : all.filter((s) => s.providerId === providerId);
  }

  service(id: string): ServiceDefinition | null {
    return this.servicesById.get(id) ?? null;
  }

  operations(serviceId?: string): readonly OperationDefinition[] {
    const all = [...this.operationsById.values()];
    return serviceId === undefined ? all : all.filter((o) => o.serviceId === serviceId);
  }

  operation(id: string): OperationDefinition | null {
    return this.operationsById.get(id) ?? null;
  }

  meters(): readonly UsageMeterDefinition[] {
    return [...this.metersById.values()];
  }

  meter(id: string): UsageMeterDefinition | null {
    return this.metersById.get(id) ?? null;
  }

  billingSku(id: string): BillingSkuDefinition | null {
    return this.skusById.get(id) ?? null;
  }

  /**
   * Epic §4 / §44.24 — the fold from a billing SKU back to the runtime
   * operation that spent it, so a report shows one logical row. The Routes
   * SKU `routes.computeRouteMatrix` folds onto `google.routeMatrix`; a SKU
   * that is not registered folds onto itself, which is how it shows up as a
   * gap instead of disappearing.
   */
  operationForBillingSku(skuId: string): string {
    return this.operationBySku.get(skuId)?.id ?? skuId;
  }

  /**
   * The service an operation label belongs to: exact match first, then the
   * longest registered prefix (data on the service, epic §44.3), else `null`.
   */
  serviceForOperation(operationId: string): ServiceDefinition | null {
    const exact = this.operationsById.get(operationId);
    if (exact) return this.servicesById.get(exact.serviceId) ?? null;
    const hit = this.prefixes.find(({ prefix }) => operationId.startsWith(prefix));
    return hit ? (this.servicesById.get(hit.serviceId) ?? null) : null;
  }

  providerForOperation(operationId: string): ProviderDefinition | null {
    const service = this.serviceForOperation(operationId);
    return service ? (this.providersById.get(service.providerId) ?? null) : null;
  }

  /** The meter that is billed for an operation, or `null` when nothing is. */
  billableMeterFor(operationId: string): UsageMeterDefinition | null {
    const op = this.operationsById.get(operationId);
    return op?.usageMeters.find((m) => m.billable) ?? null;
  }

  /** The `calls` meter of an operation — every call-shaped operation has one. */
  callsMeterFor(operationId: string): UsageMeterDefinition | null {
    const op = this.operationsById.get(operationId);
    return op?.usageMeters.find((m) => m.metric === 'calls') ?? null;
  }

  hasCapability(providerId: string, capability: Capability): boolean {
    return this.providersById.get(providerId)?.capabilities.includes(capability) ?? false;
  }

  /**
   * A service has a capability when it declares it or its provider does — a
   * provider-wide capability covers every service, a service-only one (Play
   * Console under Google) covers just that service.
   */
  serviceHasCapability(serviceId: string, capability: Capability): boolean {
    const service = this.servicesById.get(serviceId);
    if (!service) return false;
    return (
      service.capabilities.includes(capability) ||
      this.hasCapability(service.providerId, capability)
    );
  }

  /** Every provider that declares `capability`. Generic discovery, epic §6. */
  providersWith(capability: Capability): readonly ProviderDefinition[] {
    return this.data.providers.filter((p) => p.capabilities.includes(capability));
  }

  /** Every service that has `capability` (own or inherited), registry order. */
  servicesWith(capability: Capability): readonly ServiceDefinition[] {
    return this.services().filter((s) => this.serviceHasCapability(s.id, capability));
  }
}

// ── seed ─────────────────────────────────────────────────────────────────────

const google = (service: string) => `google.${service}`;

/**
 * Every call-shaped operation counts `calls` (attempted requests, never
 * billed) and, when a SKU bills it, `requests` (served requests, billed). The
 * two are the epic §4 distinction in miniature: a 429 is a call that happened
 * and cost nothing.
 */
/**
 * #414 — an infrastructure operation: measured at runtime, metered by nobody
 * here. `id` is the label value the adapter emits, so the two cannot drift.
 */
function runtimeOperation(
  op: RuntimeOperation,
  displayName: string,
  flags: { bootstrap?: boolean } = {},
): OperationDefinition {
  return {
    id: op.operation,
    serviceId: op.service,
    displayName,
    instrumented: true,
    ...(flags.bootstrap ? { bootstrap: true } : {}),
    usageMeters: [],
  };
}

function callMeters(
  operationId: string,
  serviceId: string,
  billingSkuId: string | null,
): readonly UsageMeterDefinition[] {
  const calls: UsageMeterDefinition = {
    id: `${operationId}/calls`,
    metric: 'calls',
    serviceId,
    operationId,
    billingSkuId: null,
    unit: 'request',
    billable: false,
  };
  if (billingSkuId === null) return [calls];
  return [
    calls,
    {
      id: `${operationId}/requests`,
      metric: 'requests',
      serviceId,
      operationId,
      billingSkuId,
      unit: 'request',
      billable: true,
    },
  ];
}

const PLACES = google('places');
const ROUTES = google('routes');
const SHEETS = google('sheets');
const MAPS_IOS = google('maps_sdk_ios');
const MAPS_ANDROID = google('maps_sdk_android');

/**
 * Billing SKU ids are GoGo's stable keys; the display name is Google's. The
 * Routes id is the exact string the adapter already emits as a metric label
 * (`places_provider_cost_units{sku}`), and must stay so — the ledger folds it.
 */
const GOOGLE_SKUS: readonly BillingSkuDefinition[] = [
  {
    id: 'places.textSearch.idsOnly',
    providerId: 'google',
    displayName: 'Places API (New) — Text Search Essentials IDs Only',
  },
  {
    // #505 — the same endpoint at a different field category, and therefore a
    // different SKU: `places.googleMapsUri` is a Pro field for Text Search.
    id: 'places.textSearch.pro',
    providerId: 'google',
    displayName: 'Places API (New) — Text Search Pro',
  },
  {
    id: 'places.details.idsOnly',
    providerId: 'google',
    displayName: 'Places API (New) — Place Details Essentials IDs Only',
  },
  {
    id: 'places.details.pro',
    providerId: 'google',
    displayName: 'Places API (New) — Place Details Pro',
  },
  {
    id: 'places.details.enterprise',
    providerId: 'google',
    displayName: 'Places API (New) — Place Details Enterprise',
  },
  {
    id: 'places.details.enterpriseAtmosphere',
    providerId: 'google',
    displayName: 'Places API (New) — Place Details Enterprise + Atmosphere',
  },
  {
    id: 'places.autocomplete.requests',
    providerId: 'google',
    displayName: 'Places API (New) — Autocomplete Requests',
  },
  {
    id: 'routes.computeRouteMatrix',
    providerId: 'google',
    displayName: 'Routes API — Compute Route Matrix Essentials',
  },
  { id: 'maps.dynamic.ios', providerId: 'google', displayName: 'Maps SDK for iOS — Dynamic Maps' },
  {
    id: 'maps.dynamic.android',
    providerId: 'google',
    displayName: 'Maps SDK for Android — Dynamic Maps',
  },
];

const GOOGLE: ProviderDefinition = {
  id: 'google',
  displayName: 'Google',
  status: 'active',
  // USAGE_COLLECTOR: the metrics-port ledger (#335). ESTIMATED_COST: pricing
  // rules. BUDGET: the per-scope reservation guard (#335/#340). TEST_RUN_DELTA:
  // the baseline runner (#336). No ACTUAL_COST_COLLECTOR and no QUOTA collector
  // exist yet — the Cloud quota override (INF-015) is an external safety net,
  // not something this process reads.
  capabilities: ['USAGE_COLLECTOR', 'ESTIMATED_COST', 'BUDGET', 'TEST_RUN_DELTA'],
  services: [
    {
      id: PLACES,
      providerId: 'google',
      displayName: 'Places',
      category: 'maps',
      runtime: 'in_process',
      capabilities: ['USAGE_COLLECTOR', 'ESTIMATED_COST', 'BUDGET', 'TEST_RUN_DELTA'],
      // Backstop: an unregistered `google.*` label lands here rather than
      // vanishing. Every other Google service registers a longer prefix.
      operationPrefixes: ['google.'],
      operations: [
        {
          id: 'google.searchText',
          serviceId: PLACES,
          displayName: 'Text Search (IDs only)',
          instrumented: true,
          usageMeters: callMeters('google.searchText', PLACES, 'places.textSearch.idsOnly'),
        },
        {
          /**
           * #505 — the same Text Search, asked for `places.googleMapsUri` so a
           * share link's `ftid` can be matched before any Place Details is
           * bought. That field is a Pro field, so this is a different SKU from
           * `google.searchText` and must be a different operation: one label
           * over a free SKU and a paid one cannot be reconciled to an invoice.
           */
          id: 'google.searchText.identity',
          serviceId: PLACES,
          displayName: 'Text Search (identity)',
          instrumented: true,
          usageMeters: callMeters('google.searchText.identity', PLACES, 'places.textSearch.pro'),
        },
        {
          id: 'google.autocomplete',
          serviceId: PLACES,
          displayName: 'Autocomplete',
          instrumented: true,
          usageMeters: callMeters('google.autocomplete', PLACES, 'places.autocomplete.requests'),
        },
        {
          id: 'google.details.liveness',
          serviceId: PLACES,
          displayName: 'Place Details (liveness, IDs only)',
          instrumented: true,
          usageMeters: callMeters('google.details.liveness', PLACES, 'places.details.idsOnly'),
        },
        {
          id: 'google.details.core',
          serviceId: PLACES,
          displayName: 'Place Details (core)',
          instrumented: true,
          usageMeters: callMeters('google.details.core', PLACES, 'places.details.pro'),
        },
        {
          id: 'google.details.quality',
          serviceId: PLACES,
          displayName: 'Place Details (quality)',
          instrumented: true,
          usageMeters: callMeters('google.details.quality', PLACES, 'places.details.enterprise'),
        },
        {
          id: 'google.details.detail',
          serviceId: PLACES,
          displayName: 'Place Details (detail)',
          instrumented: true,
          usageMeters: callMeters(
            'google.details.detail',
            PLACES,
            'places.details.enterpriseAtmosphere',
          ),
        },
        {
          id: 'google.expand',
          serviceId: PLACES,
          displayName: 'Short-link expansion',
          instrumented: true,
          // An unauthenticated HEAD to maps.app.goo.gl. Not a Google Cloud SKU.
          usageMeters: callMeters('google.expand', PLACES, null),
        },
      ],
    },
    {
      id: ROUTES,
      providerId: 'google',
      displayName: 'Routes',
      category: 'routing',
      runtime: 'in_process',
      capabilities: ['USAGE_COLLECTOR', 'ESTIMATED_COST', 'TEST_RUN_DELTA'],
      operationPrefixes: ['google.routeMatrix', 'routes.'],
      operations: [
        {
          id: 'google.routeMatrix',
          serviceId: ROUTES,
          displayName: 'Compute Route Matrix',
          instrumented: true,
          // Epic §4, live DEV evidence: 12 calls → 50 billable elements. Two
          // meters, and the request count is not the billed quantity.
          usageMeters: [
            {
              id: 'google.routeMatrix/calls',
              metric: 'calls',
              serviceId: ROUTES,
              operationId: 'google.routeMatrix',
              billingSkuId: null,
              unit: 'request',
              billable: false,
            },
            {
              id: 'google.routeMatrix/billable_elements',
              metric: 'billable_elements',
              serviceId: ROUTES,
              operationId: 'google.routeMatrix',
              billingSkuId: 'routes.computeRouteMatrix',
              unit: 'matrix_element',
              billable: true,
            },
          ],
        },
      ],
    },
    {
      id: MAPS_IOS,
      providerId: 'google',
      displayName: 'Maps SDK iOS',
      category: 'maps_sdk',
      // The handset loads the map; this process never sees a call (#387).
      runtime: 'client_sdk',
      // Nothing collected: the SDK renders on the handset (epic §18).
      capabilities: [],
      operationPrefixes: ['google.maps_sdk_ios'],
      operations: [
        {
          id: 'google.maps_sdk_ios',
          serviceId: MAPS_IOS,
          displayName: 'Dynamic map loads (iOS)',
          instrumented: false,
          usageMeters: [
            {
              id: 'google.maps_sdk_ios/map_loads',
              metric: 'map_loads',
              serviceId: MAPS_IOS,
              operationId: 'google.maps_sdk_ios',
              billingSkuId: 'maps.dynamic.ios',
              unit: 'map_load',
              billable: true,
            },
          ],
        },
      ],
    },
    {
      id: MAPS_ANDROID,
      providerId: 'google',
      displayName: 'Maps SDK Android',
      category: 'maps_sdk',
      runtime: 'client_sdk',
      capabilities: [],
      operationPrefixes: ['google.maps_sdk_android'],
      operations: [
        {
          id: 'google.maps_sdk_android',
          serviceId: MAPS_ANDROID,
          displayName: 'Dynamic map loads (Android)',
          instrumented: false,
          usageMeters: [
            {
              id: 'google.maps_sdk_android/map_loads',
              metric: 'map_loads',
              serviceId: MAPS_ANDROID,
              operationId: 'google.maps_sdk_android',
              billingSkuId: 'maps.dynamic.android',
              unit: 'map_load',
              billable: true,
            },
          ],
        },
      ],
    },
    {
      id: SHEETS,
      providerId: 'google',
      displayName: 'Sheets',
      category: 'spreadsheet',
      runtime: 'in_process',
      capabilities: ['USAGE_COLLECTOR', 'ESTIMATED_COST'],
      operationPrefixes: ['google.sheets.'],
      operations: [
        {
          id: 'google.sheets.meta',
          serviceId: SHEETS,
          displayName: 'Spreadsheet metadata',
          instrumented: true,
          usageMeters: callMeters('google.sheets.meta', SHEETS, null),
        },
        {
          id: 'google.sheets.values',
          serviceId: SHEETS,
          displayName: 'Spreadsheet values',
          instrumented: true,
          usageMeters: callMeters('google.sheets.values', SHEETS, null),
        },
      ],
    },
    {
      // Epic §3: "Google Play Console" is a manual/fixed platform fee — the
      // one Google service a manual cost item may name (#382).
      id: google('play_console'),
      providerId: 'google',
      displayName: 'Play Console',
      category: 'platform_fee',
      runtime: 'none',
      capabilities: ['MANUAL_COST'],
      operations: [],
    },
  ],
};

/**
 * COST-BE-024 (#383) — Cloudflare, the first provider after Google with a
 * collector. Ids are GoGo's; display names are the pricing page's (fetched
 * 2026-09-03).
 */
const CLOUDFLARE_SKUS: readonly BillingSkuDefinition[] = [
  { id: 'r2.class_a', providerId: 'cloudflare', displayName: 'R2 — Class A operations' },
  { id: 'r2.class_b', providerId: 'cloudflare', displayName: 'R2 — Class B operations' },
  { id: 'r2.storage', providerId: 'cloudflare', displayName: 'R2 — Standard storage' },
  { id: 'workers.requests', providerId: 'cloudflare', displayName: 'Workers — Requests' },
];

const R2 = 'cloudflare.r2';
const WORKERS = 'cloudflare.workers';

function billedServiceMeter(
  serviceId: string,
  metric: string,
  unit: MeterUnit,
  billingSkuId: string,
): UsageMeterDefinition {
  return { ...serviceMeter(serviceId, metric, unit), billingSkuId, billable: true };
}

/**
 * Two services, service-level meters only: R2 and Workers have no
 * per-operation instrumentation in this process — the GraphQL Analytics
 * collector (`cloudflare_api`, #383) reads the day's totals from Cloudflare.
 *
 * A `gb_month` meter is sampled daily: a row's quantity is that day's peak
 * decimal GB, and the month's GB-month is the mean of its days, which is
 * how Cloudflare itself bills R2 storage ("averaging the peak storage per
 * day over a billing period"). `PER_GB_MONTH` pricing prorates accordingly.
 *
 * Declared but not collected, deliberately (epic §44.8 — no extrapolation):
 * `egress_gb` (R2 egress is free and the dataset exposes no egress bytes) and
 * `cpu_ms` (the dataset sums requests but only offers CPU-time quantiles).
 * Both stay non-billable until a source exists.
 */
const CLOUDFLARE: ProviderDefinition = {
  id: 'cloudflare',
  displayName: 'Cloudflare',
  status: 'active',
  capabilities: ['USAGE_COLLECTOR', 'ESTIMATED_COST'],
  services: [
    {
      id: R2,
      providerId: 'cloudflare',
      displayName: 'R2',
      category: 'object_storage',
      // #414 — `r2-storage.adapter.ts` only *signs* an upload URL (SigV4, in
      // memory); the bytes go from the client straight to R2 and no request
      // leaves this process. Nothing here to time, so no runtime — the same
      // reading as Workers. If a server-side GET/HEAD/DELETE ever lands, this
      // becomes `in_process` with that operation declared, not a coverage rule.
      runtime: 'none',
      capabilities: ['USAGE_COLLECTOR', 'ESTIMATED_COST'],
      operations: [],
      meters: [
        billedServiceMeter(R2, 'class_a', 'operation', 'r2.class_a'),
        billedServiceMeter(R2, 'class_b', 'operation', 'r2.class_b'),
        billedServiceMeter(R2, 'storage_gb_month', 'gb_month', 'r2.storage'),
        serviceMeter(R2, 'egress_gb', 'gb'),
      ],
    },
    {
      id: WORKERS,
      providerId: 'cloudflare',
      displayName: 'Workers',
      category: 'edge_compute',
      // Nothing in this process calls a Worker; its runtime is Cloudflare's to report.
      runtime: 'none',
      capabilities: ['USAGE_COLLECTOR', 'ESTIMATED_COST'],
      operations: [],
      meters: [
        billedServiceMeter(WORKERS, 'requests', 'request', 'workers.requests'),
        serviceMeter(WORKERS, 'cpu_ms', 'millisecond'),
      ],
    },
  ],
};

/**
 * COST-BE-025 (#384) — Upstash, the second provider with a collector. Ids
 * are GoGo's; the display name is the pricing page's (fetched 2026-09-03).
 */
const UPSTASH_SKUS: readonly BillingSkuDefinition[] = [
  { id: 'redis.commands', providerId: 'upstash', displayName: 'Redis — Commands' },
];

const UPSTASH_REDIS = 'upstash.redis';

/**
 * One service, service-level meters only: this process instruments no
 * per-command path — the Developer API collector (`upstash_api`, #384)
 * reads the day's totals from Upstash.
 *
 * `commands` is billed (pay-as-you-go per 100K, 500K/month free).
 * `storage_bytes` and `bandwidth_bytes` are collected but non-billable:
 * Upstash prices both per GB beyond a free tier, and a byte meter is priced
 * by a GB rule only once one exists with an explicit conversion — never by
 * assumption (epic §44.23).
 */
const UPSTASH: ProviderDefinition = {
  id: 'upstash',
  displayName: 'Upstash',
  status: 'active',
  capabilities: ['USAGE_COLLECTOR', 'ESTIMATED_COST'],
  services: [
    {
      id: UPSTASH_REDIS,
      providerId: 'upstash',
      displayName: 'Redis',
      category: 'cache',
      // #414 — rate-limit store, session revocation and the room event bus,
      // each timed as one operation (see `runtime-operations.ts`). No usage
      // meter on any of them: the command count Upstash bills is the
      // collector's to read, not this process's to count (epic §8).
      runtime: 'in_process',
      capabilities: ['USAGE_COLLECTOR', 'ESTIMATED_COST'],
      operations: [
        runtimeOperation(UPSTASH_REDIS_OPERATIONS.rateLimitHit, 'Rate limit hit (INCR/EXPIRE)'),
        runtimeOperation(UPSTASH_REDIS_OPERATIONS.sessionRevoke, 'Session revoke (SET EX)'),
        runtimeOperation(UPSTASH_REDIS_OPERATIONS.sessionIsRevoked, 'Session revoked? (GET)'),
        runtimeOperation(
          UPSTASH_REDIS_OPERATIONS.roomEventsPublish,
          'Room event publish (ZADD/PUBLISH)',
        ),
        runtimeOperation(
          UPSTASH_REDIS_OPERATIONS.roomEventsSubscribe,
          'Room event subscribe (ZRANGEBYSCORE/SUBSCRIBE)',
        ),
        runtimeOperation(
          UPSTASH_REDIS_OPERATIONS.rateLimitConnect,
          'Rate limit connect (API boot)',
          { bootstrap: true },
        ),
      ],
      meters: [
        billedServiceMeter(UPSTASH_REDIS, 'commands', 'command', 'redis.commands'),
        serviceMeter(UPSTASH_REDIS, 'storage_bytes', 'byte'),
        serviceMeter(UPSTASH_REDIS, 'bandwidth_bytes', 'byte'),
      ],
    },
  ],
};

/**
 * COST-BE-026 (#385) — Neon, the third provider with a collector. Ids are
 * GoGo's; display names follow the pricing page (fetched 2026-09-03).
 */
const NEON_SKUS: readonly BillingSkuDefinition[] = [
  { id: 'postgres.compute', providerId: 'neon', displayName: 'Postgres — Compute (CU-hours)' },
  { id: 'postgres.storage', providerId: 'neon', displayName: 'Postgres — Storage (GB-month)' },
  {
    id: 'postgres.data_transfer',
    providerId: 'neon',
    displayName: 'Postgres — Public network transfer',
  },
];

const NEON_POSTGRES = 'neon.postgres';

/**
 * One service, service-level meters only: the Neon API collector
 * (`neon_api`, #385) reads the project's totals — daily from the history
 * endpoint on usage-based plans, as period-to-date deltas from the project
 * endpoint on the Free plan `gogo-dev` is on.
 *
 * `compute_hours` (CU-hours), `storage_gb_month` (day's peak decimal GB,
 * prorated like R2) and `data_transfer_gb` are billed on usage-based plans and
 * capped on Free (100 CU-hours, 0.5 GB, 5 GB per project per month).
 * `written_data_gb` is collected and non-billable — Neon's page prices no
 * written-data line on today's plans. `storage_bytes` is the exact gauge the
 * GB-month row is rounded from, kept because a whole-GB meter says nothing
 * useful about a 0.5 GB allowance.
 */
const NEON: ProviderDefinition = {
  id: 'neon',
  displayName: 'Neon',
  status: 'active',
  capabilities: ['USAGE_COLLECTOR', 'ESTIMATED_COST'],
  services: [
    {
      id: NEON_POSTGRES,
      providerId: 'neon',
      displayName: 'Postgres',
      category: 'database',
      // #414 — every statement the pool runs, timed from the checked-out
      // client (`@gogo/database` `createDb({ runtime })`). Compute hours are
      // Neon's meter, read by its collector; this is how long our queries take.
      runtime: 'in_process',
      capabilities: ['USAGE_COLLECTOR', 'ESTIMATED_COST'],
      operations: [runtimeOperation(NEON_POSTGRES_OPERATIONS.query, 'Query')],
      meters: [
        billedServiceMeter(NEON_POSTGRES, 'compute_hours', 'compute_hour', 'postgres.compute'),
        billedServiceMeter(NEON_POSTGRES, 'storage_gb_month', 'gb_month', 'postgres.storage'),
        billedServiceMeter(NEON_POSTGRES, 'data_transfer_gb', 'gb', 'postgres.data_transfer'),
        serviceMeter(NEON_POSTGRES, 'written_data_gb', 'gb'),
        serviceMeter(NEON_POSTGRES, 'storage_bytes', 'byte'),
      ],
    },
  ],
};

/**
 * COST-BE-027 (#386) — GitHub, whose Actions minutes are both metered and
 * billed. One SKU; the OS decides the price, so the meter is minutes and the
 * per-SKU split rides in the row's metadata.
 */
const GITHUB_SKUS: readonly BillingSkuDefinition[] = [
  { id: 'actions.minutes', providerId: 'github', displayName: 'Actions — Minutes' },
];

const GITHUB_ACTIONS = 'github.actions';

/**
 * COST-BE-027 (#386) — AWS, the first provider read as an **actual bill**
 * rather than measured and priced. Cost Explorer reports money per day per
 * AWS service; there is no usage meter and no pricing rule, which is why
 * `aws` declares `ACTUAL_COST_COLLECTOR` and neither `USAGE_COLLECTOR` nor
 * `ESTIMATED_COST`. Both services keep their declared, uncollected meters:
 * nothing writes them, so they stay non-billable (epic §44.8).
 */
const AWS: ProviderDefinition = {
  id: 'aws',
  displayName: 'AWS',
  status: 'active',
  capabilities: ['ACTUAL_COST_COLLECTOR'],
  services: [
    {
      id: 'aws.aggregate_billing',
      providerId: 'aws',
      displayName: 'Aggregate billing',
      category: 'billing',
      runtime: 'none',
      capabilities: ['ACTUAL_COST_COLLECTOR'],
      operations: [],
      meters: [serviceMeter('aws.aggregate_billing', 'billed_usd_micros', 'usd_micros')],
    },
    {
      id: 'aws.ssm',
      providerId: 'aws',
      displayName: 'Systems Manager',
      category: 'secrets',
      // Secrets are read at deploy time, not on a request path.
      runtime: 'none',
      capabilities: ['ACTUAL_COST_COLLECTOR'],
      operations: [],
      meters: [serviceMeter('aws.ssm', 'api_requests', 'request')],
    },
  ],
};

/**
 * GitHub is read three ways at once, from one endpoint: the billing usage
 * report carries the day's minutes (USAGE_COLLECTOR), the pricing rule turns
 * them into an estimate (ESTIMATED_COST), and the same lines carry GitHub's
 * own `netAmount` (ACTUAL_COST_COLLECTOR). Epic §12 keeps the actual ahead of
 * the estimate rather than adding them.
 */
const GITHUB: ProviderDefinition = {
  id: 'github',
  displayName: 'GitHub',
  status: 'active',
  capabilities: ['USAGE_COLLECTOR', 'ESTIMATED_COST', 'ACTUAL_COST_COLLECTOR'],
  services: [
    {
      id: GITHUB_ACTIONS,
      providerId: 'github',
      displayName: 'Actions',
      category: 'ci',
      runtime: 'none',
      capabilities: ['USAGE_COLLECTOR', 'ESTIMATED_COST', 'ACTUAL_COST_COLLECTOR'],
      operations: [],
      meters: [billedServiceMeter(GITHUB_ACTIONS, 'minutes', 'minute', 'actions.minutes')],
    },
    {
      // COST-BE-040 (#563): the GitHub plan — seats, Copilot — is a fee
      // somebody types in. MANUAL_COST of its own under an AUTO provider,
      // the Play Console pattern (#382): the provider declares nothing
      // manual, so `github.actions` still refuses a manual item. No meter:
      // nothing counts a seat.
      id: 'github.subscription',
      providerId: 'github',
      displayName: 'Subscription (plan, Copilot)',
      category: 'platform_fee',
      runtime: 'none',
      capabilities: ['MANUAL_COST'],
      operations: [],
    },
  ],
};

function serviceMeter(serviceId: string, metric: string, unit: MeterUnit): UsageMeterDefinition {
  return {
    id: `${serviceId}/${metric}`,
    metric,
    serviceId,
    operationId: null,
    billingSkuId: null,
    unit,
    billable: false,
  };
}

/** Epic §3 P0/P1 inventory. Planned = named, nothing collected yet. */
function planned(
  id: string,
  displayName: string,
  services: {
    name: string;
    displayName: string;
    category: ServiceCategory;
    meters: [string, MeterUnit][];
  }[],
  billingTimezone?: string,
): ProviderDefinition {
  return {
    id,
    displayName,
    status: 'planned',
    capabilities: [],
    ...(billingTimezone ? { billingTimezone } : {}),
    services: services.map((s) => ({
      id: `${id}.${s.name}`,
      providerId: id,
      displayName: s.displayName,
      category: s.category,
      runtime: 'none',
      capabilities: [],
      operations: [],
      meters: s.meters.map(([metric, unit]) => serviceMeter(`${id}.${s.name}`, metric, unit)),
    })),
  };
}

/**
 * A provider that only ever costs what somebody types in (epic §27): the
 * provider and each of its services declare `MANUAL_COST`, and nothing else,
 * so the Cost Center's manual-item form finds them by asking the registry
 * (`servicesWith('MANUAL_COST')`) and never by a status or id literal. No
 * runtime either: a fee has no request path. `category` is `platform_fee`,
 * the fee case, unless the provider is work rather than a fee (#563).
 */
function manual(
  id: string,
  displayName: string,
  services: { name: string; displayName: string }[],
  category: ServiceCategory = 'platform_fee',
): ProviderDefinition {
  return {
    id,
    displayName,
    // Integrated — the manual-item form (#382) is the implementation of
    // MANUAL_COST. "How the money gets in" is the capability, not the status.
    status: 'active',
    capabilities: ['MANUAL_COST'],
    services: services.map((s) => ({
      id: `${id}.${s.name}`,
      providerId: id,
      displayName: s.displayName,
      category,
      runtime: 'none',
      capabilities: ['MANUAL_COST'],
      operations: [],
    })),
  };
}

export const COST_REGISTRY_DATA: RegistryData = {
  billingSkus: [...GOOGLE_SKUS, ...CLOUDFLARE_SKUS, ...UPSTASH_SKUS, ...NEON_SKUS, ...GITHUB_SKUS],
  providers: [
    GOOGLE,
    CLOUDFLARE,
    UPSTASH,
    NEON,
    AWS,
    GITHUB,
    {
      // Epic §21: the cost of tracking cost, as a first-class provider. Its
      // one FIXED_COST row per day is written by the collector scheduler from
      // the declared monitoring cost of every enabled collector (#369).
      id: 'gogo',
      displayName: 'GoGo (internal)',
      status: 'active',
      capabilities: ['FIXED_COST'],
      services: [
        {
          id: 'gogo.cost_observability',
          providerId: 'gogo',
          displayName: 'Cost observability',
          category: 'internal',
          runtime: 'none',
          capabilities: ['FIXED_COST'],
          operations: [],
          meters: [
            serviceMeter('gogo.cost_observability', 'collector_runs', 'run'),
            serviceMeter('gogo.cost_observability', 'monitoring_usd_micros', 'usd_micros'),
          ],
        },
      ],
    },
    /**
     * COST-BE-031 (#517) — `planned` for cost, measured at runtime.
     *
     * Both halves matter and they are not the same half. OneSignal's cost is
     * not collected: no collector, no SKU, #389 still open — so the status
     * stays `planned` and the Cost Center still says "chưa nối", which about
     * money is true.
     *
     * But `planned()` also stamps `runtime: 'none'` on every service, and that
     * was false. `OneSignalPushAdapter` runs in the API and the worker and
     * emits `push_provider_requests_total` and
     * `push_provider_request_duration_seconds` on every send, so the push
     * service is `in_process` and instrumented — runtime coverage FULL. It was
     * reported as N/A, i.e. "nobody calls this", while it was the only thing
     * standing between a campaign and a phone.
     *
     * Spelled out rather than built by `planned()` for exactly that reason: the
     * helper's `runtime: 'none'` is an assumption about the deployment, and it
     * does not hold here. Nothing below invents a price.
     */
    {
      id: 'onesignal',
      displayName: 'OneSignal',
      status: 'planned',
      capabilities: [],
      services: [
        {
          id: 'onesignal.push',
          providerId: 'onesignal',
          displayName: 'Push',
          category: 'push',
          runtime: 'in_process',
          capabilities: [],
          operations: [
            {
              /**
               * The registry's name for the send. It is **not** a label value:
               * the adapter's series is `push_provider_requests_total{status}`,
               * not `provider_requests_total{operation=...}`, because
               * `libs/providers` depends on no `@gogo/*` package and so cannot
               * use `recordRuntimeCall`. Same shape as Google, which is
               * measured on `places_provider_requests_total{method}`. Do not
               * write a query against an `operation` label here.
               */
              id: 'onesignal.push.create',
              serviceId: 'onesignal.push',
              displayName: 'Create notification',
              instrumented: true,
              /** No usage meter: the send is measured, the money is not. */
              usageMeters: [],
            },
          ],
          meters: [
            serviceMeter('onesignal.push', 'notifications', 'notification'),
            serviceMeter('onesignal.push', 'subscribed_users', 'active_user'),
          ],
        },
      ],
    },
    planned('tenjin', 'Tenjin', [
      {
        name: 'attribution',
        displayName: 'Attribution',
        category: 'attribution',
        meters: [['conversions', 'conversion']],
      },
    ]),
    planned('grafana', 'Grafana Cloud', [
      {
        name: 'metrics',
        displayName: 'Metrics',
        category: 'observability',
        meters: [['active_series', 'series']],
      },
    ]),
    planned('sentry', 'Sentry', [
      { name: 'errors', displayName: 'Errors', category: 'errors', meters: [['events', 'event']] },
    ]),
    manual('apple', 'Apple', [{ name: 'developer_program', displayName: 'Developer Program' }]),
    manual('hosting', 'Hosting', [{ name: 'vps', displayName: 'VPS subscription' }]),
    manual('registrar', 'Domain registrar', [
      { name: 'domain', displayName: 'Domain registration' },
    ]),
    /**
     * COST-BE-040 (#563) — what running GoGo costs in people and tools,
     * entered by hand: development, bug fixing, and the dev tooling that
     * has no provider of its own here (an IDE seat, an AI assistant, a
     * design tool). Its own category, `operations`: neither a platform fee
     * nor `internal` — `internal` is the cost of monitoring (§21) and
     * `costOfMonitoring` sums it. A GitHub plan is not here; it is GitHub's
     * fee, `github.subscription`.
     */
    manual(
      'operations',
      'Operations',
      [
        { name: 'development', displayName: 'Development — Code' },
        { name: 'bugfix', displayName: 'Fixbug / maintenance' },
        { name: 'tooling', displayName: 'Dev tooling & subscriptions' },
      ],
      'operations',
    ),
  ],
};

export const COST_REGISTRY = new CostRegistry(COST_REGISTRY_DATA);

/** Guard for tests and boot: every capability string in the data is real. */
export function assertCapabilitiesKnown(data: RegistryData): void {
  for (const provider of data.providers) {
    for (const cap of [
      ...provider.capabilities,
      ...provider.services.flatMap((s) => s.capabilities),
    ]) {
      if (!(CAPABILITIES as readonly string[]).includes(cap)) {
        throw new RegistryError(`unknown capability ${cap} on ${provider.id}`);
      }
    }
  }
}

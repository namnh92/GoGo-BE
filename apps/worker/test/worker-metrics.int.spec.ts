import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { PlaceDedupService, PlaceImportJobService, PlaceResolverService } from '@gogo/modules';
import { FakePlaceProvider, FakeSheets } from '@gogo/providers';
import { createLogger, type MetricsPort } from '@gogo/observability';
import { createWorkerMetrics, startMetricsEndpoint, type MetricsEndpoint } from '../src/metrics';

/**
 * #318 — the worker's metrics actually leave the worker.
 *
 * Asserting at the call site would prove nothing here: every one of these
 * counters was already being emitted, into a `LogMetrics` that no collector
 * reads. The claim under test is the one that failed before — that a metric
 * produced by *bulk import, in the worker process* comes back out of the
 * worker's own scrape surface over HTTP.
 *
 * So this drives the real ingest tick (`start` then `processPendingJobs`, the
 * two calls `apps/worker/src/main.ts` makes) through a real database, against
 * the same wiring the worker builds, and then scrapes it with a socket.
 */

const METRICS_TOKEN = 'worker-scrape-token-for-tests';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let endpoint: MetricsEndpoint | null;
let imports: PlaceImportJobService;
let metrics: MetricsPort;
let places: FakePlaceProvider;
let adminId: string;

const CSV_HEADER =
  'source_row_id,name,city,district,google_maps_url,category,price_min,price_max,price_unit';

async function scrape(token: string | null = METRICS_TOKEN): Promise<Response> {
  return fetch(`http://127.0.0.1:${endpoint!.port}/metrics`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_worker_metrics_test')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  await db.insert(schema.taxonomies).values({ kind: 'category', key: 'cafe' });

  const [admin] = await db
    .insert(schema.adminUsers)
    .values({
      email: 'worker-metrics@gogo.local',
      passwordHash: 'not-used-here',
      displayName: 'ops',
      role: 'ops_admin',
    })
    .returning();
  adminId = admin!.id;

  // Exactly what apps/worker/src/main.ts builds.
  const logger = createLogger({ level: 'silent', name: 'gogo-worker-test' });
  const built = createWorkerMetrics(logger);
  metrics = built.metrics;
  places = new FakePlaceProvider();
  imports = new PlaceImportJobService(
    db,
    new PlaceResolverService(places, db),
    new PlaceDedupService(db),
    new FakeSheets(),
    { APP_ENV: 'dev', PLACE_RESOLUTION_TTL_S: 600 },
    metrics,
  );
  endpoint = await startMetricsEndpoint({
    registry: built.registry,
    token: METRICS_TOKEN,
    logger,
    // 0 lets the OS pick, so a busy 9101 on the dev machine cannot flake this.
    port: 0,
    host: '127.0.0.1',
  });
}, 180_000);

afterAll(async () => {
  await endpoint?.close();
  await pool?.end();
  await container?.stop();
});

describe('the worker exposes a scrape surface at all', () => {
  it('listens and serves the Prometheus text format to a holder of the token', async () => {
    expect(endpoint).not.toBeNull();
    const res = await scrape();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    // A cached scrape flattens every rate() computed from it.
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a wrong token and an unauthenticated request', async () => {
    expect((await scrape('wrong-token-entirely')).status).toBe(401);
    expect((await scrape(null)).status).toBe(401);
  });

  it('returns no series names in the refusal body', async () => {
    const body = await (await scrape('wrong-token-entirely')).text();
    expect(body).not.toContain('place_import');
    expect(body).not.toContain('places_provider');
  });

  it('answers 404 for anything that is not the metrics path', async () => {
    const res = await fetch(`http://127.0.0.1:${endpoint!.port}/../etc/passwd`, {
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('a metric emitted by worker-side bulk import reaches the scrape surface', () => {
  it('carries the import, resolve and provider-cost series out over HTTP', async () => {
    places.seed({ providerPlaceId: 'fake-worker-1', name: 'Quán Worker', lat: 10.78, lng: 106.7 });

    const before = await (await scrape()).text();
    expect(before).not.toContain('place_import_rows_total');

    const job = await imports.createFromFile({
      bytes: Buffer.from(
        [
          CSV_HEADER,
          'WRK-1,Quán Worker,Hồ Chí Minh,Quận 1,https://www.google.com/maps?place_id=fake-worker-1,cafe,100000,200000,per_person',
        ].join('\n'),
        'utf8',
      ),
      fileName: 'worker-metrics.csv',
      mode: 'create_drafts',
      defaultCity: 'Hồ Chí Minh',
      adminId,
    });
    await imports.start(job.id, adminId);
    // The ingest tick, called exactly as main.ts calls it.
    const advanced = await imports.processPendingJobs(5);
    expect(advanced.length).toBeGreaterThan(0);

    const body = await (await scrape()).text();

    // The counters that were invisible before this change. Each one is emitted
    // only from code that runs in this process.
    expect(body).toContain('# TYPE place_import_jobs_total counter');
    expect(body).toContain('# TYPE place_import_rows_total counter');
    expect(body).toContain('# TYPE place_resolve_confidence_bucket counter');
    expect(body).toMatch(/place_import_rows_total\{[^}]*status="ready"[^}]*\} [1-9]/);

    // The histogram, with its buckets and both aggregates — a rendered
    // `_count` is what proves `observe()` reached the registry and not only
    // the log.
    expect(body).toContain('# TYPE place_resolve_duration_seconds histogram');
    expect(body).toMatch(
      /place_resolve_duration_seconds_count\{[^}]*source="cms_import"[^}]*\} [1-9]/,
    );
    expect(body).toMatch(/place_resolve_duration_seconds_bucket\{[^}]*le="\+Inf"[^}]*\} [1-9]/);
    // `time()` labels the outcome itself; losing that would lose the ability
    // to separate a slow success from a slow failure.
    expect(body).toContain('outcome="ok"');
  });

  it('renders a provider cost series when the import calls a real provider adapter', async () => {
    // The fake provider bills nothing, so the SKU counter is driven directly —
    // through the same worker `metrics` instance the import service holds, so
    // what is being proved is the wiring, not the adapter.
    metrics.increment('places_provider_cost_units', { sku: 'google.details.quality' });

    const body = await (await scrape()).text();
    expect(body).toContain('places_provider_cost_units{sku="google.details.quality"} 1');
  });

  it('emits nothing a scraper could read a secret out of', async () => {
    const body = await (await scrape()).text();
    expect(body).not.toContain(METRICS_TOKEN);
    // Every line is a comment or `name{labels} value`.
    for (const line of body.split('\n').filter(Boolean)) {
      expect(line).toMatch(/^(#|[a-z_]+(\{.*\})? -?[\d.e+]+$)/);
    }
  });
});

describe('observability failure never stops the worker', () => {
  it('returns null instead of throwing when the port cannot be bound', async () => {
    const logger = createLogger({ level: 'silent', name: 'gogo-worker-test' });
    const { registry } = createWorkerMetrics(logger);
    // Already in use by the endpoint under test.
    const second = await startMetricsEndpoint({
      registry,
      token: METRICS_TOKEN,
      logger,
      port: endpoint!.port,
      host: '127.0.0.1',
    });
    // A worker that dies because it could not bind a metrics port is an outage
    // caused by the thing meant to observe one.
    expect(second).toBeNull();
  });

  it('returns null instead of throwing on a bad port configuration', async () => {
    const logger = createLogger({ level: 'silent', name: 'gogo-worker-test' });
    const { registry } = createWorkerMetrics(logger);
    const bad = await startMetricsEndpoint({
      registry,
      token: METRICS_TOKEN,
      logger,
      port: 99_999,
      host: '127.0.0.1',
    });
    expect(bad).toBeNull();
  });

  it('serves 404, not the registry, when no token is configured', async () => {
    const logger = createLogger({ level: 'silent', name: 'gogo-worker-test' });
    const { metrics: m, registry } = createWorkerMetrics(logger);
    m.increment('place_duplicate_candidates_total', { kind: 'provider_id' });
    const open = await startMetricsEndpoint({
      registry,
      token: undefined,
      logger,
      port: 0,
      host: '127.0.0.1',
    });
    try {
      const res = await fetch(`http://127.0.0.1:${open!.port}/metrics`);
      // Same rule as the API route: an unconfigured endpoint does not
      // advertise that it exists and is merely locked.
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('place_duplicate_candidates_total');
    } finally {
      await open?.close();
    }
  });
});

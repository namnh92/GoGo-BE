import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import {
  COST_USAGE_LEDGER,
  PlaceImportJobService,
  utcDay,
  type DbUsageLedger,
} from '@gogo/modules';
import type { MetricsRegistry } from '@gogo/observability';
import { METRICS_REGISTRY } from '../src/metrics.tokens';
import type { BaselineArtifact } from '../../../scripts/cost-baseline/artifact';
import { compareBaselines, formatComparison } from '../../../scripts/cost-baseline/compare';
import { injectTarget } from '../../../scripts/cost-baseline/http-target';
import { parseMetricsText } from '../../../scripts/cost-baseline/metrics-text';
import { runBaseline } from '../../../scripts/cost-baseline/runner';
import { loadFixtures } from '../../../scripts/cost-baseline/scenarios';
import {
  FIXTURES_DIR,
  installGoogleStub,
  loadCatalog,
} from '../../../scripts/cost-baseline/stub-google';

/**
 * PR3 / COST-BE-003 (#336) — the frozen BEFORE baseline.
 *
 * This is the deterministic half of the plan's §4 matrix, and it is a spec
 * rather than a CLI on purpose: the Postgres, the migrations and the app boot
 * already live here, and a second harness in `scripts/` would be a second
 * thing to keep in step with the first.
 *
 * What is real: the `GooglePlacesAdapter`, its field masks, `withResilience`,
 * the resolver, the submission service, the bulk import pipeline, the metrics
 * port, the tee, `DbUsageLedger`, `provider_usage_daily` and the pricing
 * registry. What is pinned: the bytes coming back over HTTP.
 *
 * So the artifact's **call counts are the real thing** — how many requests of
 * which operation each product flow makes, which is exactly what PR4
 * (same-execution reuse, DB-first) and PR5 (tier by need) are going to change.
 * Its latency and error rate are not; they measure this machine, and the
 * artifact says so in `limitations`.
 *
 * The committed artifact is a golden file. When PR4 landed and these flows
 * stopped calling Google twice, this spec failed — deliberately — and was
 * re-frozen as a decision with a diff and a reviewer:
 *
 *   COST_BASELINE_WRITE=1 pnpm vitest run --project integration cost-baseline
 *
 * PR5 and PR7 will fail it again, for the same good reason.
 *
 * Two consecutive runs inside one boot are also compared, which is the plan's
 * own acceptance criterion ("agree within ±1 call per operation") — asserted
 * rather than declared.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let ledger: DbUsageLedger;
let registry: MetricsRegistry;
let imports: PlaceImportJobService;
let stub: ReturnType<typeof installGoogleStub>;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.91.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;

/**
 * The golden this spec holds current behaviour to, and the BEFORE freeze it
 * must never overwrite.
 *
 * Both are named by the **UTC** day, because that is the day
 * `provider_usage_daily` is keyed by — a local calendar date would put a run
 * and the ledger rows it describes under two different dates for seven hours of
 * every day in ICT.
 *
 * PR4 moved the numbers on purpose, so the golden moves with it. What does not
 * move is `BEFORE_FREEZE`: PR9 (#342) owes a BEFORE/AFTER/DELTA table, and a
 * BEFORE column reconstructed from git history is not evidence anybody will
 * check. Re-freezing means *adding* a file and pointing `ARTIFACT` at it, never
 * rewriting the one that recorded what the flows used to cost.
 */
const ARTIFACT = path.resolve(
  __dirname,
  '../../../docs/cost-baselines/2026-09-02-after-pr4-stub.json',
);
const BEFORE_FREEZE = path.resolve(
  __dirname,
  '../../../docs/cost-baselines/2026-09-01-before-stub.json',
);
const ENVIRONMENT = 'dev';

async function register(email: string): Promise<string> {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName: 'Baseline' },
  });
  return res.json().accessToken as string;
}

async function createAdmin(email: string, role: 'moderator' | 'editor' | 'ops_admin') {
  const argon2 = (await import('argon2')).default;
  await db.insert(schema.adminUsers).values({
    email,
    passwordHash: await argon2.hash('admin-password-123', { type: argon2.argon2id }),
    displayName: 'Baseline admin',
    role,
  });
  const login = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  return login.json().accessToken as string;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_baseline_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.APP_ENV = ENVIRONMENT;
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  // The real adapter, deliberately. `fake` would measure the fake's call
  // shape, and the fake emits no provider counters at all — the ledger would
  // read zero for every operation and the baseline would be a page of zeroes.
  process.env.PLACE_PROVIDER_MODE = 'google';
  process.env.GOOGLE_PLACES_API_KEY = 'baseline-stub-key-not-a-credential';
  process.env.COST_LEDGER_ENABLED = 'true';
  // Flushes are awaited by the runner, so the interval only bounds what a
  // SIGKILL would lose. Short here so nothing lingers between scenarios.
  process.env.COST_LEDGER_FLUSH_MS = '250';
  // #337 — without a secret no attestation is issued, scenario D's submit falls
  // back to a second Details call, and the baseline would freeze the cost of a
  // feature that is switched off rather than the cost of the product.
  process.env.PLACE_RESOLUTION_ATTESTATION_SECRET = 'cost-baseline-stub-attestation-secret';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  for (const key of ['cafe', 'restaurant']) {
    await db.insert(schema.taxonomies).values({ kind: 'category', key });
  }
  await db.insert(schema.serviceAreas).values({
    key: 'hcm_q1',
    name: 'Quận 1, TP.HCM',
    centerLat: 10.7769,
    centerLng: 106.7009,
    radiusM: 8000,
  });

  stub = installGoogleStub(loadCatalog());

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  ledger = app.get(COST_USAGE_LEDGER);
  registry = app.get(METRICS_REGISTRY);
  imports = app.get(PlaceImportJobService);
}, 240_000);

afterAll(async () => {
  stub?.restore();
  await app?.close();
  await pool?.end();
  await container?.stop();
});

/**
 * Put the five catalogued places into the catalog through the product's own
 * path — resolve, submit, approve — rather than by inserting rows.
 *
 * A hand-written insert would be a place with no canonical provider row, and
 * scenario C exists to measure what happens when a Google id GoGo *already
 * knows* is imported again. Faking the setup would fake the very state under
 * measurement.
 *
 * Runs before the first snapshot, so its own provider calls are outside every
 * scenario's window.
 */
async function seedCatalogue(actors: { user: string; moderator: string }): Promise<void> {
  const fixtures = loadFixtures();
  for (const seed of fixtures.seededCatalog) {
    const resolved = await api().inject({
      method: 'POST',
      url: '/v1/places/resolve-google-maps-link',
      remoteAddress: ip(),
      payload: { url: `https://www.google.com/maps?place_id=${seed.providerPlaceId}` },
    });
    expect(resolved.statusCode, JSON.stringify(resolved.json())).toBe(201);

    const submitted = await api().inject({
      method: 'POST',
      url: '/v1/place-submissions',
      remoteAddress: ip(),
      headers: { authorization: `Bearer ${actors.user}` },
      payload: { googlePlaceId: seed.providerPlaceId, category: seed.category },
    });
    expect(submitted.statusCode, JSON.stringify(submitted.json())).toBe(201);

    const decided = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-submissions/${submitted.json().submissionId}/decide`,
      remoteAddress: ip(),
      headers: { authorization: `Bearer ${actors.moderator}` },
      payload: { decision: 'approved', reason: 'baseline catalogue seed' },
    });
    expect(decided.statusCode, JSON.stringify(decided.json())).toBe(201);
  }

  // Approval writes `community_submitted`; scenario A searches the published
  // catalog. Promoting here is a GoGo status change, not provider content.
  await db.execute(
    sql`update places set status = 'published' where status = 'community_submitted'`,
  );
}

/**
 * Put the catalog back where `seedCatalogue` left it.
 *
 * Scenarios D and E create places; a second run against their leftovers would
 * find every "new" place already imported and take a completely different —
 * and much cheaper — path. "Two consecutive runs agree within ±1" is a claim
 * about the same preconditions twice, so the preconditions are restored rather
 * than hoped for.
 *
 * The ledger is deliberately *not* reset: the runner diffs it per scenario, so
 * yesterday's counts in the row cannot reach today's numbers.
 */
async function resetCatalogue(actors: { user: string; moderator: string }): Promise<void> {
  await db.execute(sql`
    truncate table
      places, place_provider_sources, place_submissions,
      place_ingest_jobs, place_ingest_rows, place_identity_conflicts
    restart identity cascade
  `);
  await seedCatalogue(actors);
}

describe('#336 — frozen baseline, re-frozen by #337', () => {
  it('freezes the pinned A–E scenarios, per operation, and repeats within ±1', async () => {
    const user = await register('baseline-user@gogo.local');
    const moderator = await createAdmin('baseline-mod@gogo.local', 'moderator');
    const ops = await createAdmin('baseline-ops@gogo.local', 'ops_admin');
    await seedCatalogue({ user, moderator });

    const options = {
      transport: 'stub' as const,
      environment: ENVIRONMENT,
      providerMode: 'google' as const,
      query: async (text: string, params: readonly unknown[]) =>
        (await pool.query(text, params as unknown[])).rows as Record<string, unknown>[],
      http: injectTarget(api()),
      actors: { user, moderator, ops },
      fixtures: loadFixtures(),
      fixturesDir: FIXTURES_DIR,
      // `drain`, not `flush`: a single flush joins one already in flight and
      // leaves anything buffered since it started unwritten (#336). A snapshot
      // taken over that gap reports a scenario's calls against the next
      // scenario's window.
      flush: () => ledger.drain(),
      // The deployed worker polls; here it is called directly, in the same
      // process, so its provider calls reach the same ledger and the same
      // scrape. Bounded so a job that refuses to finish fails the run instead
      // of hanging it.
      advanceWorker: async () => {
        for (let tick = 0; tick < 40; tick += 1) {
          const advanced = await imports.processPendingJobs(5);
          if (advanced.length === 0) return;
        }
        throw new Error('import job never drained — the baseline would be measuring a stall');
      },
      scrape: async () => parseMetricsText(registry.render()),
      grafana: null,
      ledgerEnabled: true,
      day: utcDay(),
    };

    const first = await runBaseline({ ...options, name: 'after-pr4-stub' });

    // Every scenario's correctness column has to be green, or the numbers
    // beside it are the cost of a broken flow.
    for (const scenario of first.scenarios) {
      // The whole scenario's assertions ride on any failure: a wrong count is
      // almost always explained by another line in the same list.
      const context = scenario.functional.assertions
        .map(
          (a) => `  ${a.pass ? 'ok  ' : 'FAIL'} ${a.name}: expected ${a.expected}, got ${a.actual}`,
        )
        .join('\n');
      for (const assertion of scenario.functional.assertions) {
        expect(assertion.pass, `${scenario.id} · ${assertion.name}\n${context}`).toBe(true);
      }
    }

    // Never one "Google calls" number: A and B must show no Places operation
    // at all, and C/D/E must name each tier separately.
    for (const id of ['A', 'B'] as const) {
      const scenario = first.scenarios.find((s) => s.id === id)!;
      const places = scenario.operations.filter((o) => o.provider === 'places');
      expect(places, `${id} must reach no Places operation`).toEqual([]);
    }

    const c2 = first.scenarios.find((s) => s.id === 'C2')!;
    expect(
      c2.operations.find((o) => o.operation === 'google.expand')?.callsAttempted,
      'the short-link hop is counted, not invisible (#336 instrumented the resolver walker)',
    ).toBe(options.fixtures.C2.urls.length);

    if (process.env.COST_BASELINE_WRITE === '1') {
      mkdirSync(path.dirname(ARTIFACT), { recursive: true });
      writeFileSync(ARTIFACT, `${JSON.stringify(first, null, 2)}\n`);
    }

    // The plan's acceptance criterion, run rather than asserted on paper —
    // from the same starting state, which is what "consecutive" has to mean
    // for scenarios that create catalog rows.
    await resetCatalogue({ user, moderator });
    const second = await runBaseline({ ...options, name: 'after-pr4-stub-repeat' });
    const repeat = compareBaselines(first, second);
    expect(repeat.agrees, formatComparison(repeat)).toBe(true);

    // …and the same against the committed freeze, so a behaviour change that
    // moves a call count cannot land silently.
    expect(existsSync(ARTIFACT), `${ARTIFACT} missing — re-freeze with COST_BASELINE_WRITE=1`).toBe(
      true,
    );
    const frozen = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as BaselineArtifact;
    const drift = compareBaselines(frozen, first);
    expect(
      drift.agrees,
      `baseline drift vs the committed freeze:\n${formatComparison(drift)}`,
    ).toBe(true);

    // The BEFORE freeze is evidence, not a working file. PR9 reports
    // BEFORE/AFTER/DELTA from it, so a re-freeze that quietly overwrote it
    // would delete the only record of what these flows used to cost.
    expect(
      existsSync(BEFORE_FREEZE),
      `${BEFORE_FREEZE} must survive every re-freeze — PR9 reads it as the BEFORE column`,
    ).toBe(true);
    expect(BEFORE_FREEZE, 'never point the golden at the BEFORE freeze').not.toBe(ARTIFACT);
  }, 300_000);
});

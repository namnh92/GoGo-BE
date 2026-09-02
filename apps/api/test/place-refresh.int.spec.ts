import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@gogo/database';
import { MetricsRegistry } from '@gogo/observability';
import { GooglePlacesAdapter } from '@gogo/providers';
import { PlaceRefreshService, ProviderBudgetService, budgetLimitsFrom } from '@gogo/modules';
import { AdvisoryLock } from '../../worker/src/periodic';

/**
 * PR7 / COST-BE-007 (#340) — the liveness refresh, against a real Postgres and
 * the real Google adapter with only `fetch` stubbed.
 *
 * The job is driven end to end on purpose. Its risky parts are not arithmetic:
 * they are which rows a partial index hands back and in what order, what a
 * default-deny budget does to a tick, what a provider outage must *not* write,
 * and which columns stay untouched while ADR-0006 §9.6 is unsigned. A fake
 * database cannot hold any of those properties, and a fake adapter would not
 * prove the request that goes out is still IDs-Only.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ENV = 'dev';
const NOW = () => new Date('2026-09-02T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Ceilings wide enough that only the case under test can refuse. */
const OPEN_LIMITS = budgetLimitsFrom('google.places.refresh', {
  PLACE_REFRESH_DAILY_MAX_CALLS: '1000',
  PLACE_REFRESH_DAILY_MAX_LIST_COST_USD: '1',
  PLACE_REFRESH_DAILY_MAX_UNITS_GOOGLE_DETAILS_LIVENESS: '1000',
});

type Stub = { status: number; body?: unknown };
let queued: Stub[] = [];
let requests: { url: string; fieldMask: string | null }[] = [];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const next = queued.shift() ?? { status: 200, body: {} };
      requests.push({
        url: String(input),
        fieldMask: init?.headers?.['X-Goog-FieldMask'] ?? null,
      });
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        url: String(input),
        headers: { get: () => null },
        json: async () => next.body ?? {},
        text: async () => JSON.stringify(next.body ?? {}),
      };
    }),
  );
}

let seq = 0;

async function seedPlace(status: 'published' | 'draft' = 'published'): Promise<string> {
  seq += 1;
  const [row] = await db
    .insert(schema.places)
    .values({
      name: `Refresh Test ${seq}`,
      nameNormalized: 'set-by-trigger',
      status,
      geom: { x: 106.7 + seq / 1000, y: 10.77 },
      confidence: '0.9',
    })
    .returning();
  return row!.id;
}

/** A canonical Google provider row, due (or not) at a chosen offset. */
async function seedSource(input: {
  placeId: string;
  externalId: string;
  dueInDays?: number | null;
  priority?: number;
  attempts?: number;
}): Promise<string> {
  const due =
    input.dueInDays === null || input.dueInDays === undefined
      ? input.dueInDays === null
        ? null
        : new Date(NOW().getTime() - DAY_MS)
      : new Date(NOW().getTime() + input.dueInDays * DAY_MS);
  const [row] = await db
    .insert(schema.placeProviderSources)
    .values({
      placeId: input.placeId,
      provider: 'google_places',
      externalId: input.externalId,
      rating: '4.50',
      ratingCount: 120,
      derivedScore: '80.00',
      priceLevel: 2,
      primaryType: 'restaurant',
      refreshAfter: due,
      refreshPriority: input.priority ?? 0,
      refreshAttempts: input.attempts ?? 0,
      attribution: { text: 'Google Maps' },
      sourceStatus: 'active',
      fetchTier: 'quality',
    })
    .returning();
  return row!.id;
}

async function sourceRow(id: string) {
  const { rows } = await db.execute(sql`
    select external_id, source_status, fetch_tier, rating, rating_count, price_level, primary_type,
           refresh_after, refresh_attempts, last_refresh_error_code, moved_to_external_id,
           fetched_at, last_refresh_attempt_at
    from place_provider_sources where id = ${id}
  `);
  return rows[0] as unknown as Record<string, unknown>;
}

async function placeRow(id: string) {
  const { rows } = await db.execute(sql`
    select name, status, rating, rating_count, freshness_checked_at from places where id = ${id}
  `);
  return rows[0] as unknown as Record<string, unknown>;
}

async function auditActions(placeId: string): Promise<string[]> {
  const { rows } = await db.execute(sql`
    select action from audit_logs where resource_id = ${placeId} order by created_at asc
  `);
  return (rows as unknown as { action: string }[]).map((r) => r.action);
}

function service(overrides?: {
  limits?: typeof OPEN_LIMITS;
  flagDefault?: boolean;
  batchSize?: number;
  deadlineMs?: number;
  metrics?: MetricsRegistry;
}) {
  const metrics = overrides?.metrics ?? new MetricsRegistry();
  return new PlaceRefreshService(
    db as never,
    new GooglePlacesAdapter('test-key', metrics),
    new ProviderBudgetService(db as never),
    metrics,
    {
      appEnv: ENV,
      flagDefault: overrides?.flagDefault ?? true,
      limits: overrides?.limits ?? OPEN_LIMITS,
      ...(overrides?.batchSize !== undefined ? { batchSize: overrides.batchSize } : {}),
      ...(overrides?.deadlineMs !== undefined ? { deadlineMs: overrides.deadlineMs } : {}),
      now: NOW,
    },
  );
}

/** `{ id }` — what Google answers for a place that is still itself. */
const alive = (id: string) => ({ status: 200, body: { id } });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_refresh_test')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  queued = [];
  requests = [];
  await db.execute(sql`delete from provider_budget_daily`);
  await db.execute(sql`delete from audit_logs`);
  await db.execute(sql`delete from place_provider_sources`);
  await db.execute(sql`delete from places`);
  await db.execute(sql`delete from feature_flags`);
});

describe('due-row selection', () => {
  it('takes only rows that are due, in priority then oldest-due order', async () => {
    stubFetch();
    const a = await seedPlace();
    const b = await seedPlace();
    const c = await seedPlace();
    const d = await seedPlace();
    await seedSource({ placeId: a, externalId: 'ChIJ-old', dueInDays: -10 });
    await seedSource({ placeId: b, externalId: 'ChIJ-recent', dueInDays: -1 });
    await seedSource({ placeId: c, externalId: 'ChIJ-priority', dueInDays: -1, priority: 1 });
    // Not due: a month out, and the tick must not touch it.
    await seedSource({ placeId: d, externalId: 'ChIJ-future', dueInDays: 30 });

    queued = [alive('ChIJ-priority'), alive('ChIJ-old'), alive('ChIJ-recent')];
    const report = await service().tick();

    expect(report).toMatchObject({ tick: 'ran', attempted: 3, succeeded: 3 });
    expect(requests.map((r) => decodeURIComponent(r.url.split('/places/')[1] ?? ''))).toEqual([
      'ChIJ-priority',
      'ChIJ-old',
      'ChIJ-recent',
    ]);
  });

  it('reports nothing due without reserving budget or calling the provider', async () => {
    stubFetch();
    const place = await seedPlace();
    await seedSource({ placeId: place, externalId: 'ChIJ-future', dueInDays: 30 });

    const report = await service().tick();

    expect(report.tick).toBe('nothing_due');
    expect(requests).toHaveLength(0);
    const { rows } = await db.execute(sql`select count(*)::int as n from provider_budget_daily`);
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it('never asks about a dormant row — refresh_after IS NULL is out of the index', async () => {
    stubFetch();
    const place = await seedPlace();
    await seedSource({ placeId: place, externalId: 'ChIJ-dormant', dueInDays: null });

    expect((await service().tick()).tick).toBe('nothing_due');
    expect(requests).toHaveLength(0);
  });

  it('stops at the batch limit and leaves the rest due for the next tick', async () => {
    stubFetch();
    for (let i = 0; i < 4; i += 1) {
      const place = await seedPlace();
      await seedSource({ placeId: place, externalId: `ChIJ-batch-${i}`, dueInDays: -1 });
    }
    queued = [alive('x'), alive('x')];

    const report = await service({ batchSize: 2 }).tick();

    expect(report.attempted).toBe(2);
    const { rows } = await db.execute(
      sql`select count(*)::int as n from place_provider_sources where refresh_after <= now()`,
    );
    expect((rows[0] as { n: number }).n).toBe(2);
  });
});

describe('bounds that stop the tick', () => {
  it('the kill switch means no provider call at all', async () => {
    stubFetch();
    const place = await seedPlace();
    await seedSource({ placeId: place, externalId: 'ChIJ-off', dueInDays: -1 });

    const report = await service({ flagDefault: false }).tick();

    expect(report.tick).toBe('disabled');
    expect(requests).toHaveLength(0);
  });

  it('a stored flag row beats the deploy-time default, in both directions', async () => {
    stubFetch();
    const place = await seedPlace();
    await seedSource({ placeId: place, externalId: 'ChIJ-flagged', dueInDays: -1 });
    await db.execute(sql`
      insert into feature_flags (key, environment, platform, enabled, payload)
      values ('place_refresh.enabled', 'dev', 'all', false, null)
    `);

    expect((await service({ flagDefault: true }).tick()).tick).toBe('disabled');
    expect(requests).toHaveLength(0);

    await db.execute(
      sql`update feature_flags set enabled = true where key = 'place_refresh.enabled'`,
    );
    queued = [alive('ChIJ-flagged')];
    expect((await service({ flagDefault: false }).tick()).tick).toBe('ran');
    expect(requests).toHaveLength(1);
  });

  it('an unconfigured budget refuses the tick — and says so differently from a provider failure', async () => {
    stubFetch();
    const place = await seedPlace();
    await seedSource({ placeId: place, externalId: 'ChIJ-nobudget', dueInDays: -1 });

    const report = await service({
      limits: budgetLimitsFrom('google.places.refresh', {}),
    }).tick();

    expect(report).toMatchObject({ tick: 'refused_budget', refusal: 'not_configured' });
    expect(report.stoppedBy).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it('refuses once the day ceiling is spent, and the rows stay due', async () => {
    stubFetch();
    for (let i = 0; i < 2; i += 1) {
      const place = await seedPlace();
      await seedSource({ placeId: place, externalId: `ChIJ-cap-${i}`, dueInDays: -1 });
    }
    const tightLimits = budgetLimitsFrom('google.places.refresh', {
      PLACE_REFRESH_DAILY_MAX_CALLS: '1',
      PLACE_REFRESH_DAILY_MAX_LIST_COST_USD: '1',
      PLACE_REFRESH_DAILY_MAX_UNITS_GOOGLE_DETAILS_LIVENESS: '1000',
    });

    queued = [alive('ChIJ-cap-0')];
    const first = await service({ limits: tightLimits, batchSize: 1 }).tick();
    expect(first.succeeded).toBe(1);

    const second = await service({ limits: tightLimits, batchSize: 1 }).tick();
    expect(second).toMatchObject({ tick: 'refused_budget', refusal: 'call_ceiling' });
    expect(requests).toHaveLength(1);
  });

  it('stops at the deadline rather than running into the next tick', async () => {
    stubFetch();
    for (let i = 0; i < 3; i += 1) {
      const place = await seedPlace();
      await seedSource({ placeId: place, externalId: `ChIJ-slow-${i}`, dueInDays: -1 });
    }
    queued = [alive('ChIJ-slow-0'), alive('ChIJ-slow-1'), alive('ChIJ-slow-2')];

    const report = await service({ deadlineMs: 0 }).tick();

    expect(report).toMatchObject({ attempted: 0, stoppedBy: 'deadline' });
    expect(requests).toHaveLength(0);
  });

  it('one advisory lock keeps a second runner out of the same job', async () => {
    const lock = new AdvisoryLock(pool as never);
    const held = await lock.tryAcquire('gogo:worker:place-refresh');
    expect(held).not.toBeNull();
    expect(
      await new AdvisoryLock(pool as never).tryAcquire('gogo:worker:place-refresh'),
    ).toBeNull();
    await held!();
    const after = await new AdvisoryLock(pool as never).tryAcquire('gogo:worker:place-refresh');
    expect(after).not.toBeNull();
    await after!();
  });
});

describe('answers', () => {
  it('a live id reschedules 30 days out and stamps the place as checked', async () => {
    stubFetch();
    const place = await seedPlace();
    const source = await seedSource({
      placeId: place,
      externalId: 'ChIJ-live',
      dueInDays: -1,
      attempts: 2,
    });
    queued = [alive('ChIJ-live')];

    await service().tick();

    const row = await sourceRow(source);
    expect(row.source_status).toBe('active');
    expect(Number(row.refresh_attempts)).toBe(0);
    expect(row.last_refresh_error_code).toBeNull();
    const due = new Date(row.refresh_after as string).getTime() - NOW().getTime();
    expect(Math.round(due / DAY_MS)).toBe(30);
    expect((await placeRow(place)).freshness_checked_at).not.toBeNull();
  });

  it('asks the IDs-Only mask and nothing else', async () => {
    stubFetch();
    const place = await seedPlace();
    await seedSource({ placeId: place, externalId: 'ChIJ-mask', dueInDays: -1 });
    queued = [alive('ChIJ-mask')];

    await service().tick();

    // The whole cost argument of phase 1 rests on this string: `id` and
    // `movedPlaceId` are Essentials IDs-Only fields, billed at $0. One more
    // field here silently moves every refresh onto a paid SKU.
    expect(requests[0]?.fieldMask).toBe('id,movedPlaceId');
  });

  it('a named successor marks the row moved, sends the place to review, and creates nothing', async () => {
    stubFetch();
    const place = await seedPlace();
    const source = await seedSource({ placeId: place, externalId: 'ChIJ-gone', dueInDays: -1 });
    queued = [{ status: 200, body: { id: 'ChIJ-gone', movedPlaceId: 'ChIJ-successor' } }];

    const report = await service().tick();

    expect(report.moved).toBe(1);
    const row = await sourceRow(source);
    expect(row).toMatchObject({
      source_status: 'moved',
      moved_to_external_id: 'ChIJ-successor',
      refresh_after: null,
    });
    expect((await placeRow(place)).status).toBe('review');
    expect(await auditActions(place)).toEqual(['place.identity_review_required']);
    const { rows } = await db.execute(sql`select count(*)::int as n from places`);
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('reads an answer about a different id as a move too', async () => {
    stubFetch();
    const place = await seedPlace();
    const source = await seedSource({ placeId: place, externalId: 'ChIJ-asked', dueInDays: -1 });
    queued = [{ status: 200, body: { id: 'ChIJ-answered' } }];

    await service().tick();

    expect(await sourceRow(source)).toMatchObject({
      source_status: 'moved',
      moved_to_external_id: 'ChIJ-answered',
    });
  });

  it('leaves a draft place where it is — review is for what is being served', async () => {
    stubFetch();
    const place = await seedPlace('draft');
    await seedSource({ placeId: place, externalId: 'ChIJ-draft', dueInDays: -1 });
    queued = [{ status: 200, body: { id: 'ChIJ-draft', movedPlaceId: 'ChIJ-next' } }];

    await service().tick();

    expect((await placeRow(place)).status).toBe('draft');
    expect(await auditActions(place)).toEqual([]);
  });

  it('backs a rejected id off, twice, then stops asking without calling it closed', async () => {
    stubFetch();
    const place = await seedPlace();
    const source = await seedSource({ placeId: place, externalId: 'ChIJ-bad', dueInDays: -1 });
    const notFound = {
      status: 404,
      body: { error: { code: 404, status: 'NOT_FOUND', message: 'not found' } },
    };

    queued = [notFound];
    await service().tick();
    let row = await sourceRow(source);
    expect(Number(row.refresh_attempts)).toBe(1);
    expect(row.last_refresh_error_code).toBe('NOT_FOUND');
    expect(
      Math.round((new Date(row.refresh_after as string).getTime() - NOW().getTime()) / DAY_MS),
    ).toBe(7);
    expect(row.source_status).toBe('active');

    await db.execute(
      sql`update place_provider_sources set refresh_after = now() - interval '1 day'`,
    );
    queued = [notFound];
    await service().tick();
    row = await sourceRow(source);
    expect(Number(row.refresh_attempts)).toBe(2);
    expect(
      Math.round((new Date(row.refresh_after as string).getTime() - NOW().getTime()) / DAY_MS),
    ).toBe(14);

    await db.execute(
      sql`update place_provider_sources set refresh_after = now() - interval '1 day'`,
    );
    queued = [notFound];
    const report = await service().tick();
    row = await sourceRow(source);
    expect(report.dormant).toBe(1);
    expect(row).toMatchObject({
      refresh_after: null,
      source_status: 'unknown',
      last_refresh_error_code: 'NOT_FOUND',
    });
    expect(Number(row.refresh_attempts)).toBe(3);
    // Not closed, not deleted, and still published: three failed lookups are a
    // reason to ask a person, not a licence to decide the business is gone.
    expect((await placeRow(place)).status).toBe('published');
    expect(await auditActions(place)).toEqual(['place.refresh_identity_unverifiable']);
  });

  it('a provider outage writes nothing, records no attempt, and leaves the rows due', async () => {
    stubFetch();
    const place = await seedPlace();
    const other = await seedPlace();
    const source = await seedSource({ placeId: place, externalId: 'ChIJ-out-1', dueInDays: -2 });
    await seedSource({ placeId: other, externalId: 'ChIJ-out-2', dueInDays: -1 });
    // 429 three times: the adapter retries twice inside one call.
    queued = [
      { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } },
      { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } },
      { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } },
    ];

    const report = await service().tick();

    expect(report).toMatchObject({
      attempted: 1,
      stoppedBy: 'provider_error',
      errorCode: 'QUOTA_EXCEEDED',
    });
    const row = await sourceRow(source);
    expect(Number(row.refresh_attempts)).toBe(0);
    expect(row.last_refresh_error_code).toBeNull();
    expect(row.source_status).toBe('active');
    // Both rows still due — the second was never reached.
    const { rows } = await db.execute(
      sql`select count(*)::int as n from place_provider_sources where refresh_after <= now()`,
    );
    expect((rows[0] as { n: number }).n).toBe(2);
  });
});

describe('what refresh is not allowed to do', () => {
  it('touches no provider content on a successful check', async () => {
    stubFetch();
    const place = await seedPlace();
    const source = await seedSource({ placeId: place, externalId: 'ChIJ-content', dueInDays: -1 });
    const before = await sourceRow(source);
    const placeBefore = await placeRow(place);
    // A body carrying everything phase 2 would want. Phase 1 asked for none of
    // it, and must store none of it even when it arrives.
    queued = [
      {
        status: 200,
        body: {
          id: 'ChIJ-content',
          displayName: { text: 'Renamed By Google' },
          formattedAddress: 'Somewhere else',
          rating: 2.1,
          userRatingCount: 9,
          businessStatus: 'CLOSED_PERMANENTLY',
          priceLevel: 'PRICE_LEVEL_VERY_EXPENSIVE',
          primaryType: 'night_club',
        },
      },
    ];

    await service().tick();

    const after = await sourceRow(source);
    expect(after.rating).toBe(before.rating);
    expect(after.rating_count).toBe(before.rating_count);
    expect(after.price_level).toBe(before.price_level);
    expect(after.primary_type).toBe(before.primary_type);
    expect(after.fetch_tier).toBe('quality');
    // Above all: a liveness answer cannot close a place, whatever the body says.
    expect(after.source_status).toBe('active');
    const placeAfter = await placeRow(place);
    expect(placeAfter.name).toBe(placeBefore.name);
    expect(placeAfter.rating).toBe(placeBefore.rating);
    expect(placeAfter.status).toBe('published');
  });

  it('never writes a status derived from a business status — including FUTURE_OPENING', async () => {
    stubFetch();
    const place = await seedPlace();
    const source = await seedSource({
      placeId: place,
      externalId: 'ChIJ-future-open',
      dueInDays: -1,
    });
    queued = [{ status: 200, body: { id: 'ChIJ-future-open', businessStatus: 'FUTURE_OPENING' } }];

    await service().tick();

    // `unknown` is reachable from this job only through three failed lookups.
    // It must never arrive by way of a provider status, because that is the
    // flattening ADR-0006 §9.5 forbids widening while §9.6 is unsigned.
    expect((await sourceRow(source)).source_status).toBe('active');
  });

  it('is idempotent: running the same tick twice changes nothing the second time', async () => {
    stubFetch();
    const place = await seedPlace();
    const source = await seedSource({ placeId: place, externalId: 'ChIJ-twice', dueInDays: -1 });
    queued = [alive('ChIJ-twice')];
    await service().tick();
    const first = await sourceRow(source);

    const second = await service().tick();

    expect(second.tick).toBe('nothing_due');
    expect(await sourceRow(source)).toEqual(first);
  });

  it('counts every outcome under one bounded label', async () => {
    stubFetch();
    const metrics = new MetricsRegistry();
    const place = await seedPlace();
    await seedSource({ placeId: place, externalId: 'ChIJ-metric', dueInDays: -1 });
    queued = [alive('ChIJ-metric')];

    await service({ metrics }).tick();
    await service({ metrics }).tick();

    const rendered = metrics.render();
    expect(rendered).toContain('place_refresh_total{outcome="attempted"} 1');
    expect(rendered).toContain('place_refresh_total{outcome="succeeded"} 1');
    expect(rendered).toContain('place_refresh_total{outcome="deferred_not_due"} 1');
    // No id, no external id, no Google status text anywhere in the series.
    expect(rendered).not.toContain('ChIJ-metric');
  });
});

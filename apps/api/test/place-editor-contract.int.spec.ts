import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import argon2 from 'argon2';
import { asc, eq } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';

/**
 * BE-CMS-PE-001 (#425) — the contract the CMS place editor writes against.
 *
 * The first block is a regression, not a feature: the console's save failed
 * with `Request validation failed` on any place that had no visit duration,
 * because an empty number input coerced to `0` and the schema's floor was
 * `10`. The field is nullable now, and `0` still fails — deliberately, since a
 * ten-second visit is a typo and silently accepting it would trade one wrong
 * answer for another.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

function api() {
  return app.getHttpAdapter().getInstance();
}
let ipc = 0;
const ip = () => `10.60.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function createAdmin(email: string, role: 'editor' | 'moderator' | 'ops_admin') {
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  const [row] = await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: email.split('@')[0]!, role })
    .returning();
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  expect(res.statusCode).toBe(201);
  return { id: row!.id, token: res.json().accessToken as string };
}

let seq = 0;
async function makePlace(overrides: Partial<typeof schema.places.$inferInsert> = {}) {
  const name = `Chào Bạn ${++seq}`;
  const [row] = await db
    .insert(schema.places)
    .values({
      name,
      nameNormalized: name.toLowerCase(),
      status: 'draft',
      geom: { x: 106.7009, y: 10.7769 },
      ...overrides,
    })
    .returning();
  return row!;
}

let editor: { id: string; token: string };

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_place_editor_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();

  editor = await createAdmin('pe-editor@gogo.local', 'editor');
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

const patch = (id: string, payload: Record<string, unknown>, token = editor.token) =>
  api().inject({ method: 'PATCH', url: `/v1/cms/places/${id}`, headers: auth(token), payload });

const detail = (id: string, token = editor.token) =>
  api().inject({ method: 'GET', url: `/v1/cms/places/${id}`, headers: auth(token) });

describe('#425 regression — the save that always failed', () => {
  it('refuses avgVisitMinutes 0 with a field path, not a bare toast', async () => {
    const place = await makePlace();
    const res = await patch(place.id, { name: place.name, avgVisitMinutes: 0 });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.message).toBe('Request validation failed');
    expect(body.field_errors).toEqual([
      expect.objectContaining({ field: 'avgVisitMinutes', code: 'too_small' }),
    ]);
    // The envelope carries what an operator can quote in a bug report.
    expect(body.request_id).toBeTruthy();
  });

  it('accepts null for an empty visit duration and clears the stored value', async () => {
    const place = await makePlace({ avgVisitMinutes: 90 });
    expect((await patch(place.id, { avgVisitMinutes: null })).statusCode).toBe(200);

    const [after] = await db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(after!.avgVisitMinutes).toBeNull();
    expect((await detail(place.id)).json().avgVisitMinutes).toBeNull();
  });

  it('refuses an areaKey past 64 characters — the console allowed 80', async () => {
    const place = await makePlace();
    const res = await patch(place.id, { areaKey: 'a'.repeat(65) });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0].field).toBe('areaKey');
  });

  it('clears areaKey, addressText and description with null', async () => {
    const place = await makePlace({
      areaKey: 'hcm_q1',
      addressText: '12 Nguyễn Huệ',
      description: 'cũ',
    });
    expect(
      (await patch(place.id, { areaKey: null, addressText: null, description: null })).statusCode,
    ).toBe(200);
    const body = (await detail(place.id)).json();
    expect(body.areaKey).toBeNull();
    expect(body.addressText).toBeNull();
    expect(body.description).toBeNull();
  });
});

describe('#425 contact fields, normalized on the way in', () => {
  it.each([
    ['0283 822 9999', '+842838229999'],
    ['(028) 3822-9999', '+842838229999'],
    ['+84 28 3822 9999', '+842838229999'],
  ])('stores %s as %s', async (input, expected) => {
    const place = await makePlace();
    expect((await patch(place.id, { phone: input })).statusCode).toBe(200);
    expect((await detail(place.id)).json().phone).toBe(expected);
  });

  it('upgrades a bare host to https and keeps the path', async () => {
    const place = await makePlace();
    await patch(place.id, { website: 'chaoban.vn/menu' });
    expect((await detail(place.id)).json().website).toBe('https://chaoban.vn/menu');
  });

  it('refuses a javascript: URL — the value is rendered as an href', async () => {
    const place = await makePlace();
    const res = await patch(place.id, { website: 'javascript:alert(1)' });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0]).toMatchObject({ field: 'website' });
  });

  it('refuses a bare subscriber number rather than assuming Vietnam', async () => {
    const place = await makePlace();
    const res = await patch(place.id, { phone: '3822 9999' });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0]).toMatchObject({ field: 'phone', code: 'no_country' });
  });

  it('reports every bad contact field at once, not the first one', async () => {
    const place = await makePlace();
    const res = await patch(place.id, { phone: 'gọi tôi', website: 'ftp://x.vn' });
    expect(res.statusCode).toBe(400);
    expect(
      res
        .json()
        .field_errors.map((e: { field: string }) => e.field)
        .sort(),
    ).toEqual(['phone', 'website']);
  });

  it('clears phone and website with null', async () => {
    const place = await makePlace({ phone: '+842838229999', website: 'https://chaoban.vn/' });
    await patch(place.id, { phone: null, website: null });
    const body = (await detail(place.id)).json();
    expect(body.phone).toBeNull();
    expect(body.website).toBeNull();
  });

  it('round-trips a city with no district — not every address has one', async () => {
    const place = await makePlace();
    expect((await patch(place.id, { city: 'TP.HCM' })).statusCode).toBe(200);
    const body = (await detail(place.id)).json();
    expect(body.city).toBe('TP.HCM');
    expect(body.district).toBeNull();
  });
});

describe('#425 field provenance', () => {
  it('records an editor claim per written field and leaves the rest unclaimed', async () => {
    const place = await makePlace();
    await patch(place.id, { phone: '0283 822 9999', city: 'TP.HCM' });

    const body = (await detail(place.id)).json();
    expect(body.provenance.phone).toMatchObject({ sourceType: 'editorial', sourceReference: null });
    expect(body.provenance.city).toMatchObject({ sourceType: 'editorial' });
    // Never written through this endpoint, so nothing claims it. An absent
    // entry is the honest answer, not a default of "GoGo".
    expect(body.provenance.website).toBeUndefined();
    expect(body.provenance.description).toBeUndefined();

    const rows = await db
      .select()
      .from(schema.placeFieldProvenance)
      .where(eq(schema.placeFieldProvenance.placeId, place.id));
    expect(rows.map((r) => r.field).sort()).toEqual(['city', 'phone']);
    expect(rows.every((r) => r.actorId === editor.id)).toBe(true);
  });

  it('re-typing a value keeps it editorial and never becomes google_derived', async () => {
    // GOGO_PRODUCT_DATA_ARCHITECTURE.md: copying Google's answer into the form
    // does not make it GoGo-owned, and it does not make it Google's either —
    // the person typed it, so the person owns the claim. `google_derived` is
    // reserved for an apply-from-preview path this endpoint does not offer.
    const place = await makePlace();
    await patch(place.id, { phone: '0283 822 9999' });
    await patch(place.id, { phone: '+84 28 3822 9999' });
    const body = (await detail(place.id)).json();
    expect(body.provenance.phone.sourceType).toBe('editorial');
  });
});

describe('#425 optimistic concurrency', () => {
  it('refuses a save built on a stale form and reports the current version', async () => {
    const place = await makePlace();
    const loaded = (await detail(place.id)).json();

    // Somebody else saves first.
    expect((await patch(place.id, { description: 'người khác sửa' })).statusCode).toBe(200);

    const res = await patch(place.id, {
      description: 'bản của tôi',
      expectedUpdatedAt: loaded.updatedAt,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PLACE_MODIFIED');
    const current = (await detail(place.id)).json();
    expect(res.json().field_errors[0].message).toBe(current.updatedAt);
    // The losing write did not land.
    expect(current.description).toBe('người khác sửa');
  });

  it('accepts a save whose expected version still matches', async () => {
    const place = await makePlace();
    const loaded = (await detail(place.id)).json();
    const res = await patch(place.id, {
      description: 'ok',
      expectedUpdatedAt: loaded.updatedAt,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('#425 opening hours', () => {
  const putHours = (id: string, payload: Record<string, unknown>, token = editor.token) =>
    api().inject({
      method: 'PUT',
      url: `/v1/cms/places/${id}/hours`,
      headers: auth(token),
      payload,
    });

  it('applies one span to all seven days and reads every day back', async () => {
    const place = await makePlace();
    const hours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      openMinute: 8 * 60,
      closeMinute: 22 * 60,
    }));
    expect((await putHours(place.id, { hours })).statusCode).toBe(200);

    const body = (await detail(place.id)).json();
    expect(body.hours).toHaveLength(7);
    expect(body.hours.every((h: { kind: string }) => h.kind === 'interval')).toBe(true);
    expect(body.hours.every((h: { source: string }) => h.source === 'editor')).toBe(true);
  });

  it('keeps two services on one day, and an overnight span, through a round trip', async () => {
    const place = await makePlace();
    const hours = [
      { dayOfWeek: 1, openMinute: 11 * 60, closeMinute: 14 * 60 },
      { dayOfWeek: 1, openMinute: 17 * 60, closeMinute: 22 * 60 },
      { dayOfWeek: 5, openMinute: 18 * 60, closeMinute: 2 * 60, isOvernight: true },
    ];
    expect((await putHours(place.id, { hours })).statusCode).toBe(200);

    const body = (await detail(place.id)).json();
    expect(body.hours).toHaveLength(3);
    expect(body.hours.filter((h: { dayOfWeek: number }) => h.dayOfWeek === 1)).toHaveLength(2);
    expect(body.hours.find((h: { dayOfWeek: number }) => h.dayOfWeek === 5)).toMatchObject({
      isOvernight: true,
      closeMinute: 120,
    });
  });

  it('stores closed and open-around-the-clock as themselves, and unknown as absence', async () => {
    const place = await makePlace();
    const hours = [
      { dayOfWeek: 0, kind: 'closed' },
      { dayOfWeek: 6, kind: 'open_24h' },
      // Days 1..5 are simply absent: unknown, which is not the same as closed.
    ];
    expect((await putHours(place.id, { hours })).statusCode).toBe(200);

    const body = (await detail(place.id)).json();
    expect(body.hours).toHaveLength(2);
    expect(body.hours.find((h: { dayOfWeek: number }) => h.dayOfWeek === 0).kind).toBe('closed');
    expect(body.hours.find((h: { dayOfWeek: number }) => h.dayOfWeek === 6).kind).toBe('open_24h');
    expect(body.hours.some((h: { dayOfWeek: number }) => h.dayOfWeek === 3)).toBe(false);
  });

  it('refuses overlapping services and names the row', async () => {
    const place = await makePlace();
    const res = await putHours(place.id, {
      hours: [
        { dayOfWeek: 2, openMinute: 8 * 60, closeMinute: 14 * 60 },
        { dayOfWeek: 2, openMinute: 13 * 60, closeMinute: 20 * 60 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0]).toMatchObject({ field: 'hours.1', code: 'overlapping' });
  });

  it('refuses an overnight span colliding with the next morning across the week wrap', async () => {
    const place = await makePlace();
    const res = await putHours(place.id, {
      hours: [
        { dayOfWeek: 6, openMinute: 22 * 60, closeMinute: 3 * 60, isOvernight: true },
        { dayOfWeek: 0, openMinute: 60, closeMinute: 5 * 60 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0].code).toBe('overlapping');
  });

  it('refuses a day that is both closed and open for a span', async () => {
    const place = await makePlace();
    const res = await putHours(place.id, {
      hours: [
        { dayOfWeek: 3, kind: 'closed' },
        { dayOfWeek: 3, openMinute: 9 * 60, closeMinute: 17 * 60 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0].code).toBe('conflicting_day');
  });

  it('refuses a whole-day row that also carries minutes', async () => {
    const place = await makePlace();
    const res = await putHours(place.id, {
      hours: [{ dayOfWeek: 3, kind: 'open_24h', openMinute: 8 * 60, closeMinute: 0 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0].code).toBe('minutes_not_allowed');
  });

  it('a failed PUT changes nothing — the week on the server is the one before it', async () => {
    const place = await makePlace();
    await putHours(place.id, { hours: [{ dayOfWeek: 1, openMinute: 480, closeMinute: 1080 }] });
    const before = (await detail(place.id)).json().hours;

    const bad = await putHours(place.id, {
      hours: [
        { dayOfWeek: 1, openMinute: 480, closeMinute: 1080 },
        { dayOfWeek: 1, openMinute: 600, closeMinute: 1200 },
      ],
    });
    expect(bad.statusCode).toBe(400);
    expect((await detail(place.id)).json().hours).toEqual(before);
  });

  it('a provider row keeps its source and does not move the freshness clock', async () => {
    const place = await makePlace();
    const fetchedAt = new Date('2026-01-01T00:00:00.000Z');
    await db.insert(schema.placeHours).values({
      placeId: place.id,
      dayOfWeek: 4,
      openMinute: 9 * 60,
      closeMinute: 17 * 60,
      isOvernight: false,
      source: 'provider',
      verifiedAt: fetchedAt,
    });

    const res = await putHours(place.id, {
      hours: [{ dayOfWeek: 4, openMinute: 9 * 60, closeMinute: 17 * 60, source: 'provider' }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ updated: true, verified: false });

    const [row] = await db
      .select()
      .from(schema.placeHours)
      .where(eq(schema.placeHours.placeId, place.id));
    expect(row!.source).toBe('provider');
    // Confirming what the provider said is not verifying it, so the fetch time
    // it came with survives rather than being restamped as "checked today".
    expect(row!.verifiedAt?.toISOString()).toBe(fetchedAt.toISOString());

    const [after] = await db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(after!.freshnessCheckedAt).toBeNull();
  });

  it('an editor row does stamp verification and move freshness', async () => {
    const place = await makePlace();
    const res = await putHours(place.id, {
      hours: [{ dayOfWeek: 4, openMinute: 9 * 60, closeMinute: 17 * 60 }],
    });
    expect(res.json()).toMatchObject({ verified: true });

    const [after] = await db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(after!.freshnessCheckedAt).not.toBeNull();
  });

  it('refuses a week built on a stale form', async () => {
    const place = await makePlace();
    const loaded = (await detail(place.id)).json();
    await patch(place.id, { description: 'ai đó sửa' });

    const res = await putHours(place.id, {
      hours: [{ dayOfWeek: 1, openMinute: 480, closeMinute: 1080 }],
      expectedUpdatedAt: loaded.updatedAt,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PLACE_MODIFIED');
  });
});

describe('#425 area vocabulary', () => {
  beforeAll(async () => {
    await db
      .insert(schema.serviceAreas)
      .values([
        {
          key: 'hcm_q1',
          name: 'Quận 1, TP.HCM',
          city: 'TP.HCM',
          centerLat: 10.7769,
          centerLng: 106.7009,
          radiusM: 3000,
          sortOrder: 0,
        },
        {
          key: 'hn_hoankiem',
          name: 'Hoàn Kiếm, Hà Nội',
          city: 'Hà Nội',
          centerLat: 21.0285,
          centerLng: 105.8542,
          radiusM: 2500,
          sortOrder: 1,
        },
        {
          key: 'hcm_retired',
          name: 'Khu vực đã ngừng',
          city: 'TP.HCM',
          centerLat: 10.8,
          centerLng: 106.7,
          radiusM: 1000,
          isActive: false,
          sortOrder: 9,
        },
      ])
      .onConflictDoNothing();
    await makePlace({ areaKey: 'hcm_q1' });
    await makePlace({ areaKey: 'hcm_q1' });
    // A key no catalog row lists — `places.area_key` has never been a FK.
    await makePlace({ areaKey: 'legacy_unlisted' });
  });

  const areas = (query = '', token = editor.token) =>
    api().inject({ method: 'GET', url: `/v1/cms/areas${query}`, headers: auth(token) });

  it('lists the catalog with the number of places already filed under each', async () => {
    const items = (await areas()).json().items as { key: string; placeCount: number }[];
    expect(items.find((a) => a.key === 'hcm_q1')).toMatchObject({
      name: 'Quận 1, TP.HCM',
      city: 'TP.HCM',
      isActive: true,
      known: true,
      placeCount: 2,
    });
  });

  it('hides a retired area by default and returns it on request', async () => {
    const byDefault = (await areas()).json().items as { key: string }[];
    expect(byDefault.some((a) => a.key === 'hcm_retired')).toBe(false);

    const withInactive = (await areas('?includeInactive=true')).json().items as {
      key: string;
      isActive: boolean;
    }[];
    expect(withInactive.find((a) => a.key === 'hcm_retired')).toMatchObject({ isActive: false });
  });

  it('returns a key that is on a place but not in the catalog, flagged unknown', async () => {
    const items = (await areas()).json().items as { key: string; known: boolean; name: null }[];
    expect(items.find((a) => a.key === 'legacy_unlisted')).toMatchObject({
      known: false,
      name: null,
      placeCount: 1,
    });
  });

  it('matches an unaccented query against an accented name', async () => {
    const items = (await areas('?q=quan 1')).json().items as { key: string }[];
    expect(items.map((a) => a.key)).toContain('hcm_q1');
    expect(items.map((a) => a.key)).not.toContain('hn_hoankiem');
  });

  it('filters by city', async () => {
    const items = (await areas('?city=' + encodeURIComponent('Hà Nội'))).json().items as {
      key: string;
    }[];
    expect(items.map((a) => a.key)).toEqual(['hn_hoankiem']);
  });

  it('an area key the editor picks survives a save and a reload', async () => {
    const place = await makePlace();
    await patch(place.id, { areaKey: 'hn_hoankiem' });
    expect((await detail(place.id)).json().areaKey).toBe('hn_hoankiem');

    // The list filter reads the same key — one vocabulary, not two.
    const list = await api().inject({
      method: 'GET',
      url: '/v1/cms/places?areaKey=hn_hoankiem',
      headers: auth(editor.token),
    });
    expect(list.json().items.map((p: { id: string }) => p.id)).toContain(place.id);
  });
});

describe('#425 RBAC', () => {
  it('a moderator may read the area catalog but not write a place', async () => {
    const moderator = await createAdmin('pe-mod@gogo.local', 'moderator');
    const place = await makePlace();

    const read = await api().inject({
      method: 'GET',
      url: '/v1/cms/areas',
      headers: auth(moderator.token),
    });
    expect(read.statusCode).toBe(200);

    const write = await patch(place.id, { phone: '0283 822 9999' }, moderator.token);
    expect(write.statusCode).toBe(403);
    expect(write.json().code).toBe('ROLE_DENIED');
  });

  it('an anonymous caller reaches neither', async () => {
    expect((await api().inject({ method: 'GET', url: '/v1/cms/areas' })).statusCode).toBe(401);
  });
});

describe('#425 audit', () => {
  it('records which fields an editor claimed, not just that a write happened', async () => {
    const place = await makePlace();
    await patch(place.id, { phone: '0283 822 9999', district: 'Quận 1' });

    const rows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, place.id))
      .orderBy(asc(schema.auditLogs.createdAt));
    const entry = rows.find((r) => r.action === 'place.updated');
    expect(entry).toBeDefined();
    expect((entry!.diff as { claimedFields: string[] }).claimedFields.sort()).toEqual([
      'district',
      'phone',
    ]);
  });
});

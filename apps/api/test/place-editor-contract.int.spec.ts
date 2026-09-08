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
import { PLACE_PROVIDER } from '@gogo/providers';

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
/**
 * The fake bound in test: `seed()` decides what a link resolves to,
 * `tiersRequested` is what a flow would have been billed for, and `failing`
 * models a provider that is up but not answering.
 */
let places: {
  seed: (p: Record<string, unknown>) => void;
  tiersRequested: string[];
  failing: boolean;
};

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
  places = app.get(PLACE_PROVIDER);
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

/**
 * GoGo-BE#452 — manual creation.
 *
 * Until this endpoint existed a place could only arrive through bulk import or
 * a community submission, so an editor holding a menu and a phone number had
 * nowhere to put it, and the console shipped its "Thêm địa điểm" button
 * visibly disabled (GoGo-CMS#128).
 */
const create = (payload: Record<string, unknown>, token = editor.token) =>
  api().inject({ method: 'POST', url: '/v1/cms/places', headers: auth(token), payload });

describe('#452 create a place by hand', () => {
  it('creates a draft and returns the record the editor screen loads', async () => {
    const res = await create({
      name: `Quán Mới ${Date.now()}`,
      lat: 10.7769,
      lng: 106.7009,
      district: 'Quận 1',
      phone: '0283 822 9999',
      avgVisitMinutes: 60,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('draft');
    // Normalised on the way in, exactly as an edit would be.
    expect(body.phone).toBe('+842838229999');
    expect(body.avgVisitMinutes).toBe(60);

    // The body is the same shape the editor screen already reads.
    const loaded = await detail(body.id);
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().name).toBe(body.name);
  });

  it('never creates a published place, even if asked', async () => {
    const res = await create({
      name: `Quán Ẩn ${Date.now()}`,
      lat: 10.78,
      lng: 106.71,
      status: 'published',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('draft');
  });

  it('requires a name and a position — the three things the catalogue is for', async () => {
    const res = await create({ description: 'không tên, không toạ độ' });

    expect(res.statusCode).toBe(400);
    const fields = res.json().field_errors.map((e: { field: string }) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'lat', 'lng']));
  });

  it('reports a bad phone against its own field rather than as a toast', async () => {
    const res = await create({
      name: `Quán Sai ${Date.now()}`,
      lat: 10.9,
      lng: 106.9,
      phone: '38229999',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0]).toMatchObject({ field: 'phone' });
  });

  it('refuses a near-duplicate and names the candidates', async () => {
    const name = `Cà Phê Trùng ${Date.now()}`;
    const first = await create({ name, lat: 10.762, lng: 106.682 });
    expect(first.statusCode).toBe(201);

    // Same name, 20-odd metres away: the shape of an accidental re-entry.
    const second = await create({ name, lat: 10.7622, lng: 106.6821 });

    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.code).toBe('PLACE_DUPLICATE_SUSPECTED');
    // The console needs enough to draw its merge screen: which place, how far.
    expect(body.field_errors[0].message).toContain(name);
    expect(body.field_errors[0].message).toMatch(/\dm\)/);
  });

  it('creates anyway when the editor says they are different places', async () => {
    const name = `Bún Chuỗi ${Date.now()}`;
    await create({ name, lat: 10.771, lng: 106.691 });

    const second = await create({ name, lat: 10.7711, lng: 106.6911, allowDuplicate: true });

    expect(second.statusCode).toBe(201);
  });

  it('records every typed field as the editor’s own claim', async () => {
    const res = await create({
      name: `Quán Ghi Nguồn ${Date.now()}`,
      lat: 10.8,
      lng: 106.72,
      website: 'quanghinguon.vn',
      areaKey: 'hcm_q3',
    });
    const placeId = res.json().id;

    const provenance = await db
      .select()
      .from(schema.placeFieldProvenance)
      .where(eq(schema.placeFieldProvenance.placeId, placeId));
    expect(provenance.length).toBeGreaterThan(0);
    // Never `google_derived`: typing a value read off a preview does not make
    // it provider data (GOGO_PRODUCT_DATA_ARCHITECTURE.md).
    expect(provenance.every((row) => row.sourceType === 'editorial')).toBe(true);

    const audit = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, placeId));
    expect(audit.some((row) => row.action === 'place.created')).toBe(true);
  });

  it('is closed to a moderator, who does not edit the catalogue', async () => {
    const moderator = await createAdmin(`pe-mod-${Date.now()}@gogo.local`, 'moderator');
    const res = await create({ name: 'Quán Cấm', lat: 10.7, lng: 106.7 }, moderator.token);

    expect(res.statusCode).toBe(403);
  });
});

/**
 * PI-BE-020 (#465) — add by Google Maps link.
 *
 * The create form used to ask an editor for a latitude. Coordinates typed by
 * hand are the single most reliable way to get a place wrong, and a place
 * entered that way carries no Google Place ID — so it sits outside provider
 * dedup, and nothing can ever refresh it. The link the editor already has in
 * their clipboard answers both.
 */
const resolveLink = (payload: Record<string, unknown>, token = editor.token) =>
  api().inject({
    method: 'POST',
    url: '/v1/cms/places/resolve-link',
    remoteAddress: ip(),
    headers: auth(token),
    payload,
  });

describe('#465 add a place by Google Maps link', () => {
  it('resolves a link to the place it names', async () => {
    places.seed({
      providerPlaceId: 'ChIJcmslink',
      name: 'Cà Phê Bên Đường',
      addressText: '9 Nguyễn Huệ, Quận 1, Hồ Chí Minh',
      lat: 10.7743,
      lng: 106.7038,
      rating: 4.4,
      ratingCount: 88,
    });

    const res = await resolveLink({ url: 'https://www.google.com/maps?place_id=ChIJcmslink' });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('RESOLVED');
    expect(body.candidate.name).toBe('Cà Phê Bên Đường');
    expect(body.candidate.location).toMatchObject({ lat: 10.7743, lng: 106.7038 });
    // Shown so the editor can tell two branches of a chain apart, and — since
    // PI-BE-021 — stored as the provider's own figure when the place is created
    // (ADR-0020). It is never GoGo's rating and never averaged with one.
    expect(body.candidate.googleRating).toBe(4.4);
    expect(body.candidate.attributions.length).toBeGreaterThan(0);
  });

  it('is closed to a moderator, who does not spend the provider budget', async () => {
    const moderator = await createAdmin(`pe-link-mod-${Date.now()}@gogo.local`, 'moderator');
    const res = await resolveLink(
      { url: 'https://www.google.com/maps?place_id=ChIJcmslink' },
      moderator.token,
    );

    expect(res.statusCode).toBe(403);
  });

  it('refuses a host that only looks like Google, without asking the provider', async () => {
    const res = await resolveLink({ url: 'https://maps.google.com.evil.example/?place_id=x' });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('UNRESOLVED');
  });

  /**
   * #469 — three places inside one tower are three places, and the matcher is
   * right to refuse to pick. What was missing was any way for the person to.
   */
  it('resolves the branch the editor picked', async () => {
    places.seed({
      providerPlaceId: 'ChIJbranchB',
      name: 'CGV Vincom Center Landmark 81',
      addressText: 'Tầng B1, 772 Điện Biên Phủ, Hồ Chí Minh',
      lat: 10.7949,
      lng: 106.7219,
      rating: 4.1,
      ratingCount: 512,
    });

    const res = await resolveLink({ googlePlaceId: 'ChIJbranchB' });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('RESOLVED');
    expect(body.candidate.name).toBe('CGV Vincom Center Landmark 81');
    expect(body.candidate.googlePlaceId).toBe('ChIJbranchB');
  });

  it('answers a chosen branch GoGo already holds without paying Google', async () => {
    const googlePlaceId = `ChIJchosen${Date.now()}`;
    const created = await create({
      name: 'Chi Nhánh Đã Có',
      lat: 10.7948,
      lng: 106.7218,
      googlePlaceId,
    });
    expect(created.statusCode).toBe(201);

    const res = await resolveLink({ googlePlaceId });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('ALREADY_EXISTS');
    expect(body.existingPlaceId).toBe(created.json().id);
    // The same answer the link path gives for the same id — a place that opens
    // from a pasted link must not duplicate from a chosen one.
    expect(body.reasonCodes).toContain('DB_FIRST');
  });

  it('does not answer two questions, or none', async () => {
    const both = await resolveLink({
      url: 'https://www.google.com/maps?place_id=ChIJbranchB',
      googlePlaceId: 'ChIJbranchB',
    });
    expect(both.statusCode).toBe(400);

    const neither = await resolveLink({});
    expect(neither.statusCode).toBe(400);
  });

  it('says so plainly when the chosen id names nothing', async () => {
    const res = await resolveLink({ googlePlaceId: 'ChIJnothinghere' });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('UNRESOLVED');
  });

  it('links the Google record and marks the applied fields as its own', async () => {
    const googlePlaceId = `ChIJapply${Date.now()}`;
    const res = await create({
      name: 'Nhà Hàng Từ Link',
      lat: 10.7801,
      lng: 106.6991,
      addressText: '44 Lê Lợi, Quận 1',
      // Not from the preview — the editor rang them.
      phone: '0283 822 1111',
      googlePlaceId,
      googleDerivedFields: ['name', 'addressText', 'lat', 'lng'],
    });
    expect(res.statusCode).toBe(201);
    const placeId = res.json().id;

    // The link is what puts the place inside provider dedup at all.
    const sources = await db
      .select()
      .from(schema.placeSources)
      .where(eq(schema.placeSources.placeId, placeId));
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ provider: 'google', externalId: googlePlaceId });

    const provenance = await db
      .select()
      .from(schema.placeFieldProvenance)
      .where(eq(schema.placeFieldProvenance.placeId, placeId));
    const byField = new Map(provenance.map((row) => [row.field, row]));

    for (const field of ['name', 'address_text', 'geom']) {
      expect(byField.get(field)).toMatchObject({
        sourceType: 'google_derived',
        sourceReference: googlePlaceId,
      });
    }
    // Typed, not applied. Copying does not transfer ownership either way.
    expect(byField.get('phone')).toMatchObject({ sourceType: 'editorial', sourceReference: null });
  });

  it('records the position once, not once per coordinate', async () => {
    const res = await create({
      name: `Quán Một Toạ Độ ${Date.now()}`,
      lat: 10.7402,
      lng: 106.7211,
      googlePlaceId: `ChIJgeom${Date.now()}`,
      googleDerivedFields: ['lat', 'lng'],
    });
    expect(res.statusCode).toBe(201);

    const provenance = await db
      .select()
      .from(schema.placeFieldProvenance)
      .where(eq(schema.placeFieldProvenance.placeId, res.json().id));
    expect(provenance.filter((row) => row.field === 'geom')).toHaveLength(1);
  });

  it('records a retyped value as the editor’s own, not Google’s', async () => {
    const googlePlaceId = `ChIJretyped${Date.now()}`;
    const res = await create({
      name: 'Tên Editor Tự Gõ',
      lat: 10.75,
      lng: 106.66,
      googlePlaceId,
      // The editor changed the name Google gave, so it left the list.
      googleDerivedFields: ['lat', 'lng'],
    });
    expect(res.statusCode).toBe(201);

    const provenance = await db
      .select()
      .from(schema.placeFieldProvenance)
      .where(eq(schema.placeFieldProvenance.placeId, res.json().id));
    const byField = new Map(provenance.map((row) => [row.field, row]));
    expect(byField.get('name')).toMatchObject({ sourceType: 'editorial' });
    expect(byField.get('geom')).toMatchObject({ sourceType: 'google_derived' });
  });

  it('refuses a second place for one Google record, and names the first', async () => {
    const googlePlaceId = `ChIJonce${Date.now()}`;
    const first = await create({
      name: 'Quán Đã Có',
      lat: 10.79,
      lng: 106.68,
      googlePlaceId,
    });
    expect(first.statusCode).toBe(201);

    // Far away and differently named: the similarity check would let this
    // through. Identity is the thing that must not be duplicated.
    const second = await create({
      name: 'Một Cái Tên Hoàn Toàn Khác',
      lat: 21.0285,
      lng: 105.8542,
      googlePlaceId,
    });

    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.code).toBe('PLACE_ALREADY_LINKED');
    expect(body.field_errors[0].message).toBe(first.json().id);
  });

  it('does not let allowDuplicate open the identity gate', async () => {
    const googlePlaceId = `ChIJforce${Date.now()}`;
    await create({ name: 'Quán Gốc', lat: 10.72, lng: 106.64, googlePlaceId });

    const second = await create({
      name: 'Quán Gốc',
      lat: 10.72,
      lng: 106.64,
      googlePlaceId,
      allowDuplicate: true,
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('PLACE_ALREADY_LINKED');
  });

  it('refuses provenance that points at no Google record', async () => {
    const res = await create({
      name: `Quán Không Nguồn ${Date.now()}`,
      lat: 10.73,
      lng: 106.65,
      googleDerivedFields: ['name'],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors.map((e: { field: string }) => e.field)).toContain(
      'googlePlaceId',
    );
  });

  it('still creates a place with no link at all', async () => {
    const res = await create({ name: `Quán Không Google ${Date.now()}`, lat: 10.71, lng: 106.63 });

    expect(res.statusCode).toBe(201);
    const sources = await db
      .select()
      .from(schema.placeSources)
      .where(eq(schema.placeSources.placeId, res.json().id));
    expect(sources).toHaveLength(0);
  });
});

/**
 * PI-BE-021 (#501) — the rest of the answer GoGo already paid for.
 *
 * The resolve fetches Place Details at `quality`; the candidate published four
 * of its fields and threw away the canonical link, the week, the price level
 * and the types. So a place created from a link had a name, an address and a
 * coordinate, and Place Detail came back missing exactly what the editor had
 * been shown a moment earlier.
 */
describe('#501 a link fills and keeps every compatible field', () => {
  const seedRich = (providerPlaceId: string, overrides: Record<string, unknown> = {}) =>
    places.seed({
      providerPlaceId,
      name: 'Lacaph Coffee',
      addressText: '35 Nguyễn Trãi, Phường Bến Thành, Hồ Chí Minh',
      lat: 10.7712,
      lng: 106.6903,
      rating: 4.6,
      ratingCount: 1234,
      priceLevel: 2,
      primaryType: 'coffee_shop',
      types: ['coffee_shop', 'cafe', 'food', 'point_of_interest'],
      googleMapsUri: `https://maps.google.com/?cid=${providerPlaceId}`,
      hours: [
        { dayOfWeek: 1, openMinute: 420, closeMinute: 1320, isOvernight: false },
        { dayOfWeek: 2, openMinute: 420, closeMinute: 1320, isOvernight: false },
        { dayOfWeek: 6, openMinute: 1200, closeMinute: 120, isOvernight: true },
      ],
      ...overrides,
    });

  it('publishes every field the same Details response already carried', async () => {
    // `categoryKey` is checked against the live taxonomy, not just proposed
    // from the static type table — so the vocabulary has to exist.
    await db
      .insert(schema.taxonomies)
      .values({ kind: 'category', key: 'cafe' })
      .onConflictDoNothing();
    seedRich('ChIJrich001');

    const before = places.tiersRequested.length;
    const res = await resolveLink({ url: 'https://www.google.com/maps?place_id=ChIJrich001' });
    expect(res.statusCode).toBe(201);
    const candidate = res.json().candidate;

    expect(candidate.googleMapsUri).toBe('https://maps.google.com/?cid=ChIJrich001');
    expect(candidate.priceLevel).toBe(2);
    expect(candidate.primaryType).toBe('coffee_shop');
    expect(candidate.types).toContain('coffee_shop');
    // `coffee_shop` maps to the `cafe` taxonomy key, which the seeded catalog
    // carries. A key the catalog did not have would be dropped, not offered.
    expect(candidate.categoryKey).toBe('cafe');
    expect(candidate.openingHours).toEqual([
      { dayOfWeek: 1, openMinute: 420, closeMinute: 1320, isOvernight: false },
      { dayOfWeek: 2, openMinute: 420, closeMinute: 1320, isOvernight: false },
      { dayOfWeek: 6, openMinute: 1200, closeMinute: 120, isOvernight: true },
    ]);

    // The whole point: one Details call, the same one as before this change.
    expect(places.tiersRequested.length - before).toBe(1);
    expect(places.tiersRequested.at(-1)).toBe('quality');
  });

  it('leaves an optional the provider does not publish null, never zero', async () => {
    places.seed({
      providerPlaceId: 'ChIJsparse001',
      name: 'Quán Không Đánh Giá',
      lat: 10.78,
      lng: 106.69,
      rating: null,
      ratingCount: 0,
      priceLevel: null,
      primaryType: null,
      types: [],
      googleMapsUri: null,
      hours: [],
    });

    const res = await resolveLink({ url: 'https://www.google.com/maps?place_id=ChIJsparse001' });
    const candidate = res.json().candidate;

    expect(candidate.googleRating).toBeNull();
    expect(candidate.googleMapsUri).toBeNull();
    expect(candidate.priceLevel).toBeNull();
    expect(candidate.primaryType).toBeNull();
    // No category to propose is an answer, not a failure.
    expect(candidate.categoryKey).toBeNull();
    // An empty week means "the provider publishes none" — never "closed".
    expect(candidate.openingHours).toEqual([]);
  });

  it('never mistakes the submitted short link for the canonical one', async () => {
    seedRich('ChIJshort001', { googleMapsUri: 'https://maps.google.com/?cid=ChIJshort001' });

    const res = await resolveLink({
      url: 'https://www.google.com/maps?place_id=ChIJshort001&utm_source=share',
    });

    // What Google published, not what was pasted.
    expect(res.json().candidate.googleMapsUri).toBe('https://maps.google.com/?cid=ChIJshort001');
  });

  it('stores the provider facts on the place it creates, and returns them again', async () => {
    const googlePlaceId = `ChIJkeep${Date.now()}`;
    seedRich(googlePlaceId);

    const created = await create({
      name: 'Lacaph Coffee',
      addressText: '35 Nguyễn Trãi, Phường Bến Thành, Hồ Chí Minh',
      lat: 10.7712,
      lng: 106.6903,
      googlePlaceId,
      googleDerivedFields: ['name', 'addressText', 'lat', 'lng'],
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    const placeId = body.id;

    // The create response and Place Detail are the same document; asserting
    // both is what catches a value that exists only in one of them.
    for (const view of [body, (await detail(placeId)).json()]) {
      expect(view.ratings.provider).toMatchObject({ rating: 4.6, count: 1234 });
      // GoGo's own rating is a different population and stays empty.
      expect(view.ratings.gogo.rating).toBeUndefined();
      expect(view.priceLevel).toBe(2);
      expect(view.hours).toHaveLength(3);
      expect(view.hours.every((h: { source: string }) => h.source === 'provider')).toBe(true);
      expect(view.hours[0]).toMatchObject({ dayOfWeek: 1, openMinute: 420, closeMinute: 1320 });
      // The canonical Google link, on the source row that owns provenance.
      const google = view.sources.find(
        (s: { externalId: string }) => s.externalId === googlePlaceId,
      );
      expect(google.url).toBe(`https://maps.google.com/?cid=${googlePlaceId}`);
      expect(google.attribution).toBeTruthy();
    }

    const [source] = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.externalId, googlePlaceId));
    expect(source).toMatchObject({
      providerUri: `https://maps.google.com/?cid=${googlePlaceId}`,
      ratingCount: 1234,
      primaryType: 'coffee_shop',
      fetchTier: 'quality',
    });
  });

  it('creates the place anyway when the provider cannot answer', async () => {
    const googlePlaceId = `ChIJdown${Date.now()}`;
    // Seeded, then made unreachable: the id is real, the provider is not up.
    seedRich(googlePlaceId);
    places.failing = true;
    try {
      const created = await create({
        name: 'Quán Khi Google Sập',
        lat: 10.7688,
        lng: 106.6812,
        googlePlaceId,
      });
      expect(created.statusCode).toBe(201);
      const view = created.json();
      // No provider facts — and no invented ones.
      expect(view.ratings.provider.rating).toBeUndefined();
      expect(view.hours).toEqual([]);
      // The identity is still stored: that is what dedup and refresh need.
      const sources = await db
        .select()
        .from(schema.placeSources)
        .where(eq(schema.placeSources.placeId, view.id));
      expect(sources[0]).toMatchObject({ externalId: googlePlaceId });
    } finally {
      places.failing = false;
    }
  });

  it('stores nothing from the provider for a place created without a link', async () => {
    const created = await create({
      name: `Quán Tự Gõ ${Date.now()}`,
      lat: 10.7501,
      lng: 106.6601,
    });
    expect(created.statusCode).toBe(201);
    const view = created.json();
    expect(view.ratings.provider.rating).toBeUndefined();
    expect(view.hours).toEqual([]);
    expect(view.sources).toEqual([]);
  });
});

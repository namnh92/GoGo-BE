import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import argon2 from 'argon2';
import { and, eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { PLACE_PROVIDER } from '@gogo/providers';

/**
 * GoGo-BE#440 — creating a place from the CMS, against the SA shape
 * (`dev/handoffs/codex-review-request-sa-GoGo-BE-440.sa.out`).
 *
 * Four of these are regressions with a FAIL on `origin/develop` @aba5fb7
 * recorded before the fix (marked `FAIL-before`): provider content persisted on
 * create, a Google-derived declaration accepted, duplicate candidates without
 * ids, and the two post-commit gaps — an audit failure that left a place, and
 * a replay-completion failure that let a retry create a second one.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let places: {
  seed: (p: Record<string, unknown> & { providerPlaceId: string }) => void;
  tiersRequested: string[];
  searches: unknown[];
  identitySearches: unknown[];
};

function api() {
  return app.getHttpAdapter().getInstance();
}
let ipc = 0;
const ip = () => `10.61.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const uniq = () => randomUUID().slice(0, 8);

type Role = 'editor' | 'moderator' | 'ops_admin' | 'super_admin';
async function createAdmin(role: Role, email = `c440-${role}-${uniq()}@gogo.local`) {
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  const [row] = await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: role, role })
    .returning();
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return { id: row!.id, token: res.json().accessToken as string };
}

/** A body that covers its own evidence. */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: `Quán 440 ${uniq()}`,
    lat: 10.7769,
    lng: 106.7009,
    sourceReferences: { name: 'thực đơn tại quán', geom: 'khảo sát thực địa 2026-10-01' },
  };
  return { ...base, ...over };
}

function create(
  payload: Record<string, unknown>,
  token: string,
  key: string | null = randomUUID(),
) {
  return api().inject({
    method: 'POST',
    url: '/v1/cms/places',
    remoteAddress: ip(),
    headers: { ...auth(token), ...(key === null ? {} : { 'idempotency-key': key }) },
    payload,
  });
}

async function placesNamed(name: string) {
  return db.select().from(schema.places).where(eq(schema.places.name, name));
}

let editor: { id: string; token: string };
/** Rotated so the route's 20/minute per-actor limit never decides an unrelated test. */
let pooled: { id: string; token: string } | undefined;
let pooledUses = 0;
const tok = async () => (await anEditor()).token;
async function anEditor() {
  if (!pooled || pooledUses >= 3) {
    pooled = await createAdmin('editor');
    pooledUses = 0;
  }
  pooledUses += 1;
  return pooled;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cms_place_create_test')
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

  editor = await createAdmin('editor');
  places = app.get(PLACE_PROVIDER);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('#440 manual creation', () => {
  it('creates a draft with editorial provenance, its event and its audit, and asks no provider', async () => {
    const before = {
      details: places.tiersRequested.length,
      searches: places.searches.length + places.identitySearches.length,
    };
    const res = await create(
      body({
        lat: 10.701,
        lng: 106.601,
        phone: '0283 822 9999',
        description: null,
        sourceReferences: {
          name: 'biển hiệu, ảnh 2026-10-01',
          geom: 'khảo sát thực địa',
          phone: 'gọi xác nhận 2026-10-01',
        },
      }),
      editor.token,
    );
    expect(res.statusCode, res.body).toBe(201);
    const place = res.json();
    expect(place.status).toBe('draft');

    // Zero provider calls on the manual path.
    expect(places.tiersRequested.length).toBe(before.details);
    expect(places.searches.length + places.identitySearches.length).toBe(before.searches);

    const provenance = await db
      .select()
      .from(schema.placeFieldProvenance)
      .where(eq(schema.placeFieldProvenance.placeId, place.id));
    const byField = new Map(provenance.map((r) => [r.field, r]));
    // `description: null` is not a fact, so it needs and gets no row.
    expect([...byField.keys()].sort()).toEqual(['geom', 'name', 'phone']);
    expect(byField.get('phone')).toMatchObject({
      sourceType: 'editorial',
      sourceReference: 'gọi xác nhận 2026-10-01',
      actorId: editor.id,
    });
    expect(byField.get('geom')).toMatchObject({ sourceReference: 'khảo sát thực địa' });

    const [event] = await db
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.resourceId, place.id),
          eq(schema.outboxEvents.eventType, 'place.created'),
        ),
      );
    expect(event).toMatchObject({ actorId: editor.id });
    expect(event!.correlationId).toBeTruthy();
    expect(event!.payload).toEqual({ status: 'draft', origin: 'cms_manual' });

    const [audit] = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.resourceId, place.id),
          eq(schema.auditLogs.action, 'place.created'),
        ),
      );
    expect(audit).toMatchObject({ actorId: editor.id, actorType: 'admin' });
    expect(audit!.requestId).toBeTruthy();
    const diff = audit!.diff as Record<string, unknown>;
    expect(diff).toMatchObject({ origin: 'cms_manual', allowDuplicate: false });
    expect((diff.claimedFields as string[]).sort()).toEqual(['geom', 'name', 'phone']);
    // No raw coordinates and no payload in the audit line.
    expect(JSON.stringify(diff)).not.toContain('10.701');
    expect(diff).not.toHaveProperty('sourceReferences');
  });

  it('is invisible to consumers while it is a draft', async () => {
    const name = `Quán Nháp Ẩn ${uniq()}`;
    const res = await create(body({ name, lat: 10.702, lng: 106.602 }), await tok());
    expect(res.statusCode).toBe(201);

    const detail = await api().inject({ method: 'GET', url: `/v1/places/${res.json().id}` });
    expect(detail.statusCode).toBe(404);
    const search = await api().inject({
      method: 'GET',
      url: `/v1/places/search?q=${encodeURIComponent(name)}`,
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().results.map((r: { name: string }) => r.name)).not.toContain(name);
  });

  it('cannot be published straight from draft, nor while UNMAPPED', async () => {
    const res = await create(body({ lat: 10.703, lng: 106.603 }), await tok());
    const id = res.json().id as string;

    const direct = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${id}/status`,
      headers: auth(editor.token),
      payload: { status: 'published' },
    });
    expect(direct.statusCode).toBe(409);

    const review = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${id}/status`,
      headers: auth(editor.token),
      payload: { status: 'review' },
    });
    expect(review.statusCode).toBe(200);
    // No published administrative dataset here, so the mapping gate refuses.
    const publish = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${id}/status`,
      headers: auth(editor.token),
      payload: { status: 'published' },
    });
    expect(publish.statusCode).toBeGreaterThanOrEqual(400);
    const [row] = await db.select().from(schema.places).where(eq(schema.places.id, id));
    expect(row!.status).toBe('review');
  });
});

describe('#440 field boundaries and evidence coverage', () => {
  const at = (n: number) => ({ lat: 10.71 + n * 0.01, lng: 106.61 + n * 0.01 });

  it('accepts the edges and refuses one past them', async () => {
    const e = await anEditor();
    const ok = [
      body({ name: 'A'.repeat(200), ...at(1) }),
      body({ lat: 90, lng: 180 }),
      body({ lat: -90, lng: -180 }),
      body({
        ...at(2),
        sourceReferences: { name: 'x'.repeat(500), geom: 'y' },
      }),
    ];
    for (const payload of ok) {
      const res = await create({ ...payload, allowDuplicate: true }, e.token);
      expect(res.statusCode, res.body).toBe(201);
    }

    const e2 = await anEditor();
    const bad: [Record<string, unknown>, string][] = [
      [body({ name: 'A'.repeat(201) }), 'name'],
      [body({ name: '   ' }), 'name'],
      [body({ lat: 90.0001 }), 'lat'],
      [body({ lng: -180.0001 }), 'lng'],
      [body({ sourceReferences: { name: 'x'.repeat(501), geom: 'y' } }), 'sourceReferences.name'],
      [body({ sourceReferences: { name: '   ', geom: 'y' } }), 'sourceReferences.name'],
      [body({ sourceReferences: { name: 'a', geom: 'b', rating: 'c' } }), 'sourceReferences'],
    ];
    for (const [payload, field] of bad) {
      const res = await create(payload, e2.token);
      expect(res.statusCode, `${field}: ${res.body}`).toBe(400);
      const fields = res.json().field_errors.map((f: { field: string }) => f.field);
      expect(
        fields.some((f: string) => f.startsWith(field)),
        `${field} in ${fields}`,
      ).toBe(true);
    }
  });

  it('requires sourceReferences at all', async () => {
    const { sourceReferences: _omit, ...rest } = body(at(3));
    void _omit;
    const res = await create(rest, await tok());
    expect(res.statusCode).toBe(400);
    // F-02: the documented code, not a generic validation failure.
    expect(res.json().code).toBe('SOURCE_REFERENCE_INVALID');
    expect(
      res
        .json()
        .field_errors.map((f: { field: string }) => f.field)
        .sort(),
    ).toEqual(['sourceReferences.geom', 'sourceReferences.name']);
  });

  it('F-02: answers unknown, overlong and blank references with SOURCE_REFERENCE_INVALID', async () => {
    const cases: [Record<string, string>, string, string][] = [
      [{ name: 'a', geom: 'b', rating: 'c' }, 'sourceReferences.rating', 'unknown'],
      [{ name: 'x'.repeat(501), geom: 'b' }, 'sourceReferences.name', 'too_long'],
      [{ name: '   ', geom: 'b' }, 'sourceReferences.name', 'required'],
    ];
    const who = await tok();
    for (const [refs, field, code] of cases) {
      const res = await create(body({ ...at(6), sourceReferences: refs }), who);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().code).toBe('SOURCE_REFERENCE_INVALID');
      expect(res.json().field_errors).toEqual([expect.objectContaining({ field, code })]);
    }
  });

  it('F-01: administrative codes and categories are facts that need their own evidence', async () => {
    const [taxonomy] = await db
      .insert(schema.taxonomies)
      .values({ kind: 'category', key: `c440-${uniq()}` })
      .returning();
    const missing = await create(
      body({ ...at(7), provinceCode: '79', communeCode: '26734', taxonomyIds: [taxonomy!.id] }),
      await tok(),
    );
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('SOURCE_REFERENCE_INVALID');
    expect(
      missing
        .json()
        .field_errors.map((f: { field: string }) => f.field)
        .sort(),
    ).toEqual([
      'sourceReferences.communeCode',
      'sourceReferences.provinceCode',
      'sourceReferences.taxonomyIds',
    ]);

    // An empty category list asserts nothing and needs nothing.
    const none = await create(body({ ...at(8), taxonomyIds: [] }), await tok());
    expect(none.statusCode, none.body).toBe(201);

    const claimed = await create(
      body({
        ...at(9),
        taxonomyIds: [taxonomy!.id],
        sourceReferences: { name: 'menu', geom: 'khảo sát', taxonomyIds: 'thực đơn: cà phê' },
      }),
      await tok(),
    );
    expect(claimed.statusCode, claimed.body).toBe(201);
    expect(claimed.json().provenance.taxonomyIds).toMatchObject({
      sourceType: 'editorial',
      sourceReference: 'thực đơn: cà phê',
    });
  });

  it('names every supplied fact without a reference, and every reference without a fact', async () => {
    const res = await create(
      body({
        ...at(4),
        phone: '0283 822 1234',
        addressText: '1 Lê Lợi',
        sourceReferences: { name: 'menu', geom: 'khảo sát', website: 'không có website' },
      }),
      await tok(),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('SOURCE_REFERENCE_INVALID');
    const errors = res.json().field_errors as { field: string; code: string }[];
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'sourceReferences.phone', code: 'required' }),
        expect.objectContaining({ field: 'sourceReferences.addressText', code: 'required' }),
        expect.objectContaining({ field: 'sourceReferences.website', code: 'unused' }),
      ]),
    );
    expect(errors).toHaveLength(3);
  });

  it('demands geom and name evidence even when the body carries nothing else', async () => {
    const res = await create(body({ ...at(5), sourceReferences: { name: 'menu' } }), await tok());
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors).toEqual([
      expect.objectContaining({ field: 'sourceReferences.geom', code: 'required' }),
    ]);
  });
});

describe('#440 link creation — identity only', () => {
  it('FAIL-before: stores the Google identity and no provider content, without calling the provider', async () => {
    const googlePlaceId = `ChIJ440keep${uniq()}`;
    places.seed({
      providerPlaceId: googlePlaceId,
      name: 'Lacaph Coffee',
      lat: 10.7712,
      lng: 106.6903,
      rating: 4.6,
      ratingCount: 1234,
      priceLevel: 2,
      googleMapsUri: `https://maps.google.com/?cid=${googlePlaceId}`,
      hours: [{ dayOfWeek: 1, openMinute: 420, closeMinute: 1320, isOvernight: false }],
    });
    const before = places.tiersRequested.length;

    const res = await create(
      body({ name: 'Lacaph Coffee 440', lat: 10.7712, lng: 106.6903, googlePlaceId }),
      await tok(),
    );
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json();

    expect(places.tiersRequested.length).toBe(before);
    expect(view.ratings.provider.rating).toBeUndefined();
    expect(view.priceLevel ?? null).toBeNull();
    expect(view.hours).toEqual([]);

    const [row] = await db.select().from(schema.places).where(eq(schema.places.id, view.id));
    expect(row!.rating).toBeNull();
    expect(row!.ratingCount ?? 0).toBe(0);
    const providerRows = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.placeId, view.id));
    expect(providerRows).toEqual([]);
    const hours = await db
      .select()
      .from(schema.placeHours)
      .where(eq(schema.placeHours.placeId, view.id));
    expect(hours).toEqual([]);

    const sources = await db
      .select()
      .from(schema.placeSources)
      .where(eq(schema.placeSources.placeId, view.id));
    expect(sources).toEqual([
      expect.objectContaining({ provider: 'google', externalId: googlePlaceId }),
    ]);
    const [event] = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.resourceId, view.id));
    expect(event!.payload).toEqual({ status: 'draft', origin: 'cms_link' });
  });

  it('FAIL-before: refuses fields declared as applied from the Google preview', async () => {
    const googlePlaceId = `ChIJ440derived${uniq()}`;
    const name = `Tên Từ Google ${uniq()}`;
    const res = await create(
      body({
        name,
        lat: 10.76,
        lng: 106.67,
        googlePlaceId,
        googleDerivedFields: ['lat', 'lng'],
      }),
      await tok(),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('GOOGLE_CONTENT_NOT_PERSISTABLE');
    expect(await placesNamed(name)).toHaveLength(0);
  });

  it('accepts an empty googleDerivedFields', async () => {
    const res = await create(
      body({ lat: 10.761, lng: 106.671, googleDerivedFields: [] }),
      await tok(),
    );
    expect(res.statusCode).toBe(201);
  });

  it('never stores a link preview for replay', async () => {
    places.seed({ providerPlaceId: 'ChIJ440preview', name: 'Preview', lat: 10.7, lng: 106.7 });
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/places/resolve-link',
      remoteAddress: ip(),
      headers: { ...auth(editor.token), 'idempotency-key': `preview-${uniq()}` },
      payload: { googlePlaceId: 'ChIJ440preview' },
    });
    expect(res.statusCode).toBe(201);
    const stored = await db
      .select()
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.endpoint, 'POST /v1/cms/places/resolve-link'));
    expect(stored).toEqual([]);
  });

  it('answers a concurrent race for one Google record with one place and 409s', async () => {
    const googlePlaceId = `ChIJ440race${uniq()}`;
    const racers = await Promise.all([0, 1, 2, 3].map(() => anEditor()));
    const results = await Promise.all(
      racers.map((who, i) =>
        create(
          body({
            name: `Đua ${i} ${uniq()}`,
            lat: 11 + i * 0.5,
            lng: 107 + i * 0.5,
            googlePlaceId,
          }),
          who.token,
        ),
      ),
    );
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses, results.map((r) => r.body).join('\n')).toEqual([201, 409, 409, 409]);
    const winner = results.find((r) => r.statusCode === 201)!.json().id;
    for (const r of results.filter((x) => x.statusCode === 409)) {
      expect(r.json().code).toBe('PLACE_ALREADY_LINKED');
      expect(r.json().field_errors[0].message).toBe(winner);
    }
    const sources = await db
      .select()
      .from(schema.placeSources)
      .where(eq(schema.placeSources.externalId, googlePlaceId));
    expect(sources).toHaveLength(1);
  });
});

describe('#440 duplicate detection', () => {
  it('FAIL-before: names each candidate by id, distance and similarity', async () => {
    const name = `Cà Phê Trùng 440 ${uniq()}`;
    const first = await create(body({ name, lat: 10.81, lng: 106.81 }), await tok());
    expect(first.statusCode).toBe(201);

    const second = await create(body({ name, lat: 10.8102, lng: 106.8101 }), await tok());
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('PLACE_DUPLICATE_SUSPECTED');
    const [entry] = second.json().field_errors;
    expect(entry.candidate).toMatchObject({
      placeId: first.json().id,
      name,
      status: 'draft',
    });
    expect(entry.candidate.distanceM).toBeGreaterThan(0);
    expect(entry.candidate.distanceM).toBeLessThan(150);
    expect(entry.candidate.nameSimilarity).toBeGreaterThan(0.5);
    expect(entry.candidate.nameSimilarity).toBeLessThanOrEqual(1);
    // The human form stays for clients that read it.
    expect(entry.message).toContain(name);
  });

  it('draws the line at 150 m and ignores archived places', async () => {
    const name = `Bún Biên 440 ${uniq()}`;
    const first = await create(body({ name, lat: 10.82, lng: 106.82 }), await tok());
    expect(first.statusCode).toBe(201);
    // ~140 m north: inside. ~170 m north: outside.
    const inside = await create(body({ name, lat: 10.82126, lng: 106.82 }), await tok());
    expect(inside.statusCode).toBe(409);
    const outside = await create(body({ name, lat: 10.82153, lng: 106.82 }), await tok());
    expect(outside.statusCode).toBe(201);

    const archivedName = `Quán Đã Đóng 440 ${uniq()}`;
    const archived = await create(
      body({ name: archivedName, lat: 10.83, lng: 106.83 }),
      await tok(),
    );
    await db
      .update(schema.places)
      .set({ status: 'archived' })
      .where(eq(schema.places.id, archived.json().id));
    const again = await create(body({ name: archivedName, lat: 10.83, lng: 106.83 }), await tok());
    expect(again.statusCode).toBe(201);
  });

  it('creates anyway on an explicit override, and audits it', async () => {
    const name = `Chuỗi 440 ${uniq()}`;
    await create(body({ name, lat: 10.84, lng: 106.84 }), await tok());
    const forced = await create(
      body({ name, lat: 10.8401, lng: 106.8401, allowDuplicate: true }),
      await tok(),
    );
    expect(forced.statusCode).toBe(201);
    const [audit] = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.resourceId, forced.json().id),
          eq(schema.auditLogs.action, 'place.created'),
        ),
      );
    expect(audit!.diff).toMatchObject({ allowDuplicate: true });
  });

  it('does not let the override open the identity gate', async () => {
    const googlePlaceId = `ChIJ440force${uniq()}`;
    await create(body({ lat: 10.85, lng: 106.85, googlePlaceId }), await tok());
    const second = await create(
      body({ lat: 10.85, lng: 106.85, googlePlaceId, allowDuplicate: true }),
      await tok(),
    );
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('PLACE_ALREADY_LINKED');
  });
});

describe('#440 permissions', () => {
  it('lets an editor and the super admin create; nobody else', async () => {
    const boss = await createAdmin('super_admin');
    const moderator = await createAdmin('moderator');
    const ops = await createAdmin('ops_admin');
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: {
        email: `c440-user-${uniq()}@gogo.id.vn`,
        password: 'sufficiently-long-pw',
        displayName: 'U',
      },
    });
    const consumer = reg.json().accessToken as string;

    expect((await create(body({ lat: 10.86, lng: 106.86 }), await tok())).statusCode).toBe(201);
    expect((await create(body({ lat: 10.87, lng: 106.87 }), boss.token)).statusCode).toBe(201);
    expect((await create(body({ lat: 10.88, lng: 106.88 }), moderator.token)).statusCode).toBe(403);
    expect((await create(body({ lat: 10.88, lng: 106.88 }), ops.token)).statusCode).toBe(403);
    expect((await create(body({ lat: 10.88, lng: 106.88 }), consumer)).statusCode).toBe(403);
    const anonymous = await api().inject({
      method: 'POST',
      url: '/v1/cms/places',
      remoteAddress: ip(),
      headers: { 'idempotency-key': randomUUID() },
      payload: body(),
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('#440 retries', () => {
  it('requires an Idempotency-Key', async () => {
    const res = await create(body({ lat: 10.89, lng: 106.89 }), await tok(), null);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('replays the same create once, and refuses the key for a different body', async () => {
    const key = randomUUID();
    const who = await tok();
    const payload = body({ lat: 10.9, lng: 106.9 });
    const first = await create(payload, who, key);
    expect(first.statusCode).toBe(201);
    const again = await create(payload, who, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['x-idempotent-replay']).toBe('true');
    expect(again.json().id).toBe(first.json().id);
    expect(await placesNamed(payload.name as string)).toHaveLength(1);

    const changed = await create({ ...payload, name: `${payload.name} khác` }, who, key);
    expect(changed.statusCode).toBe(422);
    expect(changed.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('F-04: releases the key when the create is refused, so a corrected retry works', async () => {
    const key = randomUUID();
    const who = await tok();
    const name = `Quán Sửa Lại ${uniq()}`;
    const refused = await create(
      body({
        name,
        lat: 10.91,
        lng: 106.91,
        phone: '1',
        sourceReferences: { name: 'a', geom: 'b' },
      }),
      who,
      key,
    );
    expect(refused.statusCode).toBe(400);

    // Same key, corrected body: a fresh create, not a 422 and not a replay.
    const corrected = await create(
      body({
        name,
        lat: 10.91,
        lng: 106.91,
        phone: '0283 822 4444',
        sourceReferences: { name: 'a', geom: 'b', phone: 'gọi xác nhận' },
      }),
      who,
      key,
    );
    expect(corrected.statusCode, corrected.body).toBe(201);
    expect(corrected.headers['x-idempotent-replay']).toBeUndefined();
    expect(await placesNamed(name)).toHaveLength(1);
  });

  it('F-03: takes over an expired key instead of answering it as a reuse', async () => {
    const key = randomUUID();
    const who = await tok();
    const first = await create(body({ lat: 10.94, lng: 106.94 }), who, key);
    expect(first.statusCode).toBe(201);
    await db
      .update(schema.idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.idempotencyKeys.endpoint, 'POST /v1/cms/places'));

    const later = await create(body({ lat: 10.95, lng: 106.95 }), who, key);
    expect(later.statusCode, later.body).toBe(201);
    expect(later.json().id).not.toBe(first.json().id);
  });

  it('F-03: rolls the create back when its claim is lost mid-flight, and the retry creates once', async () => {
    await db.execute(sql`
      create or replace function c440_drop_claims() returns trigger language plpgsql as $$
      begin delete from idempotency_keys where endpoint = 'POST /v1/cms/places'
        and response_status is null; return new; end $$`);
    const name = `Quán Mất Khoá ${uniq()}`;
    await db.execute(
      sql.raw(`create trigger c440_lost before insert on places for each row
        when (new.name = '${name}') execute function c440_drop_claims()`),
    );
    const key = randomUUID();
    const who = await tok();
    const payload = body({ name, lat: 10.96, lng: 106.96 });
    try {
      const lost = await create(payload, who, key);
      expect(lost.statusCode, lost.body).toBe(409);
      expect(lost.json().retryable).toBe(true);
    } finally {
      await db.execute(sql`drop trigger if exists c440_lost on places`);
    }
    expect(await placesNamed(name)).toHaveLength(0);

    const retry = await create(payload, who, key);
    expect(retry.statusCode, retry.body).toBe(201);
    expect(await placesNamed(name)).toHaveLength(1);
  });

  it('F-03: one place for concurrent retries of one key', async () => {
    const key = randomUUID();
    const who = await tok();
    const payload = body({ lat: 10.97, lng: 106.97 });
    const results = await Promise.all([0, 1, 2, 3, 4].map(() => create(payload, who, key)));
    for (const r of results) expect([201, 409], r.body).toContain(r.statusCode);
    const ids = new Set(results.filter((r) => r.statusCode === 201).map((r) => r.json().id));
    expect(ids.size).toBe(1);
    expect(await placesNamed(payload.name as string)).toHaveLength(1);
  });
});

describe('#440 one commit', () => {
  it('FAIL-before: an audit failure leaves no place behind', async () => {
    await db.execute(sql`
      create or replace function c440_refuse() returns trigger language plpgsql as $$
      begin raise exception 'c440 injected failure'; end $$`);
    await db.execute(sql`
      create trigger c440_audit before insert on audit_logs
      for each row when (new.action = 'place.created') execute function c440_refuse()`);
    const name = `Quán Mất Audit ${uniq()}`;
    try {
      const res = await create(body({ name, lat: 10.92, lng: 106.92 }), await tok());
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await db.execute(sql`drop trigger if exists c440_audit on audit_logs`);
    }
    expect(await placesNamed(name)).toHaveLength(0);
  });

  it('FAIL-before: a replay-completion failure never lets the retry create a second place', async () => {
    await db.execute(sql`
      create or replace function c440_refuse() returns trigger language plpgsql as $$
      begin raise exception 'c440 injected failure'; end $$`);
    await db.execute(sql`
      create trigger c440_replay before update on idempotency_keys
      for each row when (old.response_status is null and new.response_status is not null
        and new.endpoint = 'POST /v1/cms/places')
      execute function c440_refuse()`);
    const key = randomUUID();
    const who = await tok();
    const payload = body({ lat: 10.93, lng: 106.93 });
    try {
      const failed = await create(payload, who, key);
      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await db.execute(sql`drop trigger if exists c440_replay on idempotency_keys`);
    }
    const retry = await create(payload, who, key);
    expect(retry.statusCode).toBe(201);
    expect(await placesNamed(payload.name as string)).toHaveLength(1);
  });
});

describe('#440 rate limit', () => {
  it('allows 20 creates a minute per actor, then 429, without touching another actor', async () => {
    const busy = await createAdmin('editor');
    for (let i = 0; i < 20; i += 1) {
      const res = await create(
        body({ lat: 12 + i * 0.01, lng: 108 + i * 0.01, allowDuplicate: true }),
        busy.token,
      );
      expect(res.statusCode, res.body).toBe(201);
    }
    const over = await create(body({ lat: 12.5, lng: 108.5 }), busy.token);
    expect(over.statusCode).toBe(429);

    // resolve-link keeps its own bucket.
    places.seed({ providerPlaceId: 'ChIJ440limit', name: 'Limit', lat: 10.7, lng: 106.7 });
    const resolve = await api().inject({
      method: 'POST',
      url: '/v1/cms/places/resolve-link',
      remoteAddress: ip(),
      headers: auth(busy.token),
      payload: { googlePlaceId: 'ChIJ440limit' },
    });
    expect(resolve.statusCode).toBe(201);

    const other = await createAdmin('editor');
    expect((await create(body({ lat: 12.6, lng: 108.6 }), other.token)).statusCode).toBe(201);
  });
});

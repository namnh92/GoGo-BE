import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import argon2 from 'argon2';
import { and, eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';

/**
 * CMS-001..010 acceptance: RBAC enforced server-side, place workflow +
 * search sync (SRS §15.5), moderation with reasons, four-eyes ranking
 * console, import dry-run, KPIs, append-only audit.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

function api() {
  return app.getHttpAdapter().getInstance();
}
let ipc = 0;
const ip = () => `10.40.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function createAdmin(
  email: string,
  role: 'editor' | 'moderator' | 'ops_admin' | 'super_admin',
) {
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

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cms_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('CMS auth + RBAC (CMS-001, FR-CMS-001, SRS §15.7)', () => {
  it('consumer tokens cannot reach CMS routes even hand-crafted', async () => {
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: { email: 'user@gogo.vn', password: 'sufficiently-long-pw', displayName: 'U' },
    });
    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/places',
      headers: auth(reg.json().accessToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ADMIN_ONLY');
  });

  it('role matrix: editor blocked from ops endpoints; super_admin passes everywhere', async () => {
    const editor = await createAdmin('editor1@gogo.local', 'editor');
    const superAdmin = await createAdmin('super1@gogo.local', 'super_admin');

    const editorOps = await api().inject({
      method: 'GET',
      url: '/v1/cms/ops/kpis',
      headers: auth(editor.token),
    });
    expect(editorOps.statusCode).toBe(403);
    expect(editorOps.json().code).toBe('ROLE_DENIED');

    const superOps = await api().inject({
      method: 'GET',
      url: '/v1/cms/ops/kpis',
      headers: auth(superAdmin.token),
    });
    expect(superOps.statusCode).toBe(200);
  });

  it('suspended admin loses access immediately despite a valid token', async () => {
    const victim = await createAdmin('suspend-me@gogo.local', 'editor');
    await db
      .update(schema.adminUsers)
      .set({ status: 'suspended' })
      .where(eq(schema.adminUsers.id, victim.id));
    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/places',
      headers: auth(victim.token),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('place workflow + search sync (CMS-002, SRS §15.5)', () => {
  it('draft → review → published appears in search; suspended disappears', async () => {
    const editor = await createAdmin('editor2@gogo.local', 'editor');
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'CMS Flow Quán',
        nameNormalized: 'x',
        status: 'draft',
        geom: { x: 106.7, y: 10.77 },
        rating: '4.50',
        ratingCount: 100,
        confidence: '0.9',
        freshnessCheckedAt: new Date(),
      })
      .returning();

    const skip = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${place!.id}/status`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { status: 'published' },
    });
    expect(skip.statusCode).toBe(409); // draft cannot jump straight to published

    for (const status of ['review', 'published']) {
      const res = await api().inject({
        method: 'PATCH',
        url: `/v1/cms/places/${place!.id}/status`,
        remoteAddress: ip(),
        headers: auth(editor.token),
        payload: { status },
      });
      expect(res.statusCode).toBe(200);
    }

    const found = await api().inject({ method: 'GET', url: '/v1/places/search?q=CMS%20Flow' });
    expect(found.json().results.map((r: { name: string }) => r.name)).toContain('CMS Flow Quán');

    await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${place!.id}/status`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { status: 'suspended' },
    });
    const gone = await api().inject({ method: 'GET', url: '/v1/places/search?q=CMS%20Flow' });
    expect(gone.json().results.map((r: { name: string }) => r.name)).not.toContain('CMS Flow Quán');

    // Audit trail records who changed what (SRS §15.8).
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.resourceId, place!.id),
          eq(schema.auditLogs.action, 'place.status_changed'),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(audits[0]!.actorId).toBe(editor.id);
  });

  it('hours/prices/freshness tooling works (CMS-003)', async () => {
    const editor = await createAdmin('editor3@gogo.local', 'editor');
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Hours Place',
        nameNormalized: 'x',
        status: 'published',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();
    const hours = await api().inject({
      method: 'PUT',
      url: `/v1/cms/places/${place!.id}/hours`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        hours: [{ dayOfWeek: 1, openMinute: 480, closeMinute: 1320, isOvernight: false }],
      },
    });
    expect(hours.statusCode).toBe(200);
    const price = await api().inject({
      method: 'POST',
      url: `/v1/cms/places/${place!.id}/prices`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { priceMin: 50_000, priceMax: 120_000, unit: 'per_person' },
    });
    expect(price.statusCode).toBe(201);
    const stale = await api().inject({
      method: 'GET',
      url: '/v1/cms/places/stale?days=30',
      headers: auth(editor.token),
    });
    expect(stale.statusCode).toBe(200);
  });
});

describe('ranking console (CMS-008, FR-CMS-007)', () => {
  it('bounds validation, four-eyes approval, activate + rollback', async () => {
    const ops1 = await createAdmin('ops1@gogo.local', 'ops_admin');
    const ops2 = await createAdmin('ops2@gogo.local', 'ops_admin');

    const outOfBounds = await api().inject({
      method: 'POST',
      url: '/v1/cms/ranking-configs',
      remoteAddress: ip(),
      headers: auth(ops1.token),
      payload: { key: 'suggestion.scoring', weights: { preference: 0.9 } },
    });
    expect(outOfBounds.statusCode).toBe(400);
    expect(outOfBounds.json().code).toBe('WEIGHT_OUT_OF_BOUNDS');

    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/ranking-configs',
      remoteAddress: ip(),
      headers: auth(ops1.token),
      payload: { key: 'suggestion.scoring', weights: { preference: 0.4, quality: 0.2 } },
    });
    expect(created.statusCode).toBe(201);
    const configId = created.json().id;

    const selfApprove = await api().inject({
      method: 'POST',
      url: `/v1/cms/ranking-configs/${configId}/approve`,
      remoteAddress: ip(),
      headers: auth(ops1.token),
      payload: {},
    });
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().code).toBe('SELF_APPROVAL');

    const approve = await api().inject({
      method: 'POST',
      url: `/v1/cms/ranking-configs/${configId}/approve`,
      remoteAddress: ip(),
      headers: auth(ops2.token),
      payload: {},
    });
    expect(approve.statusCode).toBe(201);

    const activate = await api().inject({
      method: 'POST',
      url: `/v1/cms/ranking-configs/${configId}/activate`,
      remoteAddress: ip(),
      headers: auth(ops2.token),
      payload: {},
    });
    expect(activate.statusCode).toBe(201);
    const [active] = await db
      .select()
      .from(schema.rankingConfigs)
      .where(eq(schema.rankingConfigs.status, 'active'));
    expect(active!.id).toBe(configId);

    const rollback = await api().inject({
      method: 'POST',
      url: '/v1/cms/ranking-configs/suggestion.scoring/rollback',
      remoteAddress: ip(),
      headers: auth(ops1.token),
      payload: {},
    });
    expect(rollback.json().rolledBack).toBe(true);
  });
});

describe('moderation queue (CMS-007, FR-CMS-005)', () => {
  it('pending review decided with mandatory reason + audit', async () => {
    const moderator = await createAdmin('mod1@gogo.local', 'moderator');
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: { email: 'reviewer@gogo.vn', password: 'sufficiently-long-pw', displayName: 'R' },
    });
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Review Target',
        nameNormalized: 'x',
        status: 'published',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();
    const review = await api().inject({
      method: 'POST',
      url: '/v1/reviews',
      remoteAddress: ip(),
      headers: auth(reg.json().accessToken),
      payload: { placeId: place!.id, rating: 4, text: 'ổn' },
    });

    const queue = await api().inject({
      method: 'GET',
      url: '/v1/cms/moderation',
      headers: auth(moderator.token),
    });
    expect(queue.json().reviews.map((r: { id: string }) => r.id)).toContain(review.json().id);

    const noReason = await api().inject({
      method: 'POST',
      url: `/v1/cms/moderation/reviews/${review.json().id}`,
      remoteAddress: ip(),
      headers: auth(moderator.token),
      payload: { decision: 'published', reason: '' },
    });
    expect(noReason.statusCode).toBe(400); // reason is mandatory

    const decided = await api().inject({
      method: 'POST',
      url: `/v1/cms/moderation/reviews/${review.json().id}`,
      remoteAddress: ip(),
      headers: auth(moderator.token),
      payload: { decision: 'published', reason: 'nội dung phù hợp' },
    });
    expect(decided.statusCode).toBe(201);
    const [row] = await db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, review.json().id));
    expect(row!.status).toBe('published');
    expect(row!.moderationReason).toBe('nội dung phù hợp');
  });
});

describe('ops KPIs (CMS-010)', () => {
  it('KPIs endpoint aggregates health metrics (FR-CMS-010)', async () => {
    const ops = await createAdmin('ops4@gogo.local', 'ops_admin');
    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/ops/kpis',
      headers: auth(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('placeFreshness');
    expect(body).toHaveProperty('zeroResultsLast7d');
    expect(body).toHaveProperty('suggestionRunsLast7d');
    expect(body).toHaveProperty('currentPlansOverBudget');
    expect(body).toHaveProperty('moderationBacklog');
  });
});

describe('place list: filter, sort, cursor paging (BE-IMP-001/002)', () => {
  let editorToken: string;

  beforeAll(async () => {
    editorToken = (await createAdmin('list-editor@gogo.local', 'editor')).token;
    // 25 places, deterministic names/areas; updatedAt spaced so the keyset has
    // a real ordering to walk rather than a pile of identical timestamps.
    for (let i = 0; i < 25; i++) {
      await db.insert(schema.places).values({
        name: `Danh Sách Quán ${String(i).padStart(2, '0')}`,
        nameNormalized: 'set-by-trigger',
        status: i % 5 === 0 ? 'published' : 'draft',
        geom: { x: 106.7 + i / 1000, y: 10.77 + i / 1000 },
        areaKey: i % 2 === 0 ? 'hcm_q1' : 'hcm_q3',
        confidence: '0.50',
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      });
    }
  });

  const list = async (query: string) => {
    const res = await api().inject({
      method: 'GET',
      url: `/v1/cms/places?${query}`,
      remoteAddress: ip(),
      headers: auth(editorToken),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      items: { id: string; name: string; status: string; areaKey?: string }[];
      nextCursor: string | null;
    };
  };

  it('walks the whole catalog by cursor without repeating or skipping a row', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof list>> = await list(
        `limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(30);
    } while (cursor);

    expect(new Set(seen).size).toBe(seen.length); // no repeats
    const all = await db.select({ id: schema.places.id }).from(schema.places);
    expect(seen.length).toBe(all.length); // no skips
  });

  it('stays stable while rows are being written underneath it', async () => {
    // The whole reason for keyset over offset: an import runs while an editor
    // pages through the table.
    const first = await list('limit=5');
    expect(first.nextCursor).not.toBeNull();

    for (let i = 0; i < 5; i++) {
      await db.insert(schema.places).values({
        name: `Chen Ngang ${i}`,
        nameNormalized: 'set-by-trigger',
        status: 'draft',
        geom: { x: 106.8, y: 10.8 },
        updatedAt: new Date(Date.UTC(2026, 1, 1, 0, i)), // newer than page 1
      });
    }

    const second = await list(`limit=5&cursor=${encodeURIComponent(first.nextCursor!)}`);
    const overlap = second.items.filter((i) => first.items.some((f) => f.id === i.id));
    expect(overlap).toEqual([]);
  });

  it('nextCursor is null on the last page, not a page that comes back empty', async () => {
    const page = await list('limit=200');
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a tampered cursor instead of returning arbitrary rows', async () => {
    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/places?cursor=not-a-real-cursor',
      remoteAddress: ip(),
      headers: auth(editorToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_CURSOR');
  });

  it('searches without diacritics and matches the consumer-side behaviour', async () => {
    // "danh sach" must find "Danh Sách" — the old query hit `name` and missed.
    const page = await list('q=danh sach quan 03');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.name).toBe('Danh Sách Quán 03');
  });

  it('filters by status and area', async () => {
    const published = await list('status=published&limit=200');
    expect(published.items.every((i) => i.status === 'published')).toBe(true);
    expect(published.items.length).toBeGreaterThan(0);

    const q1 = await list('areaKey=hcm_q1&limit=200');
    expect(q1.items.every((i) => i.areaKey === 'hcm_q1')).toBe(true);
  });

  it('sorts by name ascending using the normalized column', async () => {
    const page = await list('sort=name&direction=asc&limit=200');
    const names = page.items.map((i) => i.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'vi')));
  });

  it('search predicate can be served by the trigram index', async () => {
    // Not "the planner must use it" — on a 30-row test table a seq scan is the
    // correct choice. What matters is that the index *applies* to this
    // predicate at all: querying `name` instead of `name_normalized` made it
    // unusable at any size, which is the regression being guarded.
    // SET LOCAL only lives inside a transaction — outside one it is discarded
    // before the next statement runs.
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute(
        sql`explain (format json) select p.id from places p
            where p.name_normalized like '%danh sach%'`,
      );
    });
    expect(JSON.stringify(plan.rows)).toContain('places_name_trgm_idx');
  });
});

describe('RBAC: hierarchical read, exact-match write (BE-IMP-008, #143)', () => {
  let editor: { id: string; token: string };
  let moderator: { id: string; token: string };
  let ops: { id: string; token: string };
  let root: { id: string; token: string };
  let placeId: string;

  beforeAll(async () => {
    editor = await createAdmin('rbac-editor@gogo.local', 'editor');
    moderator = await createAdmin('rbac-mod@gogo.local', 'moderator');
    ops = await createAdmin('rbac-ops@gogo.local', 'ops_admin');
    root = await createAdmin('rbac-root@gogo.local', 'super_admin');
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'RBAC Place',
        nameNormalized: 'set-by-trigger',
        status: 'draft',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();
    placeId = place!.id;
  });

  const get = (url: string, token: string) =>
    api().inject({ method: 'GET', url, remoteAddress: ip(), headers: auth(token) });

  it('every staff role can READ the catalog, including the one that publishes into it', async () => {
    // The case that motivated this: ops_admin publishes an import, creating
    // places, then could not open the list to see what it had just created.
    for (const t of [editor, moderator, ops, root]) {
      expect((await get('/v1/cms/places?limit=1', t.token)).statusCode).toBe(200);
    }
  });

  it('WRITING the catalog stays with the role that owns it', async () => {
    const patch = (token: string) =>
      api().inject({
        method: 'PATCH',
        url: `/v1/cms/places/${placeId}`,
        remoteAddress: ip(),
        headers: auth(token),
        payload: { description: 'edited' },
      });

    expect((await patch(editor.token)).statusCode).toBe(200);
    expect((await patch(root.token)).statusCode).toBe(200);
    // Read access did not become write access.
    expect((await patch(ops.token)).json().code).toBe('ROLE_DENIED');
    expect((await patch(moderator.token)).json().code).toBe('ROLE_DENIED');
  });

  it('reads do not climb: a lower rank still cannot see ops-only data', async () => {
    expect((await get('/v1/cms/ops/kpis', ops.token)).statusCode).toBe(200);
    expect((await get('/v1/cms/ops/kpis', root.token)).statusCode).toBe(200);
    expect((await get('/v1/cms/ops/kpis', editor.token)).json().code).toBe('ROLE_DENIED');
    expect((await get('/v1/cms/ops/kpis', moderator.token)).json().code).toBe('ROLE_DENIED');
  });

  it('peers can read each other: editor sees the moderation queue, moderator sees places', async () => {
    expect((await get('/v1/cms/moderation?limit=1', editor.token)).statusCode).toBe(200);
    expect((await get('/v1/cms/places?limit=1', moderator.token)).statusCode).toBe(200);
  });

  it('moderation decisions stay with moderators', async () => {
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: {
        email: 'rbac-reviewer@gogo.vn',
        password: 'sufficiently-long-pw',
        displayName: 'R',
      },
    });
    const review = await api().inject({
      method: 'POST',
      url: '/v1/reviews',
      remoteAddress: ip(),
      headers: auth(reg.json().accessToken),
      payload: { placeId, rating: 4, text: 'rbac target' },
    });
    const decide = (token: string) =>
      api().inject({
        method: 'POST',
        url: `/v1/cms/moderation/reviews/${review.json().id}`,
        remoteAddress: ip(),
        headers: auth(token),
        payload: { decision: 'published', reason: 'nội dung phù hợp' },
      });
    expect((await decide(editor.token)).json().code).toBe('ROLE_DENIED');
    expect((await decide(ops.token)).json().code).toBe('ROLE_DENIED');
    expect([200, 201]).toContain((await decide(moderator.token)).statusCode);
  });

  it('a suspended admin loses read access too, not just write', async () => {
    const victim = await createAdmin('rbac-suspended@gogo.local', 'ops_admin');
    expect((await get('/v1/cms/places?limit=1', victim.token)).statusCode).toBe(200);
    await db
      .update(schema.adminUsers)
      .set({ status: 'suspended' })
      .where(eq(schema.adminUsers.id, victim.id));
    expect((await get('/v1/cms/places?limit=1', victim.token)).json().code).toBe('ADMIN_ONLY');
  });
});

describe('audit request context (BE-IMP-007)', () => {
  it('records request id and staff IP for an admin write', async () => {
    const editor = await createAdmin('audit-ctx@gogo.local', 'editor');
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Audit Ctx Place',
        nameNormalized: 'set-by-trigger',
        status: 'draft',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();

    const res = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${place!.id}`,
      remoteAddress: '10.99.0.7',
      headers: auth(editor.token),
      payload: { description: 'audit context' },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, place!.id));
    expect(row!.actorId).toBe(editor.id);
    // Both used to be lost: request_id was declared and never written, and the
    // IP had nowhere to go at all.
    expect(row!.requestId).toBe(res.headers['x-request-id']);
    expect(row!.ipAddress).toBe('10.99.0.7');
  });

  it('does not record an IP for a non-admin actor', async () => {
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: '10.99.0.8',
      payload: {
        email: 'audit-user@gogo.vn',
        password: 'sufficiently-long-pw',
        displayName: 'U',
      },
    });
    const del = await api().inject({
      method: 'DELETE',
      url: '/v1/me',
      remoteAddress: '10.99.0.8',
      headers: auth(reg.json().accessToken),
    });
    expect([200, 202, 204]).toContain(del.statusCode);

    const rows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.actorType, 'user'));
    // Staff accountability justifies keeping an IP; it does not extend to users.
    expect(rows.every((r) => r.ipAddress === null)).toBe(true);
  });
});

describe('SEC-001 emergency takedown (break-glass)', () => {
  const takedown = (token: string, url: string, reason = 'nội dung vi phạm nghiêm trọng') =>
    api().inject({
      method: 'POST',
      url,
      remoteAddress: ip(),
      headers: auth(token),
      payload: { reason },
    });

  async function publishedPlace(name: string) {
    const [place] = await db
      .insert(schema.places)
      .values({
        name,
        nameNormalized: 'set-by-trigger',
        status: 'published',
        geom: { x: 106.7009, y: 10.7769 },
        areaKey: 'hcm_q1',
      })
      .returning();
    return place!;
  }

  it('every admin role can take a place down — the point is whoever is awake', async () => {
    for (const role of ['editor', 'moderator', 'ops_admin', 'super_admin'] as const) {
      const admin = await createAdmin(`bg-${role}@gogo.local`, role);
      const place = await publishedPlace(`Break Glass ${role}`);
      const res = await takedown(admin.token, `/v1/cms/emergency/places/${place.id}/suspend`);
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe('suspended');
    }
  });

  it('the place actually leaves discovery, not just the database row', async () => {
    // The success condition is "gone from discovery". Today search reads status
    // live from Postgres so this holds automatically — this test is what turns
    // red the day an external index lands (SE-009) and a takedown would
    // otherwise silently stop working.
    const admin = await createAdmin('bg-discovery@gogo.local', 'editor');
    const place = await publishedPlace('Break Glass Discovery Quán');

    const before = await api().inject({
      method: 'GET',
      url: '/v1/places/search?q=Break Glass Discovery&lat=10.7769&lng=106.7009&radiusM=5000',
      remoteAddress: ip(),
    });
    expect(before.json().results.some((i: { id: string }) => i.id === place.id)).toBe(true);

    await takedown(admin.token, `/v1/cms/emergency/places/${place.id}/suspend`);

    const after = await api().inject({
      method: 'GET',
      url: '/v1/places/search?q=Break Glass Discovery&lat=10.7769&lng=106.7009&radiusM=5000',
      remoteAddress: ip(),
    });
    expect(after.json().results.some((i: { id: string }) => i.id === place.id)).toBe(false);
  });

  it('records who, from where, why, and what changed', async () => {
    const admin = await createAdmin('bg-audit@gogo.local', 'moderator');
    const place = await publishedPlace('Break Glass Audit');
    const res = await api().inject({
      method: 'POST',
      url: `/v1/cms/emergency/places/${place.id}/suspend`,
      remoteAddress: '10.77.0.9',
      headers: auth(admin.token),
      payload: { reason: 'ảnh vi phạm, gỡ khẩn cấp' },
    });
    expect(res.statusCode).toBe(201);

    const [row] = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, place.id));
    expect(row!.action).toBe('place.emergency_suspended');
    expect(row!.actorId).toBe(admin.id);
    expect(row!.ipAddress).toBe('10.77.0.9');
    expect(row!.requestId).toBe(res.headers['x-request-id']);
    expect(row!.diff).toMatchObject({
      breakGlass: true,
      role: 'moderator',
      reason: 'ảnh vi phạm, gỡ khẩn cấp',
      before: { status: 'published' },
      after: { status: 'suspended' },
    });
  });

  it('taking down does not grant putting back up', async () => {
    // The asymmetry is the whole design: an ops_admin can suspend a place but
    // still cannot restore or edit it.
    const ops = await createAdmin('bg-asym@gogo.local', 'ops_admin');
    const place = await publishedPlace('Break Glass Asymmetry');
    expect(
      (await takedown(ops.token, `/v1/cms/emergency/places/${place.id}/suspend`)).statusCode,
    ).toBe(201);

    const restore = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${place.id}/status`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { status: 'published' },
    });
    expect(restore.json().code).toBe('ROLE_DENIED');
  });

  it('refuses a reason that explains nothing, and a state it does not apply to', async () => {
    const admin = await createAdmin('bg-guard@gogo.local', 'editor');
    const place = await publishedPlace('Break Glass Guard');

    const noReason = await takedown(
      admin.token,
      `/v1/cms/emergency/places/${place.id}/suspend`,
      'x',
    );
    expect(noReason.statusCode).toBe(400);

    expect(
      (await takedown(admin.token, `/v1/cms/emergency/places/${place.id}/suspend`)).statusCode,
    ).toBe(201);
    // Already suspended: break-glass covers exactly one transition.
    const again = await takedown(admin.token, `/v1/cms/emergency/places/${place.id}/suspend`);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('NOT_TAKEDOWNABLE');
  });

  it('burst limit stops a scripted run that the hourly cap alone would allow', async () => {
    const admin = await createAdmin('bg-burst@gogo.local', 'editor');
    const places = [];
    for (let i = 0; i < 8; i++) places.push(await publishedPlace(`Break Glass Burst ${i}`));

    let limited = false;
    for (const place of places) {
      const res = await takedown(admin.token, `/v1/cms/emergency/places/${place.id}/suspend`);
      if (res.statusCode === 429) {
        limited = true;
        break;
      }
    }
    // 5/minute: a human working an incident never reaches this; a script does.
    expect(limited).toBe(true);
  });

  it('hides a published review, keeping it distinct from a moderator verdict', async () => {
    const admin = await createAdmin('bg-review@gogo.local', 'ops_admin');
    const place = await publishedPlace('Break Glass Review Target');
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: { email: 'bg-reviewer@gogo.vn', password: 'sufficiently-long-pw', displayName: 'R' },
    });
    const review = await api().inject({
      method: 'POST',
      url: '/v1/reviews',
      remoteAddress: ip(),
      headers: auth(reg.json().accessToken),
      payload: { placeId: place.id, rating: 4, text: 'break glass target' },
    });
    await db
      .update(schema.reviews)
      .set({ status: 'published' })
      .where(eq(schema.reviews.id, review.json().id));

    const res = await takedown(admin.token, `/v1/cms/emergency/reviews/${review.json().id}/hide`);
    expect(res.statusCode).toBe(201);
    const [row] = await db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, review.json().id));
    // Not `rejected`/`removed`: those are quality verdicts, this is a takedown.
    expect(row!.status).toBe('hidden');
  });
});

describe('SEC-002 part A: which rule authorized the write', () => {
  it('tells a super_admin bypass apart from a write it was entitled to', async () => {
    const root = await createAdmin('authz-root@gogo.local', 'super_admin');
    const editor = await createAdmin('authz-editor@gogo.local', 'editor');
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Authz Path Place',
        nameNormalized: 'set-by-trigger',
        status: 'draft',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();

    // The editor owns catalog writes: this is the model working as designed.
    const byEditor = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${place!.id}`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { description: 'by the role that owns it' },
    });
    expect(byEditor.statusCode).toBe(200);

    // super_admin writing the same route would have been refused for any other
    // role — that is the escape hatch, and it must be visible as such.
    const byRoot = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${place!.id}`,
      remoteAddress: ip(),
      headers: auth(root.token),
      payload: { description: 'through the hatch' },
    });
    expect(byRoot.statusCode).toBe(200);

    const rows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, place!.id));
    const paths = new Map(rows.map((r) => [r.actorId, r.authorizationPath]));
    expect(paths.get(editor.id)).toBe('exact_role');
    expect(paths.get(root.id)).toBe('super_admin_bypass');
  });

  it('answers "how often was the hatch used" with plain SQL, no metrics backend', async () => {
    const bypasses = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.authorizationPath, 'super_admin_bypass'));
    expect(bypasses[0]!.n).toBeGreaterThan(0);
  });
});

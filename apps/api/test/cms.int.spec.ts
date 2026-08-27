import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
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

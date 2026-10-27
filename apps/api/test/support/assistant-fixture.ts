import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, isNull, sql } from 'drizzle-orm';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import * as argon2 from 'argon2';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { AdministrativeBoundaryImportService, AdministrativeImportService } from '@gogo/modules';
import { cmsAccessHeaders } from './cms-access';

/**
 * GoGo-BE#713 — a database and an API for the assistant specs: the published
 * administrative dataset, the CMS taxonomy, verified places in Phường Cầu Giấy
 * (Hà Nội), and the `assistant.enabled` flag.
 *
 * `ASSISTANT_TEST_DATABASE_URL` (a server where the role may CREATE DATABASE)
 * runs against a fresh database on that server instead of a container — for a
 * workstation without Docker. CI uses the container.
 */
export type AssistantFixture = {
  app: NestFastifyApplication;
  db: ReturnType<typeof drizzle<typeof schema>>;
  places: Record<string, string>;
  area: { datasetVersion: string; provinceCode: string; communeCode: string };
  inject: (opts: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;
    token?: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) => Promise<{
    statusCode: number;
    headers: Record<string, unknown>;
    body: string;
    json: () => any;
  }>;
  register: (email: string) => Promise<string>;
  guest: () => Promise<string>;
  admin: (email: string, role: 'editor' | 'moderator' | 'ops_admin') => Promise<string>;
  setFlag: (enabled: boolean) => Promise<void>;
  /** A real HTTP SSE read (inject has no socket); resolves when the server closes the stream. */
  sse: (
    url: string,
    token: string,
    lastEventId?: string,
    onFrame?: (raw: string) => boolean,
  ) => Promise<{ status: number; body: string }>;
  close: () => Promise<void>;
};

let ipc = 0;
const ip = () => `10.71.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;

export async function startAssistantFixture(
  env: Record<string, string>,
): Promise<AssistantFixture> {
  let container: StartedPostgreSqlContainer | null = null;
  let url: string;
  let dropDb: (() => Promise<void>) | null = null;
  const external = process.env.ASSISTANT_TEST_DATABASE_URL;
  if (external) {
    const name = `gogo_assistant_${randomBytes(4).toString('hex')}`;
    const admin = new Client({ connectionString: external });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin.end();
    const u = new URL(external);
    u.pathname = `/${name}`;
    url = u.toString();
    dropDb = async () => {
      const c = new Client({ connectionString: external });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    };
  } else {
    container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
      .withDatabase('gogo_assistant_test')
      .start();
    url = container.getConnectionUri();
  }

  Object.assign(process.env, {
    DATABASE_URL: url,
    REDIS_URL: 'redis://localhost:6380',
    NODE_ENV: 'test',
    APP_ENV: 'dev',
    AUTH_JWT_SECRET: 'assistant-test-secret-'.padEnd(48, 'x'),
    GOOGLE_PLACES_API_KEY: '',
    LOG_LEVEL: 'error',
    ...env,
  });

  const pool = new Pool({ connectionString: url, max: 3 });
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../../migrations') });

  // Taxonomy, as the CMS owns it (keys + vi labels).
  const TAX: Record<string, Record<string, string>> = {
    category: { restaurant: 'Nhà hàng', cafe: 'Cà phê', bar: 'Bar' },
    mood: { romantic: 'Lãng mạn', chill: 'Thư giãn', festive: 'Sôi động' },
    setting: { indoor: 'Trong nhà', outdoor: 'Ngoài trời' },
    suitability: { couple: 'Cặp đôi', group: 'Nhóm bạn', family: 'Gia đình' },
  };
  const tax: Record<string, string> = {};
  for (const [kind, terms] of Object.entries(TAX)) {
    for (const [key, label] of Object.entries(terms)) {
      const [row] = await db
        .insert(schema.taxonomies)
        .values({ kind: kind as 'mood', key })
        .returning();
      await db.insert(schema.taxonomyLabels).values({ taxonomyId: row!.id, locale: 'vi', label });
      tax[`${kind}:${key}`] = row!.id;
    }
  }

  await new AdministrativeBoundaryImportService(db).load({
    role: 'boundaries-fixture',
    boundaryVersion: 'fixture-v1',
    archivePath: path.resolve(
      __dirname,
      '../../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
    ),
  });
  const report = await new AdministrativeImportService(db).importPinnedSnapshot();
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED', publishedAt: new Date() })
    .where(eq(schema.administrativeDatasetVersions.id, report.datasetVersionId));
  const current = and(
    eq(schema.administrativeUnits.datasetVersionId, report.datasetVersionId),
    eq(schema.administrativeUnits.status, 'ACTIVE'),
    isNull(schema.administrativeUnits.effectiveTo),
  );
  const communes = await db
    .select()
    .from(schema.administrativeUnits)
    .where(
      and(
        current,
        eq(schema.administrativeUnits.level, 'COMMUNE'),
        sql`${schema.administrativeUnits.name} = 'Cầu Giấy'`,
      ),
    );
  if (communes.length === 0) throw new Error('fixture: Phường Cầu Giấy not in the pinned snapshot');
  const area = {
    datasetVersion: report.combinedDatasetVersion,
    provinceCode: communes[0]!.parentCode!,
    communeCode: communes[0]!.code,
  };

  const places: Record<string, string> = {};
  const place = async (
    key: string,
    name: string,
    tags: string[],
    price: [number, number] | null,
    suitability: Record<string, number>,
  ) => {
    const [p] = await db
      .insert(schema.places)
      .values({
        name,
        nameNormalized: name.toLowerCase(),
        status: 'published',
        geom: { x: 105.79, y: 21.03 },
        rating: '4.50',
        ratingCount: 300,
        suitability,
        avgVisitMinutes: 90,
        confidence: '0.9',
        freshnessCheckedAt: new Date(),
        provinceCode: area.provinceCode,
        communeCode: area.communeCode,
        administrativeDatasetVersion: area.datasetVersion,
        administrativeMappingStatus: 'VERIFIED',
      })
      .returning();
    for (const t of tags)
      await db.insert(schema.placeTaxonomies).values({ placeId: p!.id, taxonomyId: tax[t]! });
    if (price) {
      await db.insert(schema.placePrices).values({
        placeId: p!.id,
        priceMin: price[0],
        priceMax: price[1],
        currency: 'VND',
        unit: 'per_person',
        confidence: '0.8',
        source: 'editor',
        verifiedAt: new Date(),
      });
    }
    for (let day = 0; day < 7; day++) {
      await db.insert(schema.placeHours).values({
        placeId: p!.id,
        dayOfWeek: day,
        openMinute: 9 * 60,
        closeMinute: 23 * 60,
        isOvernight: false,
        source: 'editor',
      });
    }
    places[key] = p!.id;
  };
  await place(
    'quietRomantic',
    'Ánh Trăng Bistro',
    ['category:restaurant', 'mood:romantic', 'mood:chill', 'setting:indoor'],
    [150_000, 250_000],
    { couple: 0.95, group: 0.4 },
  );
  await place(
    'quietGarden',
    'Vườn Lá Kitchen',
    ['category:restaurant', 'mood:chill', 'setting:outdoor'],
    [120_000, 200_000],
    { couple: 0.8, group: 0.7 },
  );
  await place(
    'lively',
    'Bia Phố Sôi Động',
    ['category:restaurant', 'mood:festive', 'setting:outdoor'],
    [80_000, 150_000],
    { couple: 0.3, group: 0.95 },
  );
  await place(
    'pricey',
    'Thượng Uyển Fine Dining',
    ['category:restaurant', 'mood:romantic', 'setting:indoor'],
    [900_000, 1_500_000],
    { couple: 0.9, group: 0.5 },
  );
  await place(
    'cafe',
    'Cà Phê Gác Nhỏ',
    ['category:cafe', 'mood:chill', 'setting:indoor'],
    [40_000, 80_000],
    { couple: 0.9, group: 0.6 },
  );

  const { createApp } = await import('../../src/main.js');
  const app = await createApp();
  await app.init();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const fastify = app.getHttpAdapter().getInstance();
  const address = fastify.server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const sse: AssistantFixture['sse'] = async (url, token, lastEventId, onFrame) => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}${url}`, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
      },
      signal: controller.signal,
    });
    if (!res.body) return { status: res.status, body: await res.text() };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let body = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        body += dec.decode(value, { stream: true });
        // A caller may cut the connection mid-stream (reconnect tests).
        if (onFrame && onFrame(body)) {
          controller.abort();
          break;
        }
      }
    } catch {
      /* aborted by the caller */
    }
    return { status: res.status, body };
  };

  const inject: AssistantFixture['inject'] = async (o) => {
    const res = await fastify.inject({
      method: o.method,
      url: o.url,
      remoteAddress: ip(),
      headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) },
      ...(o.payload !== undefined ? { payload: o.payload as object } : {}),
    });
    return {
      statusCode: res.statusCode,
      headers: res.headers,
      body: res.body,
      json: () => res.json(),
    };
  };

  const register = async (email: string) => {
    const res = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: 'sufficiently-long-pw', displayName: email.split('@')[0] },
    });
    if (res.statusCode !== 201) throw new Error(`register ${res.statusCode} ${res.body}`);
    return res.json().accessToken as string;
  };

  const guest = async () => {
    const host = await register(`host-${randomBytes(3).toString('hex')}@gogo.test`);
    const room = await inject({
      method: 'POST',
      url: '/v1/rooms',
      token: host,
      payload: {
        type: 'group',
        decisionMode: 'vote',
        participantCount: 4,
        constraint: { budgetMode: 'per_person', budgetAmount: 200000 },
      },
    });
    const invite = await inject({
      method: 'POST',
      url: `/v1/rooms/${room.json().id}/invites`,
      token: host,
      payload: { maxUses: 5 },
    });
    const join = await inject({
      method: 'POST',
      url: '/v1/rooms/join/guest',
      payload: { inviteCode: invite.json().code, displayName: 'Khách' },
    });
    return join.json().accessToken as string;
  };

  const admin = async (email: string, role: 'editor' | 'moderator' | 'ops_admin') => {
    const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
    await db
      .insert(schema.adminUsers)
      .values({ email, passwordHash, displayName: email.split('@')[0]!, role });
    const res = await inject({
      method: 'POST',
      url: '/v1/cms/auth/login',
      headers: cmsAccessHeaders(email),
      payload: { email, password: 'admin-password-123' },
    });
    if (res.statusCode !== 201) throw new Error(`admin login ${res.statusCode} ${res.body}`);
    return res.json().accessToken as string;
  };

  const setFlag = async (enabled: boolean) => {
    await db
      .insert(schema.featureFlags)
      .values({ key: 'assistant.enabled', environment: 'all', platform: 'all', enabled })
      .onConflictDoUpdate({
        target: [
          schema.featureFlags.key,
          schema.featureFlags.environment,
          schema.featureFlags.platform,
        ],
        set: { enabled },
      });
  };

  return {
    app,
    db,
    places,
    area,
    inject,
    register,
    guest,
    admin,
    setFlag,
    sse,
    close: async () => {
      await app.close();
      await pool.end();
      if (container) await container.stop();
      if (dropDb) await dropDb().catch(() => undefined);
    },
  };
}

/** Parses an SSE body (`inject` returns it whole once the stream ends). */
export function parseSse(body: string): { id?: string; event: string; data: any }[] {
  const out: { id?: string; event: string; data: any }[] = [];
  for (const block of body.split(/\n\n/)) {
    const lines = block.split('\n').filter((l) => l && !l.startsWith(':'));
    if (lines.length === 0) continue;
    const frame: { id?: string; event: string; data: any } = { event: 'message', data: null };
    const data: string[] = [];
    for (const l of lines) {
      if (l.startsWith('id:')) frame.id = l.slice(3).trim();
      else if (l.startsWith('event:')) frame.event = l.slice(6).trim();
      else if (l.startsWith('data:')) data.push(l.slice(5).trimStart());
    }
    frame.data = data.length ? JSON.parse(data.join('\n')) : null;
    out.push(frame);
  }
  return out;
}

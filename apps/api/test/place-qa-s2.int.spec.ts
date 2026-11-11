import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { createDb, schema, type Db } from '@gogo/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { SearchService } from '../../../libs/modules/search/application/search.service';
import { SearchRepository } from '../../../libs/modules/search/infrastructure/search.repository';
import {
  placeFactsQuery,
  placeNameKeySql,
  resolvePlaceNameQuery,
} from '../../../libs/modules/search/infrastructure/place-qa-queries';
import { placeQaRead } from '../../../libs/modules/search/infrastructure/place-qa-read';
import { placeNameVariants } from '../../../libs/modules/assistant/domain/place-qa/resolution';
import { extractPlaceNameSpan } from '../../../libs/modules/assistant/domain/place-qa/span';
import {
  factForSurface,
  placeTopicEligible,
} from '../../../libs/modules/search/domain/place-facts';
import type {
  PlaceFacts,
  PlaceFactsReader,
} from '../../../libs/modules/assistant/domain/place-qa/place-facts';
import { renderPlaceAnswer } from '../../../libs/modules/assistant/domain/place-qa/templates';
const readOptions = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 2000 });
const weekday = (place: PlaceFacts, day: number) =>
  place.facts.hours?.find((schedule) => schedule.day === day);

// Layer C only. No assistant admission, classifier, hooks, emitter or model adapters.
let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let service: SearchService;
const stamp = new Date('2025-02-03T10:00:00Z');
const area = (provinceCode: string, communeCode: string) => ({
  kind: 'current' as const,
  datasetVersion: 'qa-fixture-v1',
  provinceCode,
  communeCode,
});
const ids: Record<string, string> = {};

async function place(name: string, extra: Partial<typeof schema.places.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.places)
    .values({
      name,
      nameNormalized: 'trigger',
      status: 'published',
      geom: { x: 106.7, y: 10.7 },
      ...extra,
    })
    .returning();
  return row!.id;
}
async function facts(id = ids['facts']!) {
  const context = await service.placeFacts([id], readOptions());
  const value = context.places.get(id)!;
  if (!value.available) throw new Error('fixture expected published place');
  return value;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_qa_s2')
    .start();
  ({ db, pool } = createDb(container.getConnectionUri(), { max: 1 }));
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  service = new SearchService(new SearchRepository(db), db);
  const [dataset] = await db
    .insert(schema.administrativeDatasetVersions)
    .values({
      combinedDatasetVersion: 'qa-fixture-v1',
      combinedChecksum: 'qa-fixture-checksum',
      currentSourceVersion: 'fictional',
      source: 'test',
      effectiveDate: '2025-07-01',
      status: 'PUBLISHED',
    })
    .returning();
  for (const [code, parent] of [
    ['00001', '01'],
    ['00002', '02'],
  ]) {
    await db.insert(schema.administrativeUnits).values({
      datasetVersionId: dataset!.id,
      code: code!,
      parentCode: parent!,
      name: 'Trùng Tên',
      fullName: 'Phường Trùng Tên',
      nameNormalized: 'trung ten',
      fullNameNormalized: 'phuong trung ten',
      unitType: 'WARD',
      level: 'COMMUNE',
      effectiveFrom: '2025-07-01',
      source: 'fictional',
      sourceVersion: 'fixture',
    });
  }
  ids['unique'] = await place('Mây Lam');
  ids['punctuation'] = await place("Pizza 4P's Bến Thành");
  ids['common'] = await place('Cafe');
  ids['areaWords'] = await place('Cafe Quận 9');
  ids['family1'] = await place('Tonkin', {
    administrativeMappingStatus: 'VERIFIED',
    administrativeDatasetVersion: 'qa-fixture-v1',
    provinceCode: '01',
    communeCode: '00001',
  });
  ids['family2'] = await place('Tonkin', {
    administrativeMappingStatus: 'VERIFIED',
    administrativeDatasetVersion: 'qa-fixture-v1',
    provinceCode: '02',
    communeCode: '00002',
  });
  for (let branch = 0; branch < 12; branch++) {
    ids[`branch${branch}`] = await place('Astraluma', {
      administrativeMappingStatus: 'VERIFIED',
      administrativeDatasetVersion: 'qa-fixture-v1',
      provinceCode: branch === 11 ? '02' : '01',
      communeCode: branch === 11 ? '00002' : '00001',
    });
  }
  ids['facts'] = await place('Fixture Facts', {
    addressText: '12 Đường Giả Định',
    phone: '+842838229999',
    freshnessCheckedAt: new Date(),
    suitability: { group: 1 },
    rating: '4.9',
    ratingCount: 1000,
  });
  await db.insert(schema.placeHours).values([
    {
      placeId: ids['facts']!,
      dayOfWeek: 1,
      openMinute: 480,
      closeMinute: 660,
      source: 'editor',
      verifiedAt: stamp,
    },
    {
      placeId: ids['facts']!,
      dayOfWeek: 1,
      openMinute: 1020,
      closeMinute: 1380,
      source: 'editor',
      verifiedAt: stamp,
    },
    {
      placeId: ids['facts']!,
      dayOfWeek: 2,
      openMinute: 1200,
      closeMinute: 120,
      isOvernight: true,
      source: 'editor',
      verifiedAt: stamp,
    },
    {
      placeId: ids['facts']!,
      dayOfWeek: 4,
      entryKind: 'open_24h',
      openMinute: 0,
      closeMinute: 0,
      source: 'editor',
      verifiedAt: stamp,
    },
    {
      placeId: ids['facts']!,
      dayOfWeek: 5,
      entryKind: 'closed',
      openMinute: 0,
      closeMinute: 0,
      source: 'editor',
      verifiedAt: stamp,
    },
  ]);
  await db.insert(schema.placePrices).values([
    {
      placeId: ids['facts']!,
      priceMin: 0,
      priceMax: 0,
      currency: 'VND',
      unit: 'per_person',
      source: 'editor',
      verifiedAt: stamp,
    },
    {
      placeId: ids['facts']!,
      priceMin: 100,
      priceMax: 200,
      currency: 'USD',
      unit: 'per_hour',
      source: 'bill_checkin',
      verifiedAt: stamp,
    },
    {
      placeId: ids['facts']!,
      priceMin: 300,
      priceMax: 400,
      currency: 'VND',
      unit: 'per_item',
      source: 'editor',
      verifiedAt: stamp,
    },
    {
      placeId: ids['facts']!,
      priceMin: 500,
      priceMax: 600,
      currency: 'VND',
      unit: 'per_night',
      source: 'editor',
      verifiedAt: stamp,
    },
  ]);
  await db.insert(schema.placeFieldProvenance).values({
    placeId: ids['facts']!,
    field: 'address_text',
    sourceType: 'editorial',
    sourceReference: 'merchant attestation',
    collectedAt: stamp,
    verifiedAt: stamp,
  });
  const [wifi] = await db
    .insert(schema.taxonomies)
    .values({ kind: 'amenity', key: 'qa_wifi', isActive: true })
    .returning();
  const [inactive] = await db
    .insert(schema.taxonomies)
    .values({ kind: 'amenity', key: 'qa_inactive', isActive: false })
    .returning();
  await db.insert(schema.placeTaxonomies).values([
    { placeId: ids['facts']!, taxonomyId: wifi!.id },
    { placeId: ids['facts']!, taxonomyId: inactive!.id },
  ]);
});
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('matrix 2: catalogue resolution, real indexed SQL', () => {
  it('unseen name is not_found, whole unaccented name is exact and has no context fallback', async () => {
    expect(await service.resolvePlaceName('Xylophonium')).toMatchObject({
      kind: 'not_found',
      candidates: [],
    });
    expect(await service.resolvePlaceName('May Lam')).toMatchObject({
      kind: 'answer',
      candidates: [{ id: ids['unique'], exact: true }],
    });
    expect(await service.resolvePlaceName('Cafe')).toMatchObject({
      kind: 'answer',
      candidates: [{ id: ids['common'] }],
    });
    expect(await service.resolvePlaceName('Cafe Quận 9')).toMatchObject({
      kind: 'answer',
      candidates: [{ id: ids['areaWords'] }],
    });
  });
  it("4ps / 4P's channels deduplicate one id; they never manufacture branches", async () => {
    for (const span of ["Pizza 4P's Ben Thanh", 'Pizza 4ps Ben Thanh', 'Pizza 4P s Bến Thành']) {
      const result = await service.resolvePlaceName(span);
      expect(result.candidates.filter((c) => c.id === ids['punctuation'])).toHaveLength(1);
      expect(result.kind).toBe('answer');
      expect(result.candidates[0]!.exact).toBe(true);
    }
  });
  it('Sol F-02: sub-T_weak scoped retrieval must not hide the exact place elsewhere', async () => {
    const name = 'abcdefghijklmnopqrstu';
    const weak = 'abcdefrstuvw';
    const score = await db.execute(
      sql`select greatest(word_similarity(${name}, ${weak}), similarity(${weak}, ${name})) as score`,
    );
    expect(Number(score.rows[0]!['score'])).toBeGreaterThan(0.3);
    expect(Number(score.rows[0]!['score'])).toBeLessThan(0.35);
    await place(weak, {
      administrativeMappingStatus: 'VERIFIED',
      administrativeDatasetVersion: 'qa-fixture-v1',
      provinceCode: '01',
      communeCode: '00001',
    });
    const exact = await place(name, {
      administrativeMappingStatus: 'VERIFIED',
      administrativeDatasetVersion: 'qa-fixture-v1',
      provinceCode: '02',
      communeCode: '00002',
    });
    expect(await service.resolvePlaceName(name, { area: area('01', '00001') })).toMatchObject({
      kind: 'choice',
      areaMismatch: true,
      overflow: false,
      candidates: [{ id: exact, exact: true }],
    });
  });
  it('Sol F-04 / Astra F-02: all punctuation inputs choose all equivalent published ids', async () => {
    const names = ["Orbit 4P's Riverside", 'Orbit 4ps Riverside', 'Orbit 4P s Riverside'];
    const branches = await Promise.all(names.map((name) => place(name)));
    for (const name of names) {
      const result = await service.resolvePlaceName(name);
      expect(result.kind).toBe('choice');
      expect(result.candidates.map((c) => c.id).sort()).toEqual([...branches].sort());
      expect(result.candidates.every((c) => c.exact)).toBe(true);
    }
  });
  it('Astra F-02 (confirm): whitespace spellings are one exact family for either input', async () => {
    const names = ['Sương Mai', 'Sương  Mai', ' Sương\u00a0\tMai '];
    const twins = await Promise.all(names.map((name) => place(name)));
    const stored = await db.execute(
      sql`select name_normalized from places where id = any(${sql.raw(`'{${twins.join(',')}}'::uuid[]`)})`,
    );
    // The trigger really leaves three different stored spellings behind.
    expect(new Set(stored.rows.map((row) => row['name_normalized'])).size).toBe(3);
    for (const input of [...names, 'suong mai', 'Sương\tMai']) {
      const result = await service.resolvePlaceName(input);
      expect(result.kind).toBe('choice');
      expect(result.candidates.map((c) => c.id).sort()).toEqual([...twins].sort());
      expect(result.candidates.every((c) => c.exact)).toBe(true);
    }
    // A single spelling elsewhere in the catalogue is still a direct answer.
    await place('Thu  Cúc   Garden');
    expect(await service.resolvePlaceName('Thu Cúc Garden')).toMatchObject({
      kind: 'answer',
      candidates: [{ exact: true }],
    });
  });
  it('Astra F-02 (confirm): the SQL name key collapses exactly the JavaScript whitespace class', async () => {
    const points = Array.from({ length: 0x3001 }, (_, i) => i)
      .concat(0xfeff)
      .filter((i) => i !== 0);
    const jsSpace = points.filter((i) => /^\s$/u.test(String.fromCodePoint(i)));
    expect(jsSpace.length).toBe(25);
    const result = await db.execute(
      sql`select cp from unnest(${sql.raw(
        `'{${points.join(',')}}'::int[]`,
      )}) cp where ${placeNameKeySql(sql`'a' || chr(cp) || chr(cp) || 'b' || chr(cp)`)} = 'a b'`,
    );
    expect(result.rows.map((row) => Number(row['cp'])).sort((a, b) => a - b)).toEqual(jsSpace);
  });
  it('Sol F-04 (confirm): unrelated and typographic apostrophes keep an exact unique answer', async () => {
    const id = await place("O'Brien Pizza 7ps");
    const curly = await place('Mộc\u2019s Kitchen');
    for (const input of ["O'Brien Pizza 7ps", "O'Brien Pizza 7P's", 'O\u2019Brien Pizza 7P s'])
      expect(await service.resolvePlaceName(input)).toMatchObject({
        kind: 'answer',
        candidates: [{ id, exact: true }],
      });
    for (const input of ['Mộc\u2019s Kitchen', "Mộc's Kitchen"])
      expect(await service.resolvePlaceName(input)).toMatchObject({
        kind: 'answer',
        candidates: [{ id: curly, exact: true }],
      });
    expect(await service.resolvePlaceName('Pizza 4P\u2019s Bến Thành')).toMatchObject({
      kind: 'answer',
      candidates: [{ id: ids['punctuation'], exact: true }],
    });
    // Dropping the unrelated apostrophe is another name: it may only confirm.
    expect((await service.resolvePlaceName('OBrien Pizza 7ps')).kind).not.toBe('answer');
  });
  it('Astra F-01 (round 3): a grammar-like boundary token never makes the short core a silent answer', async () => {
    const grass = await place('Cafe Cỏ');
    const resolve = (
      message: string,
      extra: Parameters<typeof service.resolvePlaceName>[1] = {},
    ) => {
      const span = extractPlaceNameSpan(message);
      if (span.kind !== 'span') throw new Error(`fixture expected a span: ${message}`);
      return service.resolvePlaceName(span.text, { alternates: span.alternates, ...extra });
    };
    // Accented name token: not grammar, whole name answers.
    expect(await resolve('Cafe Cỏ mở cửa mấy giờ?')).toMatchObject({
      kind: 'answer',
      candidates: [{ id: grass, exact: true }],
    });
    // Unaccented / particle-shaped token: both published readings, the user chooses.
    for (const message of [
      'Cafe Co mo cua may gio?',
      'Cafe co wifi khong?',
      'Cafe có mở cửa không?',
    ]) {
      const result = await resolve(message);
      expect(result.kind).toBe('choice');
      expect(result.candidates.map((c) => c.id).sort()).toEqual([grass, ids['common']!].sort());
      expect(result.candidates.every((c) => c.exact)).toBe(true);
    }
    // No collision in the catalogue: the ordinary question still answers directly.
    expect(await resolve('Mây Lam có wifi không?')).toMatchObject({
      kind: 'answer',
      candidates: [{ id: ids['unique'], exact: true }],
    });
    // A detected area may be the tail of a whole name; that reading ignores the area filter.
    const scoped = {
      administrativeMappingStatus: 'VERIFIED' as const,
      administrativeDatasetVersion: 'qa-fixture-v1',
      provinceCode: '01',
      communeCode: '00001',
    };
    const short = await place('Zetaquy', scoped);
    const long = await place('Zetaquy O Quan 9');
    const both = await resolve('Zetaquy O Quan 9 mo cua may gio?', { area: area('01', '00001') });
    expect(both.kind).toBe('choice');
    expect(both.candidates.map((c) => c.id).sort()).toEqual([short, long].sort());
    await expect(
      service.resolvePlaceName('Cafe', {
        alternates: Array.from({ length: 5 }, (_, i) => ({ text: `Cafe ${i}` })),
      }),
    ).resolves.toMatchObject({ kind: 'narrow' });
  });
  it('Sol F-01 / Astra F-03: canonical reader returns a map and renderer-facing snapshot', async () => {
    const reader: PlaceFactsReader = service;
    const context = await reader.placeFacts([ids['facts']!], {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 2000,
    });
    const projected = context.places.get(ids['facts']!);
    expect(projected).toMatchObject({
      name: 'Fixture Facts',
      facts: { price: expect.any(Array) },
    });
    expect(projected!.facts.price!.flatMap((fact) => fact.value)).toContainEqual(
      expect.objectContaining({ currency: 'VND' }),
    );
    expect(projected).not.toHaveProperty('identity');
  });
  it('Sol F-01 / Astra F-03: canonical deadlineAt expires before SQL acquisition', async () => {
    await expect(
      service.placeFacts([ids['facts']!], {
        signal: new AbortController().signal,
        deadlineAt: Date.now() - 1,
      }),
    ).rejects.toMatchObject({ reason: 'timeout' });
  });
  it('family exact chooses; typo/near-equal fuzzy confirms, never answers', async () => {
    expect(await service.resolvePlaceName('Tonkin')).toMatchObject({ kind: 'choice' });
    const fuzzy = await service.resolvePlaceName('Tonki');
    expect(fuzzy.kind).toBe('confirm');
    expect(fuzzy.candidates.map((c) => c.id).sort()).toEqual(
      [ids['family1'], ids['family2']].sort(),
    );
    expect(fuzzy.candidates.every((c) => !c.exact)).toBe(true);
  });
  it('more than eight distinct branches narrow; area is applied before the cutoff', async () => {
    expect(await service.resolvePlaceName('Astraluma')).toMatchObject({
      kind: 'narrow',
      overflow: true,
    });
    expect(
      await service.resolvePlaceName('Astraluma', { area: area('02', '00002') }),
    ).toMatchObject({ kind: 'answer', overflow: false, candidates: [{ id: ids['branch11'] }] });
    expect(await service.resolvePlaceName('Tonkin', { area: area('02', '00002') })).toMatchObject({
      kind: 'answer',
      candidates: [{ id: ids['family2'] }],
    });
    expect(await service.resolvePlaceName('Tonkin', { area: area('03', '00003') })).toMatchObject({
      kind: 'choice',
      areaMismatch: true,
    });
    expect(
      await service.resolvePlaceName('Mây Lam', { area: { kind: 'unresolved' } }),
    ).toMatchObject({ kind: 'narrow' });
  });
  it('legacy Quận 2/9 never satisfies area; negated topic keeps the exact same referent', async () => {
    for (const district of ['Quận 2', 'Quận 9']) {
      const text = `Mây Lam không có wifi ở ${district}?`;
      const span = extractPlaceNameSpan(text, { start: text.indexOf('ở '), end: text.length });
      expect(span).toMatchObject({ kind: 'span', text: 'Mây Lam' });
      if (span.kind === 'span')
        expect(
          await service.resolvePlaceName(span.text, { area: { kind: 'legacy' } }),
        ).toMatchObject({ kind: 'confirm', candidates: [{ id: ids['unique'] }] });
    }
  });
  it('compare slots resolve independently: unresolved right does not replace left', async () => {
    const left = await service.resolvePlaceName('Mây Lam');
    const right = await service.resolvePlaceName('Xylophonium');
    expect(left).toMatchObject({ kind: 'answer', candidates: [{ id: ids['unique'] }] });
    expect(right.kind).toBe('not_found');
  });
  it('thresholds reset after success and rollback; errors/cancel are not empty results', async () => {
    const before = await db.execute(sql`show pg_trgm.word_similarity_threshold`);
    await service.resolvePlaceName('Mây Lam');
    expect((await db.execute(sql`show pg_trgm.word_similarity_threshold`)).rows).toEqual(
      before.rows,
    );
    await expect(
      placeQaRead(db, 1000, {}, async (read) => {
        await read.execute(sql`select set_config('pg_trgm.word_similarity_threshold','0.3',true)`);
        await read.execute(sql`select 1/0`);
      }),
    ).rejects.toThrow();
    expect((await db.execute(sql`show pg_trgm.word_similarity_threshold`)).rows).toEqual(
      before.rows,
    );
    await expect(
      placeQaRead(db, 30, {}, async (read) => read.execute(sql`select pg_sleep(1)`)),
    ).rejects.toThrow();
    const controller = new AbortController();
    const running = placeQaRead(db, 1000, { signal: controller.signal }, async (read) => {
      setTimeout(() => controller.abort(), 20);
      await read.execute(sql`select pg_sleep(5)`);
    });
    await expect(running).rejects.toMatchObject({ reason: 'cancelled' });
    await expect(
      service.placeFacts([ids['facts']!], { ...readOptions(), deadlineAt: Date.now() - 1 }),
    ).rejects.toThrow();
    expect(await service.resolvePlaceName('Mây Lam')).toMatchObject({ kind: 'answer' });
  });
  it('SQL threshold equality remains retrievable at the lower transaction-local threshold', async () => {
    await placeQaRead(db, 1000, {}, async (read) => {
      await read.execute(sql`select set_config('pg_trgm.similarity_threshold','0.30',true)`);
      const result =
        await read.execute(sql`select similarity('abcdefghijkl','abcdefgrstuvw') as score,
        'abcdefghijkl' % 'abcdefgrstuvw' as retrieved`);
      expect(Number(result.rows[0]!['score'])).toBeCloseTo(0.35, 6);
      expect(result.rows[0]!['retrieved']).toBe(true);
    });
  });
});

describe('matrix 3: fact policy from SQL, not placeDetail defaults', () => {
  it('canonical SQL projection renders dated hours and prices without losing units, currencies or zero', async () => {
    const value = await facts();
    expect(value.facts.price).toHaveLength(4);
    expect(value.facts.price!.every((p) => p.tier === 'verified_reference')).toBe(true);
    expect(value.facts.price).toContainEqual(
      expect.objectContaining({
        tier: 'verified_reference',
        verifiedAt: stamp.toISOString(),
        value: [{ min: 0, max: 0, unit: 'per_person', currency: 'VND' }],
      }),
    );
    expect(weekday(value, 1)).toMatchObject({
      day: 1,
      intervals: [
        { tier: 'verified_reference', verifiedAt: stamp.toISOString(), value: { openMinute: 480 } },
        {
          tier: 'verified_reference',
          verifiedAt: stamp.toISOString(),
          value: { openMinute: 1020 },
        },
      ],
    });
    expect(weekday(value, 2)).toMatchObject({
      intervals: [{ value: { overnight: true, closeMinute: 120 } }],
    });
    expect(weekday(value, 3)).toBeUndefined();
    expect(weekday(value, 4)).toMatchObject({ intervals: [{ value: { kind: 'open_24h' } }] });
    expect(weekday(value, 5)).toMatchObject({ intervals: [{ value: { kind: 'closed' } }] });
    expect(value.facts.openNow).toBeUndefined();
    expect(value.facts.address).toMatchObject({
      tier: 'verified_reference',
      verifiedAt: stamp.toISOString(),
      source: { kind: 'gogo', collectedAt: stamp.toISOString() },
    });
    expect(value.facts.contact).toBeUndefined();
    expect(value.facts.price!.map((p) => factForSurface(p, 'card', true).tier)).toEqual(
      Array(4).fill('absent'),
    );
    const answer = renderPlaceAnswer(
      { placeId: value.id, locale: 'vi', topic: 'price' },
      { places: new Map([[value.id, value]]) },
    );
    expect(answer.eligible).toBe(true);
    expect(answer.sources).toHaveLength(4);
  });
  it('missing/unverified/provider/assignment-only data is omitted from the canonical contract', async () => {
    const id = await place('Unconfirmed facts', {
      phone: '+842838229999',
      suitability: { group: 1 },
      freshnessCheckedAt: new Date(),
    });
    await db
      .insert(schema.placePrices)
      .values({ placeId: id, priceMin: 0, priceMax: 100, unit: 'per_person', source: 'editor' });
    await db
      .insert(schema.placeHours)
      .values({ placeId: id, dayOfWeek: 1, openMinute: 480, closeMinute: 600, source: 'editor' });
    const value = await facts(id);
    expect(value.facts.price).toBeUndefined();
    expect(value.facts.hours).toBeUndefined();
    expect(placeTopicEligible(value, 'price')).toBe(false);
    const populated = await facts();
    expect(populated.facts.amenity).toBeUndefined();
    expect(populated.facts.providerRating).toBeUndefined();
    for (const key of ['qa_wifi', 'qa_inactive', 'missing'])
      expect(placeTopicEligible(populated, 'amenity', { key })).toBe(false);
    expect(placeTopicEligible(populated, 'suitability', { key: 'group', capacity: 6 })).toBe(false);
  });
  it('schema rejects null units; unsafe bigint/provider prices/unsupported currencies are suppressed on the real read', async () => {
    const id = await place('Malformed fixture');
    await expect(
      db.execute(
        sql`insert into place_prices(place_id,price_min,price_max,unit) values(${id}::uuid,0,0,null)`,
      ),
    ).rejects.toThrow();
    await db.execute(sql`insert into place_prices(place_id,price_min,price_max,unit,source,verified_at)
      values(${id}::uuid,9007199254740992,9007199254740992,'per_person','editor',${stamp.toISOString()}::timestamptz),
      (${id}::uuid,0,0,'per_person','provider',${stamp.toISOString()}::timestamptz)`);
    await db.insert(schema.placePrices).values({
      placeId: id,
      priceMin: 0,
      priceMax: 100,
      unit: 'per_person',
      currency: 'ZZZ',
      source: 'editor',
      verifiedAt: stamp,
    });
    expect((await facts(id)).facts.price).toBeUndefined();
    expect(placeTopicEligible(await facts(id), 'price')).toBe(false);
  });
  it('current community ratings re-evaluate count/threshold and map actual moderation/collection evidence', async () => {
    const id = await place('Rated fixture');
    for (let i = 0; i < 5; i++) {
      const [user] = await db
        .insert(schema.users)
        .values({ displayName: `QA ${i}` })
        .returning();
      await db.insert(schema.reviews).values({
        placeId: id,
        userId: user!.id,
        rating: 4,
        status: 'published',
        firstPublishedAt: stamp,
        createdAt: stamp,
      });
      expect((await facts(id)).facts.rating).toMatchObject({
        tier: 'verified_current',
        source: { kind: 'community', collectedAt: stamp.toISOString() },
        verifiedAt: stamp.toISOString(),
        value: { source: 'community', count: i + 1, score: i === 4 ? 4 : null },
      });
    }
    await db.execute(sql`update reviews set status='hidden' where place_id=${id}::uuid`);
    // No surviving moderation/collection evidence: never manufacture a date.
    expect((await facts(id)).facts.rating).toBeUndefined();
  });
  it('Sol F-02 (confirm): a future-dated published review suppresses the aggregate; old rows cannot vouch', async () => {
    const future = new Date(Date.now() + 86_400_000);
    for (const [name, late] of [
      ['Future moderation fixture', { firstPublishedAt: future, createdAt: stamp }],
      ['Future collection fixture', { firstPublishedAt: stamp, createdAt: future }],
    ] as const) {
      const id = await place(name);
      for (let i = 0; i < 6; i++) {
        const [user] = await db
          .insert(schema.users)
          .values({ displayName: `QA future ${i}` })
          .returning();
        await db.insert(schema.reviews).values({
          placeId: id,
          userId: user!.id,
          rating: 5,
          status: 'published',
          ...(i === 5 ? late : { firstPublishedAt: stamp, createdAt: stamp }),
        });
        // Five valid historical rows are an ordinary aggregate.
        if (i === 4)
          expect((await facts(id)).facts.rating).toMatchObject({ value: { count: 5, score: 5 } });
      }
      const mixed = await facts(id);
      expect(mixed.facts.rating).toBeUndefined();
      expect(placeTopicEligible(mixed, 'rating')).toBe(false);
      // Once the future-dated row leaves the aggregate, the evidence is complete again.
      await db.execute(
        sql`update reviews set status='hidden' where place_id=${id}::uuid and (first_published_at > now() or created_at > now())`,
      );
      expect((await facts(id)).facts.rating).toMatchObject({
        verifiedAt: stamp.toISOString(),
        value: { count: 5, score: 5 },
      });
    }
  });
  it('gone/closed/unpublished have empty names/facts; batched ids deduplicate in the canonical map', async () => {
    const draft = await place('Unpublished', { status: 'draft' });
    const suspended = await place('Suspended fixture', { status: 'suspended' });
    const archived = await place('Archived fixture', { status: 'archived' });
    const closed = await place('Provider closed');
    await db
      .insert(schema.placeProviderSources)
      .values({ placeId: closed, externalId: 'fictional-closed', sourceStatus: 'closed' });
    const gone = '00000000-0000-4000-8000-000000000999';
    const context = await service.placeFacts(
      [draft, suspended, archived, closed, gone, closed],
      readOptions(),
    );
    for (const id of [draft, suspended, archived, closed, gone])
      expect(context.places.get(id)).toEqual({ id, available: false, name: '', facts: {} });
    expect(context.places.size).toBe(5);
    expect((await service.resolvePlaceName('Provider closed')).candidates).toEqual([]);
  });
  it('weekday/date/midnight readers get weekly rows with no present/date availability claim', async () => {
    const value = await facts();
    expect(weekday(value, 1)?.intervals).toHaveLength(2);
    expect(value.facts.openNow).toBeUndefined();
    expect(placeTopicEligible(value, 'hours', { day: 1 })).toBe(true);
    expect(placeTopicEligible(value, 'hours', { day: 3 })).toBe(false);
    const answer = renderPlaceAnswer(
      {
        placeId: value.id,
        topic: 'hours',
        locale: 'en',
        day: 'date',
        date: '2026-11-09',
        d: 1,
        tz: 'Asia/Ho_Chi_Minh',
      },
      { places: new Map([[value.id, value]]) },
    );
    expect(answer.text).toContain('Regular weekly hours');
    expect(answer.text).toContain('Special-day/holiday exceptions are unavailable');
  });
});

describe('DEV query-plan and latency evidence', () => {
  it('records actual production SQL plans, broad-name fan-out and p95 over a 20k catalogue', async () => {
    await db.execute(sql`insert into places(name,name_normalized,status,geom)
      select 'Corpus Venue ' || n, 'trigger', 'published', ST_SetSRID(ST_MakePoint(106.7,10.7),4326)
      from generate_series(1,20000) n`);
    // VACUUM, not only ANALYZE: a bulk load leaves every new entry in the GIN
    // pending list, and the planner then prices both GIN indexes out (measured:
    // sequential scan before, BitmapOr after). Autovacuum does this in a real DB.
    await pool.query('vacuum analyze places');
    const plans: Record<string, unknown> = {};
    for (const [name, query] of [
      ['exact', resolvePlaceNameQuery(placeNameVariants('Mây Lam'), 8)],
      ['broad', resolvePlaceNameQuery(placeNameVariants('Corpus Venue'), 8)],
      [
        'area-before-cutoff',
        resolvePlaceNameQuery(placeNameVariants('Astraluma'), 8, area('02', '00002')),
      ],
      ['facts', placeFactsQuery([ids['facts']!, ids['unique']!])],
    ] as const) {
      plans[name] = await placeQaRead(db, 2000, {}, async (read) => {
        await read.execute(
          sql`select set_config('pg_trgm.word_similarity_threshold','0.3',true),set_config('pg_trgm.similarity_threshold','0.3',true)`,
        );
        return (await read.execute(sql`explain (analyze,buffers,format json) ${query}`)).rows;
      });
    }
    // Migration 0102: the exact-name channel is an index scan on the name key,
    // unscoped, for a selective and for a broad name alike.
    const planText = (name: string) => JSON.stringify(plans[name]);
    const exactChannel = (name: string) => {
      const nodes: { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string }[] = [];
      const walk = (node: Record<string, unknown>) => {
        nodes.push(node as (typeof nodes)[number]);
        for (const child of (node['Plans'] as Record<string, unknown>[] | undefined) ?? [])
          walk(child);
      };
      walk(
        (plans[name] as { 'QUERY PLAN': { Plan: Record<string, unknown> }[] }[])[0]![
          'QUERY PLAN'
        ][0]!.Plan,
      );
      return nodes;
    };
    for (const name of ['exact', 'broad']) {
      expect(exactChannel(name).map((n) => n['Index Name'])).toContain('places_name_key_idx');
      // No sequential scan evaluates the key expression per row any more.
      expect(planText(name)).not.toMatch(/"Filter": "[^"]*regexp_replace/);
    }
    // A selective name never scans the table: the exact channel uses the name
    // key and the fuzzy OR is a BitmapOr over the trigram and FTS GIN indexes.
    const selective = exactChannel('exact');
    expect(selective.map((n) => n['Node Type'])).toContain('BitmapOr');
    expect(selective.map((n) => n['Index Name'])).toEqual(
      expect.arrayContaining(['places_name_trgm_idx', 'places_search_tsv_idx']),
    );
    expect(
      selective.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'places'),
    ).toEqual([]);
    // The ops script (large-table path) is idempotent after the migration and
    // its readiness check accepts exactly the migrated index shape.
    const ops = await readFile(
      path.resolve(__dirname, '../../../scripts/ops/index-place-name-key.sql'),
      'utf8',
    );
    let ready: unknown;
    for (const statement of ops
      .replace(/--[^\n]*/g, '')
      .split(';')
      .filter((part) => part.trim()))
      ready = (await pool.query(statement)).rows?.[0] ?? ready;
    expect(ready).toEqual({ places_name_key_idx_ready: 1 });
    const timings: Record<string, number[]> = { exact: [], broad: [], facts: [] };
    for (let i = 0; i < 30; i++)
      for (const kind of Object.keys(timings)) {
        const start = performance.now();
        if (kind === 'facts')
          await service.placeFacts([ids['facts']!, ids['unique']!], readOptions());
        else {
          const result = await service.resolvePlaceName(
            kind === 'exact' ? 'Mây Lam' : 'Corpus Venue',
          );
          expect(result.kind).toBe(kind === 'exact' ? 'answer' : 'narrow');
        }
        timings[kind]!.push(performance.now() - start);
      }
    const sourcePaths = [
      'libs/modules/search/application/search.service.ts',
      'libs/modules/search/infrastructure/place-qa-queries.ts',
      'libs/modules/search/infrastructure/place-qa-read.ts',
      'libs/modules/search/domain/place-facts.ts',
      'libs/modules/assistant/domain/place-qa/resolution.ts',
      'libs/modules/assistant/domain/place-qa/span.ts',
      'libs/database/src/schema/places.ts',
      'migrations/0102_place-name-key-index.sql',
      'scripts/ops/index-place-name-key.sql',
    ];
    const sourceHashes = Object.fromEntries(
      await Promise.all(
        sourcePaths.map(async (file) => [
          file,
          createHash('sha256')
            .update(await readFile(file))
            .digest('hex'),
        ]),
      ),
    );
    const evidence = {
      recordedAt: new Date().toISOString(),
      basis: 'working tree at run time; identity is sourceHashes below, not a commit',
      image: 'postgis/postgis:16-3.4',
      node: process.version,
      catalogueSize: (await db.execute(sql`select count(*)::int as count from places`)).rows[0],
      plans,
      timings,
      p95Ms: Object.fromEntries(
        Object.entries(timings).map(([k, v]) => [
          k,
          [...v].sort((a, b) => a - b)[Math.ceil(v.length * 0.95) - 1],
        ]),
      ),
      sourceHashes,
    };
    const dir = process.env['PLACE_QA_EVIDENCE_DIR'] ?? 'docs/plans/857-s2-evidence';
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'sql-performance.json'),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    expect(evidence.p95Ms['exact']).toBeLessThan(1000);
    expect(evidence.p95Ms['broad']).toBeLessThan(1000);
    expect(evidence.p95Ms['facts']).toBeLessThan(2000);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@gogo/database';
import { ASSISTANT_LLM, type AssistantLlmPort, type DecisionProviderPort } from '@gogo/providers';
import { SearchService } from '../../../libs/modules/search/application/search.service';
import { ASSISTANT_DECISION_PROVIDER } from '../../../libs/modules/assistant/application/assistant.config';
import { AssistantRepository } from '../../../libs/modules/assistant/infrastructure/assistant.repository';
import { normalizeVietnamese } from '../../../libs/modules/search/domain/normalize';
import corpus from '../../../libs/modules/assistant/eval/place-qa-cases.s5.vi.json';
import {
  startAssistantFixture,
  parseSse,
  type AssistantFixture,
} from './support/assistant-fixture';
import { placeNameKeyIndex } from './support/place-name-key';

let f: AssistantFixture;
let editor: string;
let moderator: string;
let ops: string;
let modelCalls = 0;
const ids: Record<string, string> = {};
const evidence = {
  sourceType: 'editorial',
  sourceReference: 'Merchant interview recorded 2026-11-01',
  collectedAt: '2026-11-01T10:00:00Z',
};
const readOptions = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 2000 });
const patch = (id: string, payload: object, token = editor) =>
  f.inject({ method: 'PATCH', url: `/v1/cms/places/${id}`, token, payload });
const detail = (id: string) =>
  f.inject({ method: 'GET', url: `/v1/cms/places/${id}`, token: editor });
const version = async (id: string) => (await detail(id)).json().updatedAt as string;
async function place(name: string, extra: Partial<typeof schema.places.$inferInsert> = {}) {
  const [p] = await f.db
    .insert(schema.places)
    .values({
      name,
      nameNormalized: 'trigger',
      status: 'published',
      geom: { x: 105.79, y: 21.03 },
      ...extra,
    })
    .returning();
  return p!.id;
}
beforeAll(async () => {
  f = await startAssistantFixture({
    OPENROUTER_API_KEY: 'fixture-no-network',
    OPENROUTER_ASSISTANT_API_KEY: 'fixture-no-network',
    ASSISTANT_USER_DAILY_MAX_MESSAGES: '1000',
    ASSISTANT_USER_PER_MINUTE_MAX_MESSAGES: '600',
    ASSISTANT_MONTHLY_MAX_USD: '100',
  });
  await placeNameKeyIndex(f.db);
  editor = await f.admin('s5-editor@example.test', 'editor');
  moderator = await f.admin('s5-moderator@example.test', 'moderator');
  ops = await f.admin('s5-ops@example.test', 'ops_admin');
  // Baseline-only fixture storage, never a production overlay: base must fail
  // at resolver/CMS symptom assertions, not because a table is missing.
  if (process.env.PLACE_QA_S5_BASELINE === '1')
    await f.db.execute(sql`
    create table place_aliases (place_id uuid, alias text, alias_normalized text,
      created_by uuid, created_at timestamptz default now(), source_type text,
      source_reference text, collected_at timestamptz)`);
  const actor = (
    await f.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.email, 's5-editor@example.test'))
  )[0]!;
  for (const fixture of corpus.places) {
    ids[fixture.key] = await place(fixture.name, {
      addressText: '12 Đường Hư Cấu',
      ...(fixture.key === 'brand1'
        ? {
            administrativeMappingStatus: 'VERIFIED',
            administrativeDatasetVersion: f.area.datasetVersion,
            provinceCode: f.area.provinceCode,
            communeCode: f.area.communeCode,
          }
        : {}),
    });
    // Like S4, supply the verified fact required by the public address question.
    await f.db.insert(schema.placeFieldProvenance).values({
      placeId: ids[fixture.key]!,
      field: 'address_text',
      sourceType: 'editorial',
      sourceReference: 'fictional merchant attestation',
      collectedAt: new Date(evidence.collectedAt),
      verifiedAt: new Date(evidence.collectedAt),
    });
    // Identical server-authored corpus on both heads, not model/provider input.
    for (const alias of fixture.aliases)
      await f.db.execute(sql`
      insert into place_aliases(place_id,alias,alias_normalized,created_by,source_type,source_reference,collected_at)
      values (${ids[fixture.key]}::uuid,${alias},${normalizeVietnamese(alias)},${actor.id}::uuid,'editorial',${evidence.sourceReference},${evidence.collectedAt}::timestamptz)`);
  }
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-11-12T10:00:00Z'));
  const decisions = f.app.get<DecisionProviderPort>(ASSISTANT_DECISION_PROVIDER);
  vi.spyOn(decisions, 'decide').mockImplementation(async () => {
    modelCalls++;
    throw new Error('S5 must not call a model');
  });
  const llm = f.app.get<AssistantLlmPort>(ASSISTANT_LLM);
  vi.spyOn(llm, 'stream').mockImplementation(async function* () {
    modelCalls++;
    yield { type: 'delta' as const, text: '' };
    throw new Error('S5 must not call a model');
  });
  await f.setFlag(true);
  await flag(true);
});
afterAll(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await f?.close();
});
async function flag(enabled: boolean) {
  await f.db
    .insert(schema.featureFlags)
    .values({ key: 'assistant.place_qa.enabled', environment: 'all', platform: 'all', enabled })
    .onConflictDoUpdate({
      target: [
        schema.featureFlags.key,
        schema.featureFlags.environment,
        schema.featureFlags.platform,
      ],
      set: { enabled },
    });
}

describe('S5 golden aliases — real resolver SQL', () => {
  it('applies stated current area before alias-family cutoff', async () => {
    const result = await f.app
      .get(SearchService)
      .resolvePlaceName('Mộc Tea', { ...readOptions(), area: { kind: 'current', ...f.area } });
    expect(result.kind).toBe('answer');
    expect(result.candidates.filter((p) => p.exact).map((p) => p.id)).toEqual([ids['brand1']]);
  });
  for (const c of corpus.cases)
    it(`${c.id}: ${c.category}`, async () => {
      const result = await f.app.get(SearchService).resolvePlaceName(c.query, readOptions());
      expect(result.kind, 'SYMPTOM: whole curated alias must resolve exactly').toBe(c.kind);
      expect(
        result.candidates
          .filter((p) => p.exact)
          .map((p) => p.id)
          .sort(),
        'SYMPTOM: alias must select the expected exact venues',
      ).toEqual(c.keys.map((k) => ids[k]!).sort());
    });
  it('groups nine aliases for one place before fuzzy cutoff; partial alias only confirms', async () => {
    const result = await f.app.get(SearchService).resolvePlaceName('Nhà Bên Hồ', readOptions());
    expect(result.kind).toBe('confirm');
    expect(result.candidates.filter((p) => p.id === ids['coffee'])).toHaveLength(1);
  });
});

describe('S5 alias Layer A companion — original S4 oracle untouched', () => {
  for (const c of corpus.cases)
    it(`${c.id}: public question → SSE → history, zero models`, async () => {
      modelCalls = 0;
      const token = await f.register(`s5-${c.id}@example.test`);
      const conversation = await f.inject({
        method: 'POST',
        url: '/v1/assistant/conversations',
        token,
        payload: { title: 'Alias fixture' },
      });
      expect(conversation.statusCode, 'BLOCKED if admission fails').toBe(201);
      const cid = conversation.json().id;
      const sent = await f.inject({
        method: 'POST',
        url: `/v1/assistant/conversations/${cid}/messages`,
        token,
        headers: { 'idempotency-key': randomUUID() },
        payload: { text: `${c.query.trim()} ở đâu?` },
      });
      expect(sent.statusCode, 'BLOCKED if admission fails').toBe(202);
      const mid = sent.json().assistantMessage.id;
      const stream = await f.sse(
        `/v1/assistant/conversations/${cid}/messages/${mid}/stream`,
        token,
      );
      expect(stream.status).toBe(200);
      const frames = parseSse(stream.body);
      expect(
        frames
          .filter((x) => x.event === 'card')
          .map((x) => x.data.card.placeId)
          .sort(),
        'SYMPTOM: alias must return its venue cards',
      ).toEqual(c.keys.map((k) => ids[k]!).sort());
      // A fuzzy canonical hit can emit the same card as an exact alias hit.
      // Its extra confirmation is still the pre-S5 user-facing failure.
      expect(
        frames
          .filter((x) => x.event === 'follow_ups')
          .flatMap((x) => x.data.groups)
          .some((g: { field: string }) => g.field === 'place_confirm'),
        'SYMPTOM: exact alias must not ask for fuzzy confirmation',
      ).toBe(false);
      const stored = await f.app.get(AssistantRepository).findMessageById(mid);
      expect(stored?.trace?.route).toBe('place_qa');
      expect((stored?.trace?.placeQa as { outcome?: string } | undefined)?.outcome).toBe(c.kind);
      expect(modelCalls).toBe(0);
      expect(frames.some((x) => x.event === 'proposal')).toBe(false);
      expect(
        frames
          .filter((x) => x.event === 'follow_ups')
          .flatMap((x) => x.data.groups)
          .some((g: { field: string }) => ['area', 'budget', 'activity'].includes(g.field)),
      ).toBe(false);
      const persisted = JSON.stringify([stored?.text, stored?.frames, stored?.trace]);
      for (const fixture of corpus.places) {
        expect(persisted).not.toContain(fixture.name);
        for (const alias of fixture.aliases) expect(persisted).not.toContain(alias);
      }
      const history = await f.inject({
        method: 'GET',
        url: `/v1/assistant/conversations/${cid}/messages?limit=50`,
        token,
      });
      expect(history.statusCode).toBe(200);
      const message = history.json().items.find((m: { id: string }) => m.id === mid);
      expect(message.text).toBe(
        frames
          .filter((x) => x.event === 'delta')
          .map((x) => x.data.text)
          .join(''),
      );
    });
});

describe('S5 CMS atomic editorial replacement', () => {
  it('round trips aliases, deduplicates, audits evidence without raw aliases, preserves omitted set, clears with evidence', async () => {
    const id = await place('Tiệm Bánh Bình An');
    const before = await version(id);
    const res = await patch(id, {
      aliases: ['BA Bakery', 'ba bakery'],
      aliasProvenance: evidence,
      expectedUpdatedAt: before,
    });
    expect(res.statusCode).toBe(200);
    expect((await detail(id)).json().aliases).toEqual(['ba bakery']);
    const audit = await f.db.execute(
      sql`select diff from audit_logs where resource_id=${id}::text and action='place.aliases_updated'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain('ba bakery');
    expect(audit.rows[0]!.diff).toMatchObject({
      before: { count: 0 },
      after: { count: 1 },
      evidence: { ...evidence, collectedAt: new Date(evidence.collectedAt).toISOString() },
    });
    expect(
      (
        await patch(id, {
          aliases: ['Bakery Bình An'],
          aliasProvenance: evidence,
          expectedUpdatedAt: before,
        })
      ).statusCode,
    ).toBe(409);
    expect((await patch(id, { description: 'Tiệm bánh thủ công' })).statusCode).toBe(200);
    expect((await detail(id)).json().aliases).toEqual(['ba bakery']);
    expect(
      (
        await patch(id, {
          aliases: [],
          aliasProvenance: evidence,
          expectedUpdatedAt: await version(id),
        })
      ).statusCode,
    ).toBe(200);
    expect((await detail(id)).json().aliases).toEqual([]);
  });
  it('serializes competing saves: exactly one wins and one conflicts', async () => {
    const id = await place('Cà Phê Vườn Nhỏ');
    const expectedUpdatedAt = await version(id);
    const results = await Promise.all(
      ['Garden Coffee', 'Little Garden Cafe'].map((alias) =>
        patch(id, { aliases: [alias], aliasProvenance: evidence, expectedUpdatedAt }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await detail(id)).json().aliases).toHaveLength(1);
  });
  it('rejects non-editor writes, missing version, missing/Google evidence and control payloads', async () => {
    const id = await place('Cà Phê Đầu Ngõ');
    const expectedUpdatedAt = await version(id);
    const valid = { aliases: ['Corner Coffee'], aliasProvenance: evidence, expectedUpdatedAt };
    for (const token of [moderator, ops])
      expect((await patch(id, valid, token)).statusCode).toBe(403);
    for (const payload of [
      { ...valid, expectedUpdatedAt: undefined },
      { ...valid, aliasProvenance: undefined },
      {
        ...valid,
        aliasProvenance: { ...evidence, sourceReference: 'https://maps.google.com/cafe' },
      },
      { ...valid, aliases: ['Corner Coffee\n'] },
      { ...valid, aliases: [''] },
      { ...valid, aliases: Array(21).fill('Corner Coffee') },
      { ...valid, aliases: ['a'.repeat(121)] },
    ])
      expect((await patch(id, payload)).statusCode).toBe(400);
    expect((await detail(id)).json().aliases).toEqual([]);
  });
  it('foreign key cascades place deletion; staff deletion nulls attribution and preserves editorial content', async () => {
    const id = await place('Quán Trà Hiên Nhà');
    const staff = randomUUID();
    await f.db.execute(
      sql`insert into admin_users(id,email,display_name,role) values (${staff}::uuid,${`${staff}@example.test`},'Fixture staff','editor')`,
    );
    await f.db.execute(
      sql`insert into place_aliases(place_id,alias,alias_normalized,created_by,source_type,source_reference,collected_at) values (${id}::uuid,'Porch Tea','porch tea',${staff}::uuid,'editorial',${evidence.sourceReference},now())`,
    );
    await f.db.execute(sql`delete from admin_users where id=${staff}::uuid`);
    expect(
      (await f.db.execute(sql`select created_by from place_aliases where place_id=${id}::uuid`))
        .rows,
    ).toEqual([{ created_by: null }]);
    await f.db.delete(schema.places).where(eq(schema.places.id, id));
    expect(
      (await f.db.execute(sql`select * from place_aliases where place_id=${id}::uuid`)).rows,
    ).toEqual([]);
  });
});

// Astra round 1 cells: keep the S4 oracle and the original S5 golden rows intact.
describe('S5 Astra round 1 regressions', () => {
  async function turn(token: string, cid: string, text: string, extra: object = {}) {
    const sent = await f.inject({
      method: 'POST',
      url: `/v1/assistant/conversations/${cid}/messages`,
      token,
      headers: { 'idempotency-key': randomUUID() },
      payload: { text, ...extra },
    });
    expect(sent.statusCode, 'BLOCKED: conversation admission').toBe(202);
    const mid = sent.json().assistantMessage.id;
    const stream = await f.sse(`/v1/assistant/conversations/${cid}/messages/${mid}/stream`, token);
    expect(stream.status, 'BLOCKED: SSE transport').toBe(200);
    const frames = parseSse(stream.body);
    expect(
      frames.some((x) => x.event === 'error'),
      'BLOCKED: turn execution',
    ).toBe(false);
    const stored = await f.app.get(AssistantRepository).findMessageById(mid);
    const qa = stored?.trace?.placeQa as {
      outcome: string;
      topic: string;
      args: unknown;
      pending?: {
        kind: string;
        topic: string;
        args: unknown;
        questionMessageId: string;
        createdAt: string;
        expiresAt: string;
        slots: unknown[];
        activeSlot: number;
      };
    };
    const history = await f.inject({
      method: 'GET',
      url: `/v1/assistant/conversations/${cid}/messages?limit=50`,
      token,
    });
    expect(history.statusCode).toBe(200);
    const message = history.json().items.find((m: { id: string }) => m.id === mid);
    const groups = frames.filter((x) => x.event === 'follow_ups').flatMap((x) => x.data.groups);
    expect(message.followUps).toEqual(groups);
    expect(message.text).toBe(
      frames
        .filter((x) => x.event === 'text_delta')
        .map((x) => x.data.delta)
        .join(''),
    );
    return { mid, qa, groups, message };
  }
  it.each([
    ['address', 'Lakeside Coffe ở đâu?'],
    ['hours', 'Lakeside Coffe mở cửa ngày mai?'],
    ['compare', 'Tiệm Bánh An Nhiên với Lakeside Coffe quán nào rẻ hơn?'],
  ])(
    'F-01 %s: pending alias re-asks before answering the original question',
    async (_cell, question) => {
      modelCalls = 0;
      const token = await f.register(`s5-r1-${randomUUID()}@example.test`);
      const conversation = await f.inject({
        method: 'POST',
        url: '/v1/assistant/conversations',
        token,
        payload: { title: 'Pending alias' },
      });
      expect(conversation.statusCode, 'BLOCKED: conversation admission').toBe(201);
      const cid = conversation.json().id;
      const first = await turn(token, cid, question);
      expect(first.qa.outcome, 'BLOCKED: typo must establish pending confirmation').toBe('confirm');
      const reply = await turn(token, cid, 'Lakeside Coffee');
      expect(reply.qa.outcome, 'SYMPTOM: bare pending alias must re-ask confirmation').toBe(
        'confirm',
      );
      expect(reply.qa.pending).toMatchObject({
        questionMessageId: first.qa.pending!.questionMessageId,
        topic: first.qa.pending!.topic,
        args: first.qa.pending!.args,
        slots: first.qa.pending!.slots,
        activeSlot: first.qa.pending!.activeSlot,
        createdAt: first.qa.pending!.createdAt,
        expiresAt: first.qa.pending!.expiresAt,
      });
      expect(reply.groups.some((g: { field: string }) => g.field === 'place_confirm')).toBe(true);
      const option = reply.groups.find((g: { field: string }) => g.field === 'place_confirm')
        .options[0];
      const done = await turn(token, cid, option.text, {
        replyToMessageId: reply.mid,
        followUpOptionId: option.id,
      });
      expect(done.qa.topic).toBe(first.qa.topic);
      expect(done.qa.args).toEqual(first.qa.args);
      expect(done.qa.outcome).toBe(_cell === 'address' ? 'answer' : 'no_data');
      expect([undefined, 'topic']).toContain(done.qa.pending?.kind);
      expect(done.message.cards.map((c: { placeId: string }) => c.placeId)).toEqual(
        _cell === 'compare' ? [ids['bakery'], ids['coffee']] : [ids['coffee']],
      );
      expect(modelCalls).toBe(0);
    },
  );

  const merge = (canonicalId: string, duplicateId: string) =>
    f.inject({
      method: 'POST',
      url: `/v1/cms/places/${canonicalId}/merge`,
      token: editor,
      payload: { duplicateId },
    });
  const aliasRows = async (id: string) =>
    (await f.db.select().from(schema.placeAliases).where(eq(schema.placeAliases.placeId, id))).sort(
      (a, b) => a.aliasNormalized.localeCompare(b.aliasNormalized),
    );
  const digest = (keys: string[]) =>
    createHash('sha256')
      .update(JSON.stringify([...keys].sort()))
      .digest('hex');

  it('F-02 transfer: merge retains resolution, provenance, canonical collisions, version and private audit', async () => {
    const canonical = await place('Cà Phê Vườn Ban Mai');
    const duplicate = await place('Vườn Ban Mai Coffee');
    expect(
      (
        await patch(canonical, {
          aliases: ['Morning Garden Coffee'],
          aliasProvenance: evidence,
          expectedUpdatedAt: await version(canonical),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await patch(duplicate, {
          aliases: ['morning garden coffee', 'Cafe Vườn Sớm'],
          aliasProvenance: {
            ...evidence,
            sourceReference: 'Historical menu supplied by the merchant',
          },
          expectedUpdatedAt: await version(duplicate),
        })
      ).statusCode,
    ).toBe(200);
    const kept = await aliasRows(canonical);
    const moved = (await aliasRows(duplicate)).find((a) => a.aliasNormalized === 'cafe vuon som')!;
    const before = await version(canonical);
    expect((await merge(canonical, duplicate)).statusCode).toBe(201);
    expect(
      (await detail(canonical)).json().aliases,
      'SYMPTOM: merged aliases must remain on the canonical place',
    ).toEqual(['Cafe Vườn Sớm', 'Morning Garden Coffee']);
    expect(await aliasRows(canonical)).toEqual([{ ...moved, placeId: canonical }, ...kept]);
    expect(await aliasRows(duplicate)).toEqual([]);
    expect((await detail(duplicate)).json().status).toBe('archived');
    expect(Date.parse(await version(canonical))).toBeGreaterThan(Date.parse(before));
    expect(
      (
        await patch(canonical, {
          aliases: ['Morning Garden Coffee'],
          aliasProvenance: evidence,
          expectedUpdatedAt: before,
        })
      ).statusCode,
    ).toBe(409);
    const resolved = await f.app
      .get(SearchService)
      .resolvePlaceName('Cafe Vườn Sớm', readOptions());
    expect(resolved.kind).toBe('answer');
    expect(resolved.candidates.filter((c) => c.exact).map((c) => c.id)).toEqual([canonical]);
    const audits = (
      await f.db.execute(
        sql`select diff from audit_logs where action='place.merged' and resource_id=${canonical}::text`,
      )
    ).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.diff).toEqual({
      duplicateId: duplicate,
      aliases: {
        before: { count: 1, digest: digest(['morning garden coffee']) },
        duplicate: { count: 2, digest: digest(['morning garden coffee', 'cafe vuon som']) },
        after: { count: 2, digest: digest(['morning garden coffee', 'cafe vuon som']) },
      },
    });
    expect(JSON.stringify(audits)).not.toMatch(/Morning Garden|morning garden|Cafe Vườn|cafe vuon/);
  });

  // Plausible former names, translations and local nicknames for a long-lived
  // fictional venue; do not use numbered aliases merely to fill a limit.
  const historicalNames = [
    'Cà Phê Bến Sông',
    'Bến Sông Coffee',
    'Riverside Coffee',
    'Riverbank Cafe',
    'Cafe Bờ Sông',
    'Cà Phê Ven Sông',
    'Tiệm Cà Phê Bến Cũ',
    'Old Wharf Coffee',
    'Quán Bến Xưa',
    'Cafe Bến Xưa',
    'Cà Phê Bến Vắng',
    'Quiet Wharf Cafe',
    'Cà Phê Bến Nhỏ',
    'Little Wharf Coffee',
    'BS Coffee',
    'Ben Song Cafe',
    'Cà Phê Nhà Bến',
    'Nhà Bên Sông',
    'The River House',
    'River House Coffee',
  ];
  it.each([20, 21])(
    'F-02 bound %i: deduplicates the union or rejects the entire merge',
    async (count) => {
      const canonical = await place('Cà Phê Bến Sông');
      const duplicate = await place('Tiệm Cà Phê Bến Cũ');
      const originalNames = historicalNames.slice(0, count === 20 ? 19 : 20);
      expect(
        (
          await patch(canonical, {
            aliases: originalNames,
            aliasProvenance: evidence,
            expectedUpdatedAt: await version(canonical),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await patch(duplicate, {
            aliases: ['riverside coffee', 'Wharfside Coffee'],
            aliasProvenance: evidence,
            expectedUpdatedAt: await version(duplicate),
          })
        ).statusCode,
      ).toBe(200);
      const beforeCanonical = await aliasRows(canonical);
      const beforeDuplicate = await aliasRows(duplicate);
      const beforeVersion = await version(canonical);
      const beforeDuplicateVersion = await version(duplicate);
      // Exercise rollback of other references too, not only the alias table.
      await f.db
        .insert(schema.placeMedia)
        .values({ placeId: duplicate, storageKey: 'fixtures/wharf.jpg' });
      const outboxBefore = (
        await f.db.execute(
          sql`select * from outbox_events where resource_id in (${canonical}, ${duplicate}) order by id`,
        )
      ).rows;
      const result = await merge(canonical, duplicate);
      if (count === 20) {
        expect(result.statusCode).toBe(201);
        expect(await aliasRows(canonical)).toHaveLength(20);
        expect(await aliasRows(duplicate)).toEqual([]);
      } else {
        expect(result.statusCode, 'SYMPTOM: overflow must reject the entire merge').toBe(409);
        expect(result.json().code).toBe('PLACE_ALIAS_LIMIT_EXCEEDED');
        expect(await aliasRows(canonical)).toEqual(beforeCanonical);
        expect(await aliasRows(duplicate)).toEqual(beforeDuplicate);
        expect(await version(canonical)).toBe(beforeVersion);
        expect(await version(duplicate)).toBe(beforeDuplicateVersion);
        expect((await detail(duplicate)).json().status).toBe('published');
        expect(
          await f.db
            .select()
            .from(schema.placeMedia)
            .where(eq(schema.placeMedia.placeId, duplicate)),
        ).toHaveLength(1);
        expect(
          (
            await f.db.execute(
              sql`select * from audit_logs where action='place.merged' and resource_id=${canonical}::text`,
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await f.db.execute(
              sql`select * from outbox_events where resource_id in (${canonical}, ${duplicate}) order by id`,
            )
          ).rows,
        ).toEqual(outboxBefore);
      }
    },
  );
});

import { describe, expect, it } from 'vitest';
import { parseIntentFacts } from '../../search/domain/intent';
import { readMessage } from './assertion';
import {
  applyChip,
  applyNewest,
  chipsFor,
  fieldsOfSide,
  firstPending,
  hasDetails,
  isReconcileState,
  itemQuestion,
  joinRequests,
  joinedRequest,
  modeQuestion,
  resolvedPayload,
  sideOf,
  type AreaValue,
  type ItemChip,
  type ReconciledRequest,
  type RequestSide,
} from './reconcile';

/**
 * GoGo-BE#738 (owner 2026-11-01, shape rev 4): the owner's example — "Cho tôi
 * quán cà phê lãng mạn cho 2 người ở Hà Nội" then "Cho tôi quán cà phê ngoài
 * trời cho 3 người". Same kind of place: kept, not asked. Asked one at a time:
 * romantic or outdoor (or both), 3 people, still Hà Nội.
 */
const labels = new Map([
  ['category:cafe', 'cà phê'],
  ['category:restaurant', 'nhà hàng'],
  ['romantic', 'lãng mạn'],
  ['outdoor', 'ngoài trời'],
  ['date', 'hẹn hò'],
  ['birthday', 'sinh nhật'],
  ['couple', 'Cặp đôi'],
  ['group', 'Nhóm bạn'],
]);
const termsOf = (key: string) => [labels.get(key) ?? key];
const HA_NOI: AreaValue = {
  kind: 'resolved',
  codes: { datasetVersion: 'v5', provinceCode: '01', communeCode: null },
  label: 'Thành phố Hà Nội',
};
const side = (
  text: string,
  keys: Partial<{ category: string; occasion: string; moods: string[]; settings: string[] }>,
  area: AreaValue = { kind: 'absent' },
): RequestSide => {
  const facts = parseIntentFacts(text);
  return sideOf({
    facts,
    dayPart: null,
    area,
    keys: {
      category: keys.category ?? null,
      occasion: keys.occasion ?? null,
      moods: keys.moods ?? [],
      settings: keys.settings ?? [],
    },
    texts: [text],
    termsOf,
  });
};
const OLD = side(
  'Cho tôi quán cà phê lãng mạn cho 2 người ở Hà Nội',
  { category: 'category:cafe', moods: ['romantic'] },
  HA_NOI,
);
const NEW = side('Cho tôi quán cà phê ngoài trời cho 3 người', {
  category: 'category:cafe',
  settings: ['outdoor'],
});
const keys = {
  intent: 'recommend_places',
  action: 'none',
  category: 'category:cafe',
  occasion: null,
  moods: [],
  settings: [],
  model: null,
};
const walk = (old: RequestSide, fresh: RequestSide): ReconciledRequest => {
  const { values, items } = joinRequests(fieldsOfSide(old), fresh);
  return {
    v: 2,
    refs: { old: [{ id: 'a', allowBareArea: false }], new: { id: 'b', allowBareArea: false } },
    intents: { old: keys, new: keys },
    values,
    items,
    asked: 0,
    offset: 0,
    status: 'asking',
  };
};
/** Answers every item in turn; `pick` chooses a chip by item. */
const answer = (st: ReconciledRequest, pick: (chips: ItemChip[], field: string) => ItemChip) => {
  let state = st;
  for (;;) {
    const asked = firstPending(state);
    if (asked === null) return state;
    state = { ...state, asked };
    const item = state.items[asked]!;
    const chips = chipsFor(item, state.values[item.field]!.pending!, state.offset);
    state = applyChip(state, pick(chips, item.field));
  }
};

describe('#738 reconcile: the owner example', () => {
  it('asks the wishes, the party size and the area — not the same kind of place', () => {
    expect(joinRequests(fieldsOfSide(OLD), NEW).items).toEqual([
      { field: 'preferences', kind: 'changed' },
      { field: 'partySize', kind: 'changed' },
      { field: 'area', kind: 'old_only' },
    ]);
  });

  it('words each question with the new value first, from fixed vocabulary', () => {
    const st = walk(OLD, NEW);
    const q = (i: number) => {
      const item = st.items[i]!;
      return itemQuestion(item, st.values[item.field]!.pending!, 0, labels, 'vi');
    };
    expect(q(0).text).toBe('Bạn muốn ngoài trời hay lãng mạn?');
    expect(q(0).group.options.map((o) => o.label)).toEqual(['ngoài trời', 'lãng mạn', 'Cả hai']);
    expect(q(1).text).toBe('Bạn muốn cho 3 người? (trước đó là 2 người)');
    expect(q(2).text).toBe('Bạn vẫn muốn ở Thành phố Hà Nội?');
    expect(modeQuestion('vi').group.options.map((o) => o.text)).toEqual([
      'Tạo yêu cầu mới',
      'Giữ thông tin cũ và cập nhật',
    ]);
  });

  it('joins the answers: both wishes, 3 people, Hà Nội kept', () => {
    const done = answer(walk(OLD, NEW), (chips, field) =>
      field === 'preferences' ? { kind: 'both' } : chips[0]!,
    );
    const joined = joinedRequest(done);
    expect(joined.moods).toEqual(['romantic']);
    expect(joined.settings).toEqual(['outdoor']);
    expect(joined.facts.partySize).toBe(3);
    expect(joined.area).toEqual(HA_NOI);
    expect(joined.category).toBe('category:cafe');
  });

  it('a dropped area and the old wishes chosen', () => {
    const done = answer(walk(OLD, NEW), (chips, field) =>
      field === 'area' ? { kind: 'drop' } : field === 'preferences' ? chips[1]! : chips[0]!,
    );
    const joined = joinedRequest(done);
    expect(joined.moods).toEqual(['romantic']);
    expect(joined.settings).toEqual([]);
    expect(joined.area.kind).toBe('absent');
    expect(joined.facts.areaText).toBeNull();
  });

  it('stored state carries ids, keys, numbers and dataset labels — no message text', () => {
    const json = JSON.stringify(walk(OLD, NEW));
    expect(json).not.toContain('Cho tôi');
    expect(json).not.toContain('quán');
    expect(isReconcileState(walk(OLD, NEW))).toBe(true);
  });

  it('a walk stored before D-15 is not read back', () => {
    expect(
      isReconcileState({
        oldRefs: [{ id: 'a', allowBareArea: false }],
        newRef: { id: 'b', allowBareArea: false },
        items: [],
        asked: null,
        oldIntent: keys,
        newIntent: keys,
        choices: {},
      }),
    ).toBe(false);
  });
});

describe('#738 D-9 per field', () => {
  const stated = (category: string, text: string) => side(text, { category });

  it('stated vs stated differ → asked; the same → kept', () => {
    const a = stated('category:cafe', 'quán cà phê');
    const b = stated('category:restaurant', 'nhà hàng');
    expect(joinRequests(fieldsOfSide(a), b).items).toEqual([
      { field: 'category', kind: 'changed' },
    ]);
    expect(joinRequests(fieldsOfSide(a), a).items).toEqual([]);
  });

  it('stated old + inferred new → old kept, no item', () => {
    const a = stated('category:cafe', 'quán cà phê');
    const b = side('chỗ nào đó', { category: 'category:restaurant' });
    const { items, values } = joinRequests(fieldsOfSide(a), b);
    expect(items).toEqual([]);
    expect(values.category!.value).toMatchObject({ value: 'category:cafe', provenance: 'stated' });
  });

  it('inferred vs inferred → newest, assumed; inferred old + stated new → new wins', () => {
    const a = side('2 người', { occasion: 'couple' });
    const b = side('3 người', { occasion: 'group' });
    expect(joinRequests(fieldsOfSide(a), b).values.occasion!.value).toMatchObject({
      value: 'group',
      provenance: 'inferred',
    });
    const c = side('đi hẹn hò', { occasion: 'date' });
    expect(joinRequests(fieldsOfSide(a), c).values.occasion!.value).toMatchObject({
      value: 'date',
      provenance: 'stated',
    });
  });

  it('absent old takes the new value; an inferred old with nothing new stays assumed', () => {
    const a = side('quán', {});
    const b = stated('category:cafe', 'quán cà phê');
    expect(joinRequests(fieldsOfSide(a), b).values.category!.value!.value).toBe('category:cafe');
    const c = side('2 người', { occasion: 'couple' });
    expect(joinRequests(fieldsOfSide(c), a).values.occasion!.value!.provenance).toBe('inferred');
    expect(joinRequests(fieldsOfSide(c), a).items.map((i) => i.field)).not.toContain('occasion');
  });

  it('a request with no details has nothing to keep', () => {
    expect(hasDetails(side('đi đâu đó', {}))).toBe(false);
    expect(hasDetails(side('2 người', {}))).toBe(true);
    expect(hasDetails(OLD)).toBe(true);
  });
});

describe('#738 D-17 area', () => {
  const area = (value: AreaValue) => side('quán cà phê', {}, value);
  const OTHER: AreaValue = {
    kind: 'resolved',
    codes: { datasetVersion: 'v5', provinceCode: '79', communeCode: null },
    label: 'Thành phố Hồ Chí Minh',
  };

  it('both resolved and different → changed; the same codes → nothing', () => {
    expect(joinRequests(fieldsOfSide(area(HA_NOI)), area(OTHER)).items).toEqual([
      { field: 'area', kind: 'changed' },
    ]);
    expect(joinRequests(fieldsOfSide(area(HA_NOI)), area(HA_NOI)).items).toEqual([]);
  });

  for (const kind of ['none', 'ambiguous', 'scope_choice'] as const) {
    it(`an old "${kind}" area is no item and is not dropped`, () => {
      const { items, values } = joinRequests(
        fieldsOfSide(area({ kind, messageIds: ['a'] })),
        area({ kind: 'absent' }),
      );
      expect(items).toEqual([]);
      expect((values.area!.value!.value as AreaValue).kind).toBe(kind);
    });
  }
});

describe('#738 O-7 (a) candidates in stages', () => {
  const party = (n: number) => ({ value: n, provenance: 'stated' as const });
  const item = { field: 'partySize' as const, kind: 'changed' as const };

  it('never truncates: two stages reach all four, newest first', () => {
    const pending = [party(5), party(4), party(2), party(3)];
    expect(chipsFor(item, pending, 0)).toEqual([
      { kind: 'pick', index: 0 },
      { kind: 'pick', index: 1 },
      { kind: 'more', offset: 2 },
    ]);
    expect(chipsFor(item, pending, 2)).toEqual([
      { kind: 'pick', index: 2 },
      { kind: 'pick', index: 3 },
    ]);
    const q = itemQuestion(item, pending, 0, labels, 'vi');
    expect(q.group.options.map((o) => o.label)).toEqual(['5 người', '4 người', 'Giá trị khác…']);
    expect(q.group.options.length).toBeLessThanOrEqual(3);
  });

  it('a list of three fits one stage', () => {
    expect(chipsFor(item, [party(4), party(2), party(3)], 0)).toHaveLength(3);
  });

  it('a pair on the earlier side comes back with the new value in front', () => {
    const { values, items } = joinRequests(
      { partySize: { pending: [party(3), party(2)] } },
      { partySize: party(4) },
    );
    expect(items).toEqual([{ field: 'partySize', kind: 'changed' }]);
    expect(values.partySize!.pending!.map((p) => p.value)).toEqual([4, 3, 2]);
  });

  it('a pending field is `open` to the models, and holds no value', () => {
    const st = walk(OLD, NEW);
    expect(joinedRequest(st).facts.partySize).toBeNull();
    expect(resolvedPayload(st, labels).open).toContain('partySize');
    expect(resolvedPayload(st, labels).settled.category).toBe('category:cafe');
  });
});

describe('#738 D-15 applyNewest', () => {
  const final = (): ReconciledRequest => ({
    ...answer(walk(OLD, NEW), (chips) => chips[0]!),
    asked: null,
    status: 'final',
  });
  const apply = (
    st: ReconciledRequest,
    text: string,
    jev: Parameters<typeof applyNewest>[1]['jev'] = null,
  ) => applyNewest(st, { reading: readMessage(text), area: null, jev, termsOf });

  it('a stated value replaces, a rejected one re-queues, a mention does nothing', () => {
    const st = final();
    expect(joinedRequest(apply(st, '5 người nhé')).facts.partySize).toBe(5);
    const denied = apply(st, 'không phải 3 người');
    expect(firstPending(denied)).not.toBeNull();
    expect(denied.values.partySize!.pending!.map((p) => p.value)).toEqual([2]);
    expect(apply(st, 'rẻ hơn chút').values.partySize).toEqual(st.values.partySize);
  });

  it('a rejection with nothing to fall back on asks with no chips', () => {
    const lone = walk(side('2 người', {}), side('2 người', {}));
    const denied = apply({ ...lone, status: 'final' }, 'không phải 2 người');
    const item = denied.items.at(-1)!;
    expect(item).toEqual({ field: 'partySize', kind: 'open' });
    expect(itemQuestion(item, [], 0, labels, 'vi').group.options).toEqual([]);
  });

  it('Jev fills an absent field as assumed, replaces nothing it was not told', () => {
    const st = final();
    const next = apply(st, 'rẻ hơn chút', {
      category: 'category:restaurant',
      occasion: 'group',
      moods: ['romantic'],
      settings: [],
    });
    expect(next.values.category).toEqual(st.values.category);
    expect(next.values.occasion!.value).toEqual({ value: 'group', provenance: 'inferred' });
    expect(next.values.preferences).toEqual(st.values.preferences);
  });

  it('what the newest message names does replace', () => {
    const next = apply(final(), 'đổi sang nhà hàng', {
      category: 'category:restaurant',
      occasion: null,
      moods: [],
      settings: [],
    });
    expect(next.values.category!.value).toMatchObject({
      value: 'category:restaurant',
      provenance: 'stated',
    });
  });

  it('a rejected wish leaves the set and is asked about', () => {
    const both: ReconciledRequest = {
      ...answer(walk(OLD, NEW), (chips, field) =>
        field === 'preferences' ? { kind: 'both' } : chips[0]!,
      ),
      asked: null,
      status: 'final',
    };
    const next = apply(both, 'không ngoài trời');
    expect(next.values.preferences!.pending!.map((p) => p.value)).toEqual([
      { moods: ['romantic'], settings: [] },
    ]);
  });
});

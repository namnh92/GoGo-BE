import { boundedResolved } from './request-caps';
import type { DecisionCriterion } from '@gogo/providers';
import type { DayPart, IntentFacts, TimeHint } from '../../search/domain/intent';
import { normalizeVietnamese } from '../../search/domain/normalize';
import {
  bareBudget,
  bareParty,
  assertedText,
  bareTerm,
  bareTime,
  statesTerm,
  termStatus,
  type MessageReading,
} from './assertion';
import type { AssistantFollowUpGroup } from './assistant.types';

/**
 * GoGo-BE#738 (shape `sa-shape-be-738-turn-relation.fable.md` rev 4, owner
 * 2026-11-01, 2026-11-02) — a new request typed after a place request that
 * already said things: the person is asked whether to start over or keep what
 * was said and update it; keeping walks one question per item, then joins.
 *
 * One persisted state (`ReconciledRequest`, D-15) carries every value with its
 * provenance, so a later turn never parses the source messages again for a
 * value. Stated, typed or confirmed beats inferred; inferred never replaces
 * (D-9, I-8). A field two values compete for stays a candidate list until the
 * person settles it: never truncated, never defaulted.
 *
 * Pure and deterministic: no model writes a question, an option or a merged
 * value. Stored state is ids, keys, codes, numbers and dataset labels — never
 * message text (I-3).
 */

export type Provenance = 'stated' | 'inferred' | 'confirmed' | 'typed';

/** Area with its status, so `absent` and `unresolved` stay apart (D-17). */
export type AreaValue = {
  kind: 'resolved' | 'none' | 'ambiguous' | 'scope_choice' | 'absent';
  codes?: { datasetVersion: string; provinceCode: string; communeCode: string | null };
  /** The dataset's name, never the person's spelling (I-2). */
  label?: string;
  /** A phrase was typed and placed nowhere: the question says so (A-F-09). */
  typed?: boolean;
  /** A city and a ward of the same name: the dataset units the person chooses from. */
  scope?: { province: ScopeUnitValue; communes: ScopeUnitValue[] };
};
/** A dataset unit as the scope question shows it (#733 D-6): codes and dataset names. */
export type ScopeUnitValue = { code: string; name: string; fullName: string };
export type TimeValue = { timeHint: TimeHint | null; dayPart: DayPart | null };
export type BudgetValue = NonNullable<IntentFacts['budget']>;
export type PrefsValue = { moods: string[]; settings: string[] };
export type FieldValue = string | number | AreaValue | TimeValue | BudgetValue | PrefsValue;

/** One value a field may hold. Preferences carry provenance per key (`keys`). */
export type Candidate = {
  value: FieldValue;
  provenance: Provenance;
  keys?: Record<string, Provenance>;
};

export const RECONCILE_FIELDS = [
  'category',
  'preferences',
  'partySize',
  'area',
  'time',
  'budget',
  'occasion',
] as const;
export type ReconcileField = (typeof RECONCILE_FIELDS)[number];

/** One request's values. A field it did not say is absent. */
export type RequestSide = Partial<Record<ReconcileField, Candidate>>;

/**
 * A field's state: `value` once settled; `pending` while it is an ask cell,
 * newest first (D-15, any length); `others` the values not taken, which a
 * rejection brings back (D-19).
 */
export type FieldState = { value?: Candidate; pending?: Candidate[]; others?: Candidate[] };

/**
 * `changed`: several candidates. `old_only`: one, kept or dropped.
 * `open`: none left after a rejection — the person types it.
 */
export type ReconcileItem = { field: ReconcileField; kind: 'changed' | 'old_only' | 'open' };

export type Ref = { id: string; allowBareArea: boolean };

/** The classification keys of one request, as its turn's trace keeps them. */
export type IntentKeys = {
  intent: string;
  action: string;
  category: string | null;
  occasion: string | null;
  moods: string[];
  settings: string[];
  model: string | null;
};

/**
 * What a turn stores (in its trace, D-15) for the next one to read. `asked` is
 * the item asked on this turn (`null` while "new or update?" is open);
 * `offset` is where its chips start (staged, O-7 (a)).
 */
export type ReconciledRequest = {
  v: 2;
  refs: { old: Ref[]; new: Ref };
  intents: { old: IntentKeys; new: IntentKeys };
  values: Partial<Record<ReconcileField, FieldState>>;
  items: ReconcileItem[];
  asked: number | null;
  offset: number;
  status: 'asking' | 'suspended' | 'final';
};

/** The joined request, in the shape a decision is built from. */
export type JoinedRequest = {
  facts: IntentFacts;
  dayPart: DayPart | null;
  category: string | null;
  occasion: string | null;
  moods: string[];
  settings: string[];
  area: AreaValue;
};

/** Key → the words that state it: its CMS label and synonyms (D-9). */
export type TermsOf = (key: string) => readonly string[];

const SETTLED = (p: Provenance) => p !== 'inferred';
const isAbsentArea = (c: Candidate | undefined) => !c || (c.value as AreaValue).kind === 'absent';

function sameValue(field: ReconcileField, a: FieldValue, b: FieldValue): boolean {
  switch (field) {
    case 'preferences': {
      const x = a as PrefsValue;
      const y = b as PrefsValue;
      const left = [...x.moods, ...x.settings];
      const right = [...y.moods, ...y.settings];
      return left.length === right.length && left.every((key) => right.includes(key));
    }
    case 'budget':
      return (
        (a as BudgetValue).amount === (b as BudgetValue).amount &&
        (a as BudgetValue).mode === (b as BudgetValue).mode
      );
    case 'area': {
      const x = (a as AreaValue).codes;
      const y = (b as AreaValue).codes;
      return (
        (a as AreaValue).kind === (b as AreaValue).kind &&
        x?.provinceCode === y?.provinceCode &&
        x?.communeCode === y?.communeCode
      );
    }
    case 'time':
      return (
        (a as TimeValue).timeHint === (b as TimeValue).timeHint &&
        (a as TimeValue).dayPart === (b as TimeValue).dayPart
      );
    default:
      return a === b;
  }
}

const uniqueCandidates = (field: ReconcileField, list: readonly (Candidate | undefined)[]) => {
  const out: Candidate[] = [];
  for (const c of list) {
    if (c && !out.some((o) => sameValue(field, o.value, c.value))) out.push(c);
  }
  return out;
};

/** The values one request said, with provenance (D-9). Facts are always stated. */
export function sideOf(input: {
  facts: IntentFacts;
  dayPart: DayPart | null;
  area: AreaValue;
  keys: Pick<IntentKeys, 'category' | 'occasion' | 'moods' | 'settings'>;
  texts: readonly string[];
  termsOf: TermsOf;
  /** The newest message: a key it rejects is not this side's value (D-19). */
  reading?: MessageReading;
}): RequestSide {
  const { facts, dayPart, area, keys, termsOf, reading } = input;
  // A-F-01: a quoted or rejected term never states a value.
  const texts = input.texts.map((text) => assertedText(text));
  const side: RequestSide = {};
  const provenanceOf = (key: string): Provenance | null => {
    const status = reading ? termStatus(reading, termsOf(key)) : null;
    if (status === 'rejected') return null;
    return status === 'asserted' || statesTerm(texts, termsOf(key)) ? 'stated' : 'inferred';
  };
  const single = (key: string | null): Candidate | undefined => {
    const provenance = key ? provenanceOf(key) : null;
    return key && provenance ? { value: key, provenance } : undefined;
  };
  const category = single(keys.category);
  if (category) side.category = category;
  const occasion = single(keys.occasion);
  if (occasion) side.occasion = occasion;
  const prefKeys: Record<string, Provenance> = {};
  const kept = (list: string[]) =>
    list.filter((key) => {
      const provenance = provenanceOf(key);
      if (provenance) prefKeys[key] = provenance;
      return provenance !== null;
    });
  const prefs: PrefsValue = { moods: kept(keys.moods), settings: kept(keys.settings) };
  if (prefs.moods.length + prefs.settings.length > 0)
    side.preferences = prefsCandidate(prefs, prefKeys);
  if (facts.partySize !== null) side.partySize = { value: facts.partySize, provenance: 'stated' };
  if (area.kind !== 'absent') side.area = { value: area, provenance: 'stated' };
  if (facts.timeHint !== null || dayPart !== null) {
    side.time = { value: { timeHint: facts.timeHint, dayPart }, provenance: 'stated' };
  }
  if (facts.budget) side.budget = { value: facts.budget, provenance: 'stated' };
  return side;
}

function prefsCandidate(value: PrefsValue, keys: Record<string, Provenance>): Candidate {
  return {
    value,
    keys,
    provenance: Object.values(keys).some(SETTLED) ? 'stated' : 'inferred',
  };
}

/** The keys of a preference set whose provenance passes, or null when none does. */
function prefsSubset(c: Candidate, pass: (p: Provenance) => boolean): Candidate | null {
  const value = c.value as PrefsValue;
  const keys = c.keys ?? {};
  const keep = (key: string) => pass(keys[key] ?? c.provenance);
  const moods = value.moods.filter(keep);
  const settings = value.settings.filter(keep);
  if (moods.length + settings.length === 0) return null;
  const left: Record<string, Provenance> = {};
  for (const key of [...moods, ...settings]) left[key] = keys[key] ?? c.provenance;
  return prefsCandidate({ moods, settings }, left);
}

function prefsUnion(cands: readonly (Candidate | null | undefined)[]): Candidate | null {
  const moods: string[] = [];
  const settings: string[] = [];
  const keys: Record<string, Provenance> = {};
  for (const c of cands) {
    if (!c) continue;
    const value = c.value as PrefsValue;
    for (const key of value.moods) if (!moods.includes(key)) moods.push(key);
    for (const key of value.settings) if (!settings.includes(key)) settings.push(key);
    for (const key of [...value.moods, ...value.settings]) {
      if (!(key in keys)) keys[key] = c.keys?.[key] ?? c.provenance;
    }
  }
  return moods.length + settings.length > 0 ? prefsCandidate({ moods, settings }, keys) : null;
}

/** D-9 per key: only stated keys compete; inferred ones fill the gap, as assumed. */
function joinPreferences(old: Candidate | undefined, fresh: Candidate | undefined): FieldState {
  const oldStated = old ? prefsSubset(old, SETTLED) : null;
  const newStated = fresh ? prefsSubset(fresh, SETTLED) : null;
  const oldAssumed = old ? prefsSubset(old, (p) => !SETTLED(p)) : null;
  const newAssumed = fresh ? prefsSubset(fresh, (p) => !SETTLED(p)) : null;
  // Newest inferred wins, as assumed.
  const assumed = newAssumed ?? oldAssumed;
  if (!oldStated) {
    const value = prefsUnion([newStated, assumed]);
    return value ? { value } : {};
  }
  if (!newStated) {
    if (!fresh) return { pending: [prefsUnion([oldStated, assumed])!] };
    const value = prefsUnion([oldStated, oldAssumed]);
    return { ...(value ? { value } : {}), ...(newAssumed ? { others: [newAssumed] } : {}) };
  }
  if (sameValue('preferences', oldStated.value, newStated.value)) {
    return { value: prefsUnion([oldStated, assumed])! };
  }
  return { pending: [newStated, oldStated], ...(assumed ? { others: [assumed] } : {}) };
}

/** D-17: the area is asked only when both resolved and differ, or only the old resolved. */
function joinArea(old: Candidate | undefined, fresh: Candidate | undefined): FieldState {
  if (isAbsentArea(old)) return isAbsentArea(fresh) ? {} : { value: fresh! };
  const before = old!.value as AreaValue;
  if (isAbsentArea(fresh)) {
    return before.kind === 'resolved' ? { pending: [old!] } : { value: old! };
  }
  if (before.kind !== 'resolved') return { value: fresh! };
  const after = fresh!.value as AreaValue;
  if (after.kind !== 'resolved') return { value: fresh!, others: [old!] };
  return sameValue('area', before, after) ? { value: old! } : { pending: [fresh!, old!] };
}

/** D-9's table for one field; `pending` is one of the two ask cells. */
function joinField(
  field: ReconcileField,
  earlier: FieldState | undefined,
  fresh: Candidate | undefined,
): FieldState {
  // An unresolved pair stays a question; the new value goes in front (D-15).
  if (earlier?.pending) {
    // Only a value the person said enters an open question; a model's guess
    // never does, so a rejected value cannot return by inference (A-F-08).
    // Per key for the wishes: one stated key does not smuggle an inferred one in.
    const said = !fresh
      ? undefined
      : field === 'preferences'
        ? (prefsSubset(fresh, SETTLED) ?? undefined)
        : SETTLED(fresh.provenance)
          ? fresh
          : undefined;
    const pending = uniqueCandidates(field, [said, ...earlier.pending]);
    return { pending, ...(earlier.others ? { others: earlier.others } : {}) };
  }
  const old = earlier?.value;
  if (field === 'preferences') return joinPreferences(old, fresh);
  if (field === 'area') return joinArea(old, fresh);
  if (!old) return fresh ? { value: fresh } : {};
  if (!SETTLED(old.provenance)) return fresh ? { value: fresh, others: [old] } : { value: old };
  if (!fresh) return { pending: [old] };
  if (!SETTLED(fresh.provenance)) return { value: old, others: [fresh] };
  return sameValue(field, old.value, fresh.value) ? { value: old } : { pending: [fresh, old] };
}

function itemKind(pending: readonly Candidate[]): ReconcileItem['kind'] {
  if (pending.length === 0) return 'open';
  return pending.length === 1 ? 'old_only' : 'changed';
}

/** Whether the earlier request said anything worth keeping. */
export function hasDetails(side: RequestSide): boolean {
  return RECONCILE_FIELDS.some((field) =>
    field === 'area' ? !isAbsentArea(side.area) : side[field] !== undefined,
  );
}

/** A settled request as one earlier side of a new walk. */
export function fieldsOfSide(side: RequestSide): Partial<Record<ReconcileField, FieldState>> {
  const out: Partial<Record<ReconcileField, FieldState>> = {};
  for (const field of RECONCILE_FIELDS) {
    const value = side[field];
    if (value) out[field] = { value };
  }
  return out;
}

/**
 * The fields of a join and the items to ask, in a fixed order: what kind of
 * place, then the wishes about it, then the facts. Only D-9's two ask cells
 * produce items, plus every pair still unresolved on the earlier side.
 */
export function joinRequests(
  earlier: Partial<Record<ReconcileField, FieldState>>,
  fresh: RequestSide,
): { values: Partial<Record<ReconcileField, FieldState>>; items: ReconcileItem[] } {
  const values: Partial<Record<ReconcileField, FieldState>> = {};
  const items: ReconcileItem[] = [];
  for (const field of RECONCILE_FIELDS) {
    const joined = joinField(field, earlier[field], fresh[field]);
    if (joined.value || joined.pending || joined.others) values[field] = joined;
    if (joined.pending) items.push({ field, kind: itemKind(joined.pending) });
  }
  return { values, items };
}

/** The first item still to be answered; recorded items leave the queue (D-16). */
export function firstPending(state: Pick<ReconciledRequest, 'items' | 'values'>): number | null {
  const at = state.items.findIndex((item) => state.values[item.field]?.pending !== undefined);
  return at < 0 ? null : at;
}

/** What a chip of an item does, in the order the chips are shown. */
export type ItemChip =
  | { kind: 'pick'; index: number }
  | { kind: 'both' }
  | { kind: 'keep' }
  | { kind: 'drop' }
  | { kind: 'more'; offset: number };

/** At most three chips; the third opens the next three while more remain (O-7 (a)). */
export function chipsFor(
  item: ReconcileItem,
  pending: readonly Candidate[],
  offset = 0,
): ItemChip[] {
  if (pending.length === 0) return [];
  if (pending.length === 1) return [{ kind: 'keep' }, { kind: 'drop' }];
  const pick = (index: number): ItemChip => ({ kind: 'pick', index });
  if (pending.length === 2 && item.field === 'preferences') {
    return [pick(0), pick(1), { kind: 'both' }];
  }
  const rest = pending.length - offset;
  if (rest <= 3) return Array.from({ length: rest }, (_, i) => pick(offset + i));
  return [pick(offset), pick(offset + 1), { kind: 'more', offset: offset + 2 }];
}

const confirmed = (c: Candidate): Candidate => ({
  ...c,
  provenance: 'confirmed',
  ...(c.keys
    ? {
        keys: Object.fromEntries(
          Object.entries(c.keys).map(([key, p]) => [key, SETTLED(p) ? ('confirmed' as const) : p]),
        ),
      }
    : {}),
});

/** One chip answered. */
export function applyChip(state: ReconciledRequest, chip: ItemChip): ReconciledRequest {
  const item = state.items[state.asked!]!;
  const field = state.values[item.field] ?? {};
  const pending = field.pending ?? [];
  if (chip.kind === 'more') return { ...state, offset: chip.offset };
  const others = field.others ?? [];
  // Inferred wishes that survived beside the question ride along as assumed.
  const assumed =
    item.field === 'preferences'
      ? (others.find((c) => (c.keys ? !Object.values(c.keys).some(SETTLED) : false)) ?? null)
      : null;
  const settle = (value: Candidate | null, rest: Candidate[]): FieldState => {
    const withAssumed =
      item.field === 'preferences' && value ? prefsUnion([value, assumed]) : value;
    const left = uniqueCandidates(item.field, [...rest, ...others]);
    return {
      ...(withAssumed ? { value: withAssumed } : {}),
      ...(left.length ? { others: left } : {}),
    };
  };
  let next: FieldState;
  if (chip.kind === 'pick') {
    next = settle(
      confirmed(pending[chip.index]!),
      pending.filter((_, i) => i !== chip.index),
    );
  } else if (chip.kind === 'both') {
    next = settle(confirmed(prefsUnion(pending)!), []);
  } else if (chip.kind === 'keep') {
    next = settle(confirmed(pending[0]!), []);
  } else {
    next = settle(null, pending);
  }
  return { ...state, offset: 0, values: { ...state.values, [item.field]: next } };
}

/** A value the person typed settles a field, whatever stage it was at. */
export function settleField(
  state: ReconciledRequest,
  field: ReconcileField,
  value: Candidate,
): ReconciledRequest {
  const current = state.values[field] ?? {};
  const others = uniqueCandidates(field, [
    current.value,
    ...(current.pending ?? []),
    ...(current.others ?? []),
  ]).filter((c) => !sameValue(field, c.value, value.value));
  return {
    ...state,
    values: {
      ...state.values,
      [field]: { value, ...(others.length ? { others } : {}) },
    },
  };
}

/** The pieces of taxonomy a bare typed answer can name. */
export type TaxonomyKeys = {
  category: string[];
  occasion: string[];
  moods: string[];
  settings: string[];
};

/**
 * D-16 rule 1 — the message is a bare value of this field. The area needs the
 * dataset, so the caller reads it; every other field is here.
 */
export function bareValue(
  field: Exclude<ReconcileField, 'area'>,
  text: string,
  pending: readonly Candidate[],
  taxonomy: TaxonomyKeys,
  termsOf: TermsOf,
): Candidate | null {
  switch (field) {
    case 'partySize': {
      const n = bareParty(text);
      return n === null ? null : { value: n, provenance: 'typed' };
    }
    case 'budget': {
      const budget = bareBudget(text);
      return budget ? { value: budget, provenance: 'typed' } : null;
    }
    case 'time': {
      const time = bareTime(text);
      if (!time) return null;
      // A lone part of the day refines the day already on the table (D-17).
      const day =
        time.timeHint ??
        pending.map((c) => (c.value as TimeValue).timeHint).find((hint) => hint !== null) ??
        null;
      return day ? { value: { timeHint: day, dayPart: time.dayPart }, provenance: 'typed' } : null;
    }
    case 'category':
    case 'occasion': {
      const key = taxonomy[field].find((k) => bareTerm(text, termsOf(k)));
      return key ? { value: key, provenance: 'typed' } : null;
    }
    case 'preferences': {
      const mood = taxonomy.moods.find((k) => bareTerm(text, termsOf(k)));
      const setting = taxonomy.settings.find((k) => bareTerm(text, termsOf(k)));
      const key = mood ?? setting;
      if (!key) return null;
      return prefsCandidate(
        { moods: mood ? [mood] : [], settings: mood ? [] : [setting!] },
        { [key]: 'typed' },
      );
    }
  }
}

/**
 * D-19 — a rejected value: the field is asked again with what is left, never
 * silently kept or replaced. With nothing left it stays open (`pending: []`),
 * so no model answer can fill it before the person does (F-04). A rejected
 * value leaves the pool for good (F-08): only the person's words bring it back.
 */
function rejectField(
  state: ReconciledRequest,
  field: ReconcileField,
  matches: (c: Candidate) => boolean,
): ReconciledRequest {
  const current = state.values[field] ?? {};
  const all = uniqueCandidates(field, [
    current.value,
    ...(current.pending ?? []),
    ...(current.others ?? []),
  ]);
  if (all.length === 0) return state;
  const left = all.filter((c) => !matches(c));
  return {
    ...state,
    items: [...state.items.filter((item) => item.field !== field), { field, kind: itemKind(left) }],
    values: { ...state.values, [field]: { pending: left } },
  };
}

/** A rejected value leaves the alternatives, so a later rejection cannot bring it back. */
function forget(
  state: ReconciledRequest,
  field: ReconcileField,
  matches: (c: Candidate) => boolean,
): ReconciledRequest {
  const current = state.values[field];
  if (!current?.others) return state;
  const others = current.others.filter((c) => !matches(c));
  const { others: _dropped, ...rest } = current;
  return {
    ...state,
    values: { ...state.values, [field]: { ...rest, ...(others.length ? { others } : {}) } },
  };
}

const prefKeysOf = (c: Candidate) => [
  ...(c.value as PrefsValue).moods,
  ...(c.value as PrefsValue).settings,
];

function withoutKey(c: Candidate, key: string): Candidate | null {
  const value = c.value as PrefsValue;
  const keys = { ...(c.keys ?? {}) };
  delete keys[key];
  const moods = value.moods.filter((k) => k !== key);
  const settings = value.settings.filter((k) => k !== key);
  return moods.length + settings.length > 0 ? prefsCandidate({ moods, settings }, keys) : null;
}

/**
 * A rejected wish leaves every candidate; a wish only among the alternatives
 * just stops being offered. What the person is holding is asked again (F-03).
 */
function rejectPreference(state: ReconciledRequest, key: string): ReconciledRequest {
  const current = state.values.preferences ?? {};
  const held = [current.value, ...(current.pending ?? [])].flatMap((c) => (c ? [c] : []));
  const others = uniqueCandidates(
    'preferences',
    (current.others ?? []).map((c) => withoutKey(c, key) ?? undefined),
  );
  if (!held.some((c) => prefKeysOf(c).includes(key))) {
    const { others: _dropped, ...rest } = current;
    return {
      ...state,
      values: {
        ...state.values,
        preferences: { ...rest, ...(others.length ? { others } : {}) },
      },
    };
  }
  const left = uniqueCandidates('preferences', [
    ...held.map((c) => withoutKey(c, key) ?? undefined),
    ...others,
  ]);
  return {
    ...state,
    items: [
      ...state.items.filter((item) => item.field !== 'preferences'),
      { field: 'preferences', kind: itemKind(left) },
    ],
    values: { ...state.values, preferences: { pending: left } },
  };
}

/**
 * D-15 — what a message under a joined or walking request changes. Only what
 * the newest message asserts applies; a mention or a rejection does not.
 * Jev's own keys fill only absent fields (as assumed) or ones the newest
 * message states; they never move a key from assumed to settled (A-F-03): the
 * only way to `stated` is the person's words, checked here.
 */
export function applyNewest(
  state: ReconciledRequest,
  input: {
    /** The message as sent: a lone part of the day reads from the whole of it. */
    text: string;
    reading: MessageReading;
    /** The newest message's own asserted area; `null` when it names none. */
    area: AreaValue | null;
    /** The area its negated clauses name, as the dataset reads it. */
    rejectedArea: AreaValue | null;
    /** Jev's answers on this turn; `null` when no model answered. */
    jev: Pick<IntentKeys, 'category' | 'occasion' | 'moods' | 'settings'> | null;
    termsOf: TermsOf;
  },
): ReconciledRequest {
  const { text, reading, area, rejectedArea, jev, termsOf } = input;
  let next = state;
  const inWalk = state.status !== 'final';
  const set = (field: ReconcileField, value: FieldValue) => {
    const pending = next.values[field]?.pending;
    const provenance: Provenance = inWalk || pending ? 'typed' : 'stated';
    next = settleField(next, field, { value, provenance });
  };
  /** F-02: asserted and rejected values of one message apply together. */
  const fact = (
    field: ReconcileField,
    asserted: FieldValue | null,
    rejected: (c: Candidate) => boolean,
    anyRejected: boolean,
  ) => {
    if (asserted !== null) {
      set(field, asserted);
      if (anyRejected) next = forget(next, field, rejected);
    } else if (anyRejected) {
      next = rejectField(next, field, rejected);
    }
  };
  const has = reading.asserted;
  const no = reading.rejected;
  fact(
    'partySize',
    has.partySize,
    (c) => no.partySize.includes(c.value as number),
    no.partySize.length > 0,
  );
  fact(
    'budget',
    has.budget,
    (c) => no.budget.some((b) => b.amount === (c.value as BudgetValue).amount),
    no.budget.length > 0,
  );
  const heldTime = next.values.time?.value?.value as TimeValue | undefined;
  // The same day without an hour keeps the hour said for it (#733 episode rule).
  const dayPart =
    reading.dayPart ?? (heldTime?.timeHint === has.timeHint ? (heldTime?.dayPart ?? null) : null);
  fact(
    'time',
    has.timeHint !== null ? { timeHint: has.timeHint, dayPart } : null,
    (c) => no.timeHint.some((hint) => hint === (c.value as TimeValue).timeHint),
    no.timeHint.length > 0,
  );
  // F-05: a lone part of the day refines the day already held (D-17).
  if (has.timeHint === null && no.timeHint.length === 0) {
    const lone = bareTime(text);
    const day = heldTime?.timeHint ?? null;
    if (lone && lone.timeHint === null && lone.dayPart && day) {
      set('time', { timeHint: day, dayPart: lone.dayPart });
    }
  }
  const words = no.areaText.map((t) => normalizeVietnamese(t));
  const areaRejected = (c: Candidate) => {
    const value = c.value as AreaValue;
    if (rejectedArea?.kind === 'resolved' && sameValue('area', value, rejectedArea)) return true;
    const label = normalizeVietnamese(value.label ?? '');
    return words.some((word) => label.includes(word));
  };
  // F-07: the same area asserted and rejected in one message asserts nothing.
  const assertedArea =
    area && area.kind !== 'absent' && !(rejectedArea && sameValue('area', area, rejectedArea))
      ? area
      : null;
  fact('area', assertedArea, areaRejected, words.length > 0 || rejectedArea?.kind === 'resolved');

  for (const field of ['category', 'occasion'] as const) {
    const current = next.values[field];
    const held = uniqueCandidates(field, [current?.value, ...(current?.pending ?? [])]);
    const says = (c: Candidate) => termStatus(reading, termsOf(c.value as string)) === 'rejected';
    if (held.some(says)) next = rejectField(next, field, says);
    else next = forget(next, field, says);
    const key = jev?.[field] ?? null;
    if (!key) continue;
    const said = termStatus(reading, termsOf(key));
    const after = next.values[field];
    // F-06: the person's words settle a key, even one already a candidate.
    if (said === 'asserted' && after?.value?.value !== key) set(field, key);
    else if (said === null && !after?.value && !after?.pending) {
      next = {
        ...next,
        values: {
          ...next.values,
          [field]: { ...after, value: { value: key, provenance: 'inferred' } },
        },
      };
    }
  }

  const prefs = next.values.preferences;
  const known = [prefs?.value, ...(prefs?.pending ?? []), ...(prefs?.others ?? [])].flatMap((c) =>
    c ? prefKeysOf(c) : [],
  );
  for (const key of new Set(known)) {
    if (termStatus(reading, termsOf(key)) === 'rejected') next = rejectPreference(next, key);
  }
  if (jev) {
    const add = (key: string, kind: 'moods' | 'settings') => {
      const field = next.values.preferences ?? {};
      const said = termStatus(reading, termsOf(key));
      const value: PrefsValue = {
        moods: kind === 'moods' ? [key] : [],
        settings: kind === 'settings' ? [key] : [],
      };
      if (said === 'asserted') {
        const named = prefsCandidate(value, {
          [key]: inWalk || field.pending ? 'typed' : 'stated',
        });
        if (field.pending) next = settleField(next, 'preferences', named);
        else {
          next = {
            ...next,
            values: {
              ...next.values,
              preferences: { ...field, value: prefsUnion([named, field.value])! },
            },
          };
        }
      } else if (said === null && !field.value && !field.pending) {
        next = {
          ...next,
          values: {
            ...next.values,
            preferences: { ...field, value: prefsCandidate(value, { [key]: 'inferred' }) },
          },
        };
      }
    };
    for (const key of jev.moods) add(key, 'moods');
    for (const key of jev.settings) add(key, 'settings');
  }
  return next;
}

/** The request the settled values describe. A pending field holds no value here. */
export function joinedRequest(state: Pick<ReconciledRequest, 'values'>): JoinedRequest {
  const value = <T>(field: ReconcileField) => state.values[field]?.value?.value as T | undefined;
  const area = value<AreaValue>('area') ?? { kind: 'absent' as const };
  const time = value<TimeValue>('time');
  const prefs = value<PrefsValue>('preferences');
  return {
    facts: {
      partySize: value<number>('partySize') ?? null,
      budget: value<BudgetValue>('budget') ?? null,
      timeHint: time?.timeHint ?? null,
      areaText: area.kind === 'resolved' ? (area.label ?? null) : null,
    },
    dayPart: time?.dayPart ?? null,
    category: value<string>('category') ?? null,
    occasion: value<string>('occasion') ?? null,
    moods: prefs?.moods ?? [],
    settings: prefs?.settings ?? [],
    area,
  };
}

/**
 * What the two model calls are told on a joined request (D-15): what the
 * person said or chose, what GoGo inferred, what is undecided. Labels travel
 * as data (#737).
 */
export type ResolvedPayload = {
  settled: Record<string, DecisionCriterion>;
  assumed: Record<string, DecisionCriterion>;
  open: ReconcileField[];
  labels: Record<string, string>;
};

export function resolvedPayload(
  state: Pick<ReconciledRequest, 'values'>,
  labels: ReadonlyMap<string, string>,
): ResolvedPayload {
  const payload: ResolvedPayload = { settled: {}, assumed: {}, open: [], labels: {} };
  const label = (key: string) => {
    const text = labels.get(key);
    if (text) payload.labels[key] = text;
  };
  for (const field of RECONCILE_FIELDS) {
    const state_ = state.values[field];
    if (state_?.pending || !state_?.value) {
      payload.open.push(field);
      continue;
    }
    const c = state_.value;
    if (field === 'preferences') {
      const prefs = c.value as PrefsValue;
      for (const [kind, keys] of [
        ['moods', prefs.moods],
        ['settings', prefs.settings],
      ] as const) {
        for (const key of keys) {
          const target = SETTLED(c.keys?.[key] ?? c.provenance) ? payload.settled : payload.assumed;
          ((target[kind] as string[] | undefined) ?? ((target[kind] = []) as string[])).push(key);
          label(key);
        }
      }
      continue;
    }
    const target = SETTLED(c.provenance) ? payload.settled : payload.assumed;
    if (field === 'area') {
      const area = c.value as AreaValue;
      if (area.kind === 'resolved') target.area = area.label ?? null;
      else payload.open.push(field);
      continue;
    }
    target[field] = c.value as DecisionCriterion;
    if (field === 'category' || field === 'occasion') label(c.value as string);
  }
  return boundedResolved(payload) as ResolvedPayload;
}

/** Every stored value's source request is gone from the old side: chained refs stay bounded. */
export const MAX_STORED_REFS = 7;

export function boundedRefs(refs: Ref[]): Ref[] {
  return refs.length <= MAX_STORED_REFS ? refs : [refs[0]!, ...refs.slice(-(MAX_STORED_REFS - 1))];
}

// ── wording (fixed vocabulary) ───────────────────────────────────────────────

type Lang = 'vi' | 'en';

const TIME_WORDS: Record<NonNullable<IntentFacts['timeHint']>, Record<Lang, string>> = {
  now: { vi: 'bây giờ', en: 'now' },
  tonight: { vi: 'tối nay', en: 'tonight' },
  today: { vi: 'hôm nay', en: 'today' },
  tomorrow: { vi: 'ngày mai', en: 'tomorrow' },
  saturday: { vi: 'thứ 7', en: 'Saturday' },
  sunday: { vi: 'chủ nhật', en: 'Sunday' },
  weekend: { vi: 'cuối tuần', en: 'the weekend' },
};
const DAY_PART_WORDS: Record<DayPart, Record<Lang, string>> = {
  morning: { vi: 'sáng', en: 'morning' },
  noon: { vi: 'trưa', en: 'noon' },
  afternoon: { vi: 'chiều', en: 'afternoon' },
  evening: { vi: 'tối', en: 'evening' },
};

function money(amount: number, lang: Lang): string {
  if (amount >= 1_000_000 && amount % 100_000 === 0) {
    const m = amount / 1_000_000;
    return lang === 'vi' ? `${String(m).replace('.', ',')} triệu` : `${m}M`;
  }
  if (amount >= 1_000 && amount % 1_000 === 0) return `${amount / 1_000}k`;
  return `${amount}đ`;
}

/** One value as words; `labels` resolves taxonomy keys. */
function describe(
  field: ReconcileField,
  c: Candidate,
  labels: ReadonlyMap<string, string>,
  lang: Lang,
): string {
  const label = (key: string) => labels.get(key) ?? key;
  switch (field) {
    case 'category':
    case 'occasion':
      return label(c.value as string);
    case 'preferences': {
      const prefs = c.value as PrefsValue;
      return [...prefs.moods, ...prefs.settings].map(label).join(', ');
    }
    case 'partySize':
      return lang === 'vi' ? `${c.value as number} người` : `${c.value as number} people`;
    case 'area':
      return (c.value as AreaValue).label ?? '';
    case 'time': {
      const time = c.value as TimeValue;
      const day = time.timeHint ? TIME_WORDS[time.timeHint][lang] : '';
      return time.dayPart ? `${day} ${DAY_PART_WORDS[time.dayPart][lang]}`.trim() : day;
    }
    case 'budget': {
      const b = c.value as BudgetValue;
      const amount = money(b.amount, lang);
      if (b.mode === 'per_person')
        return lang === 'vi' ? `${amount}/người` : `${amount} per person`;
      if (b.mode === 'total') return lang === 'vi' ? `tổng ${amount}` : `${amount} in total`;
      return amount;
    }
  }
}

const FIELD_NOUN: Record<ReconcileField, Record<Lang, string>> = {
  category: { vi: 'loại địa điểm', en: 'kind of place' },
  preferences: { vi: 'không khí', en: 'atmosphere' },
  partySize: { vi: 'số người', en: 'party size' },
  area: { vi: 'khu vực', en: 'area' },
  time: { vi: 'thời gian', en: 'time' },
  budget: { vi: 'ngân sách', en: 'budget' },
  occasion: { vi: 'dịp', en: 'occasion' },
};

/** The first question: start over, or keep and update. Chip order = choices. */
export const RECONCILE_MODE_CHOICES = ['fresh', 'update'] as const;
export type ReconcileMode = (typeof RECONCILE_MODE_CHOICES)[number];

export function modeQuestion(lang: Lang): { text: string; group: AssistantFollowUpGroup } {
  const vi = lang === 'vi';
  return {
    text: vi
      ? 'Yêu cầu này khác yêu cầu trước của bạn. Bạn muốn tạo yêu cầu mới, hay giữ thông tin đã có và cập nhật theo tin mới?'
      : 'This differs from your earlier request. Start a new request, or keep what you said and update it with the new message?',
    group: {
      field: 'reconcile_mode',
      label: vi ? 'Tạo mới hay cập nhật?' : 'New or update?',
      options: vi
        ? [
            { label: 'Tạo yêu cầu mới', text: 'Tạo yêu cầu mới' },
            { label: 'Giữ thông tin cũ, cập nhật', text: 'Giữ thông tin cũ và cập nhật' },
          ]
        : [
            { label: 'New request', text: 'Start a new request' },
            { label: 'Keep and update', text: 'Keep my earlier details and update them' },
          ],
    },
  };
}

/**
 * One item, one question: "Bạn muốn cho 3 người?" with the new value first,
 * "Bạn muốn lãng mạn hay ngoài trời?" for wishes (or both), "Bạn vẫn muốn ở
 * Hà Nội?" for what only the earlier request said. More than two candidates
 * are shown in stages (O-7 (a)), newest first.
 */
export function itemQuestion(
  item: ReconcileItem,
  pending: readonly Candidate[],
  offset: number,
  labels: ReadonlyMap<string, string>,
  lang: Lang,
): { text: string; group: AssistantFollowUpGroup } {
  const vi = lang === 'vi';
  const words = (c: Candidate) => describe(item.field, c, labels, lang).slice(0, 60);
  const field = `reconcile_${item.field}`;
  const noun = FIELD_NOUN[item.field];
  const groupLabel = vi ? `Về ${noun.vi}` : `About the ${noun.en}`;
  const at = item.field === 'area' ? (vi ? 'ở ' : 'in ') : '';
  const forWhom = item.field === 'partySize' ? (vi ? 'cho ' : 'for ') : '';
  if (pending.length === 0) {
    return {
      text: vi ? `Bạn cho mình biết ${noun.vi} nhé?` : `What ${noun.en} would you like?`,
      group: { field, label: groupLabel, options: [] },
    };
  }
  const o = words(pending[pending.length === 1 ? 0 : 1]!);
  if (pending.length === 1) {
    return {
      text: vi ? `Bạn vẫn muốn ${forWhom}${at}${o}?` : `Do you still want ${forWhom}${at}${o}?`,
      group: {
        field,
        label: groupLabel,
        options: vi
          ? [
              { label: `Giữ: ${o}`.slice(0, 40), text: `Vẫn ${forWhom}${at}${o}` },
              { label: 'Bỏ', text: `Bỏ ${noun.vi}` },
            ]
          : [
              { label: `Keep: ${o}`.slice(0, 40), text: `Still ${forWhom}${at}${o}` },
              { label: 'Drop it', text: `Drop the ${noun.en}` },
            ],
      },
    };
  }
  const n = words(pending[0]!);
  if (pending.length === 2 && item.field === 'preferences') {
    return {
      text: vi ? `Bạn muốn ${n} hay ${o}?` : `Do you want ${n} or ${o}?`,
      group: {
        field,
        label: groupLabel,
        options: vi
          ? [
              { label: n.slice(0, 40), text: `Chọn ${n}` },
              { label: o.slice(0, 40), text: `Chọn ${o}` },
              { label: 'Cả hai', text: `Cả ${n} và ${o}` },
            ]
          : [
              { label: n.slice(0, 40), text: `Choose ${n}` },
              { label: o.slice(0, 40), text: `Choose ${o}` },
              { label: 'Both', text: `Both ${n} and ${o}` },
            ],
      },
    };
  }
  if (pending.length === 2) {
    return {
      text: vi
        ? `Bạn muốn ${forWhom}${at}${n}? (trước đó là ${o})`
        : `Do you want ${forWhom}${at}${n}? (earlier: ${o})`,
      group: {
        field,
        label: groupLabel,
        options: [
          { label: n.slice(0, 40), text: `${vi ? 'Đổi sang' : 'Change to'} ${forWhom}${at}${n}` },
          { label: o.slice(0, 40), text: `${vi ? 'Giữ' : 'Keep'} ${forWhom}${at}${o}` },
        ],
      },
    };
  }
  const chips = chipsFor(item, pending, offset);
  const shown = chips.flatMap((chip) =>
    chip.kind === 'pick' ? [words(pending[chip.index]!)] : [],
  );
  return {
    text: vi
      ? `Bạn chọn ${noun.vi} nào: ${shown.join(', ')}?`
      : `Which ${noun.en} would you like: ${shown.join(', ')}?`,
    group: {
      field,
      label: groupLabel,
      options: chips.map((chip) =>
        chip.kind === 'pick'
          ? {
              label: words(pending[chip.index]!).slice(0, 40),
              text: `${vi ? 'Chọn' : 'Choose'} ${forWhom}${at}${words(pending[chip.index]!)}`,
            }
          : vi
            ? { label: 'Giá trị khác…', text: 'Giá trị khác…' }
            : { label: 'Other values…', text: 'Other values…' },
      ),
    },
  };
}

export function isReconcileState(value: unknown): value is ReconciledRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const ref = (r: unknown) =>
    !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string';
  const refs = v.refs as { old?: unknown; new?: unknown } | undefined;
  return (
    // A walk stored before D-15 is not read back: its chip starts over (D-13).
    v.v === 2 &&
    !!refs &&
    Array.isArray(refs.old) &&
    refs.old.length > 0 &&
    refs.old.length <= MAX_STORED_REFS &&
    refs.old.every(ref) &&
    ref(refs.new) &&
    Array.isArray(v.items) &&
    v.items.every(
      (i) =>
        !!i &&
        typeof i === 'object' &&
        (RECONCILE_FIELDS as readonly string[]).includes((i as ReconcileItem).field),
    ) &&
    (v.asked === null || (typeof v.asked === 'number' && v.asked < v.items.length)) &&
    typeof v.offset === 'number' &&
    (v.status === 'asking' || v.status === 'suspended' || v.status === 'final') &&
    !!v.intents &&
    !!v.values &&
    typeof v.values === 'object'
  );
}

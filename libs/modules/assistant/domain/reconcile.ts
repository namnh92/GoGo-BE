import type { DayPart, IntentFacts } from '../../search/domain/intent';
import type { AssistantFollowUpGroup } from './assistant.types';

/**
 * GoGo-BE#738 follow-up (owner 2026-11-01) — a new request typed after a
 * place request that already said things: the person is asked whether to
 * start over or keep what was said and update it; keeping walks one question
 * per differing item, then joins the two.
 *
 * Owner decisions: asked whenever Jev judges the message a new request and
 * the earlier request had details; an item said the same way in both is kept
 * without asking; the first question is "new request, or keep and update?".
 *
 * Pure and deterministic: no model writes a question, an option or a merged
 * value. Stored state is keys, numbers and message ids only — never text.
 */

/** The parts of a place request that can differ between two of them. */
export type RequestSnapshot = {
  facts: IntentFacts;
  dayPart: DayPart | null;
  category: string | null;
  occasion: string | null;
  moods: string[];
  settings: string[];
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

/**
 * `changed`: both said it, differently — keep the new or the old.
 * `old_only`: only the earlier request said it — keep it or drop it.
 * Preferences that differ are `changed` with a third answer, both.
 */
export type ReconcileItem = { field: ReconcileField; kind: 'changed' | 'old_only' };

export type ReconcileChoice = 'new' | 'old' | 'both' | 'keep' | 'drop';

/** Where the merged request's area comes from. */
export type AreaSource = 'old' | 'new' | 'none';

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

const sameBudget = (a: IntentFacts['budget'], b: IntentFacts['budget']) =>
  a?.amount === b?.amount && a?.mode === b?.mode;

const norm = (s: string | null) => s?.trim().toLowerCase().replace(/\s+/g, ' ') ?? null;

function valuesOf(s: RequestSnapshot, field: ReconcileField): unknown {
  switch (field) {
    case 'category':
      return s.category;
    case 'occasion':
      return s.occasion;
    case 'preferences':
      return s.moods.length + s.settings.length > 0 ? [...s.moods, ...s.settings] : null;
    case 'partySize':
      return s.facts.partySize;
    case 'area':
      return s.facts.areaText;
    case 'time':
      return s.facts.timeHint;
    case 'budget':
      return s.facts.budget;
  }
}

function same(field: ReconcileField, a: RequestSnapshot, b: RequestSnapshot): boolean {
  switch (field) {
    case 'preferences':
      return sameSet([...a.moods, ...a.settings], [...b.moods, ...b.settings]);
    case 'budget':
      return sameBudget(a.facts.budget, b.facts.budget);
    case 'area':
      return norm(a.facts.areaText) === norm(b.facts.areaText);
    case 'time':
      return a.facts.timeHint === b.facts.timeHint && a.dayPart === b.dayPart;
    default:
      return valuesOf(a, field) === valuesOf(b, field);
  }
}

/** Whether the earlier request said anything worth keeping. */
export function hasDetails(s: RequestSnapshot): boolean {
  return RECONCILE_FIELDS.some((f) => valuesOf(s, f) !== null);
}

/**
 * The items to ask about, in a fixed order: what kind of place, then the
 * wishes about it, then the facts. Said the same in both, or only in the new
 * request: kept without asking.
 */
export function diffRequests(old: RequestSnapshot, fresh: RequestSnapshot): ReconcileItem[] {
  const items: ReconcileItem[] = [];
  for (const field of RECONCILE_FIELDS) {
    const before = valuesOf(old, field);
    if (before === null) continue;
    if (valuesOf(fresh, field) === null) items.push({ field, kind: 'old_only' });
    else if (!same(field, old, fresh)) items.push({ field, kind: 'changed' });
  }
  return items;
}

/** The answers a question offers, in the order its chips are shown. */
export function choicesFor(item: ReconcileItem): ReconcileChoice[] {
  if (item.kind === 'old_only') return ['keep', 'drop'];
  return item.field === 'preferences' ? ['new', 'old', 'both'] : ['new', 'old'];
}

/**
 * The request the answers describe. An item never asked takes the new value
 * when the new request said it, else the old one (said the same in both).
 */
export function mergeRequests(
  old: RequestSnapshot,
  fresh: RequestSnapshot,
  choices: Partial<Record<ReconcileField, ReconcileChoice>>,
): { snapshot: RequestSnapshot; area: AreaSource } {
  const pick = (field: ReconcileField): 'old' | 'new' | 'both' | 'none' => {
    const choice = choices[field];
    if (choice === 'old' || choice === 'keep') return 'old';
    if (choice === 'drop') return 'none';
    if (choice === 'both') return 'both';
    if (choice === 'new') return 'new';
    return valuesOf(fresh, field) !== null ? 'new' : valuesOf(old, field) !== null ? 'old' : 'none';
  };
  const from = <T>(field: ReconcileField, o: T, n: T, none: T): T => {
    const p = pick(field);
    return p === 'old' ? o : p === 'new' || p === 'both' ? n : none;
  };
  const prefs = pick('preferences');
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  const time = pick('time');
  const area = pick('area');
  return {
    snapshot: {
      category: from('category', old.category, fresh.category, null),
      occasion: from('occasion', old.occasion, fresh.occasion, null),
      moods:
        prefs === 'both'
          ? union(old.moods, fresh.moods)
          : prefs === 'old'
            ? old.moods
            : prefs === 'new'
              ? fresh.moods
              : [],
      settings:
        prefs === 'both'
          ? union(old.settings, fresh.settings)
          : prefs === 'old'
            ? old.settings
            : prefs === 'new'
              ? fresh.settings
              : [],
      facts: {
        partySize: from('partySize', old.facts.partySize, fresh.facts.partySize, null),
        budget: from('budget', old.facts.budget, fresh.facts.budget, null),
        timeHint:
          time === 'old' ? old.facts.timeHint : time === 'new' ? fresh.facts.timeHint : null,
        areaText:
          area === 'old' ? old.facts.areaText : area === 'new' ? fresh.facts.areaText : null,
      },
      dayPart: time === 'old' ? old.dayPart : time === 'new' ? fresh.dayPart : null,
    },
    area: area === 'old' ? 'old' : area === 'new' ? 'new' : 'none',
  };
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

/** One side of an item as words; `labels` resolves taxonomy keys. */
function describe(
  field: ReconcileField,
  s: RequestSnapshot,
  labels: ReadonlyMap<string, string>,
  lang: Lang,
): string {
  const label = (key: string) => labels.get(key) ?? key;
  switch (field) {
    case 'category':
      return label(s.category!);
    case 'occasion':
      return label(s.occasion!);
    case 'preferences':
      return [...s.moods, ...s.settings].map(label).join(', ');
    case 'partySize':
      return lang === 'vi' ? `${s.facts.partySize} người` : `${s.facts.partySize} people`;
    case 'area':
      return s.facts.areaText!.trim();
    case 'time': {
      const day = TIME_WORDS[s.facts.timeHint!][lang];
      return s.dayPart ? `${day} ${DAY_PART_WORDS[s.dayPart][lang]}` : day;
    }
    case 'budget': {
      const b = s.facts.budget!;
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
 * Hà Nội?" for what only the earlier request said.
 */
export function itemQuestion(
  item: ReconcileItem,
  old: RequestSnapshot,
  fresh: RequestSnapshot,
  labels: ReadonlyMap<string, string>,
  lang: Lang,
): { text: string; group: AssistantFollowUpGroup } {
  const vi = lang === 'vi';
  const o = describe(item.field, old, labels, lang).slice(0, 60);
  const field = `reconcile_${item.field}`;
  const groupLabel = vi
    ? `Về ${FIELD_NOUN[item.field].vi}`
    : `About the ${FIELD_NOUN[item.field].en}`;
  const at = item.field === 'area' ? (vi ? 'ở ' : 'in ') : '';
  const forWhom = item.field === 'partySize' ? (vi ? 'cho ' : 'for ') : '';
  if (item.kind === 'old_only') {
    return {
      text: vi ? `Bạn vẫn muốn ${forWhom}${at}${o}?` : `Do you still want ${forWhom}${at}${o}?`,
      group: {
        field,
        label: groupLabel,
        options: vi
          ? [
              { label: `Giữ: ${o}`.slice(0, 40), text: `Vẫn ${forWhom}${at}${o}` },
              { label: 'Bỏ', text: `Bỏ ${FIELD_NOUN[item.field].vi}` },
            ]
          : [
              { label: `Keep: ${o}`.slice(0, 40), text: `Still ${forWhom}${at}${o}` },
              { label: 'Drop it', text: `Drop the ${FIELD_NOUN[item.field].en}` },
            ],
      },
    };
  }
  const n = describe(item.field, fresh, labels, lang).slice(0, 60);
  if (item.field === 'preferences') {
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

/**
 * What a reconciling turn stores (in its trace) for the next one to read:
 * message ids and keys, never text. `asked` is the item asked on this turn
 * (`null` while the first question is open).
 */
export type ReconcileState = {
  oldRefs: { id: string; allowBareArea: boolean }[];
  newRef: { id: string; allowBareArea: boolean };
  oldIntent: IntentKeys;
  newIntent: IntentKeys;
  items: ReconcileItem[];
  asked: number | null;
  choices: Partial<Record<ReconcileField, ReconcileChoice>>;
};

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

export function isReconcileState(value: unknown): value is ReconcileState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const ref = (r: unknown) =>
    !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string';
  return (
    Array.isArray(v.oldRefs) &&
    v.oldRefs.length > 0 &&
    v.oldRefs.length <= 7 &&
    v.oldRefs.every(ref) &&
    ref(v.newRef) &&
    Array.isArray(v.items) &&
    v.items.every(
      (i) =>
        !!i &&
        typeof i === 'object' &&
        (RECONCILE_FIELDS as readonly string[]).includes((i as ReconcileItem).field),
    ) &&
    (v.asked === null || (typeof v.asked === 'number' && v.asked < v.items.length)) &&
    !!v.oldIntent &&
    !!v.newIntent &&
    !!v.choices &&
    typeof v.choices === 'object'
  );
}

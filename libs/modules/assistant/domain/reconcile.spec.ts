import { describe, expect, it } from 'vitest';
import { parseIntentFacts } from '../../search/domain/intent';
import {
  choicesFor,
  diffRequests,
  hasDetails,
  itemQuestion,
  mergeRequests,
  modeQuestion,
  type RequestSnapshot,
} from './reconcile';

/**
 * GoGo-BE#738 follow-up (owner 2026-11-01): the owner's example — "Cho tôi
 * quán cà phê lãng mạn cho 2 người ở Hà Nội" then "Cho tôi quán cà phê ngoài
 * trời cho 3 người". Same kind of place: kept, not asked. Asked one at a time:
 * romantic or outdoor (or both), 3 people, still Hà Nội.
 */
const labels = new Map([
  ['category:cafe', 'cà phê'],
  ['category:restaurant', 'nhà hàng'],
  ['romantic', 'lãng mạn'],
  ['outdoor', 'ngoài trời'],
]);
const snap = (text: string, extra: Partial<RequestSnapshot>): RequestSnapshot => ({
  facts: parseIntentFacts(text),
  dayPart: null,
  category: null,
  occasion: null,
  moods: [],
  settings: [],
  ...extra,
});
const OLD = snap('Cho tôi quán cà phê lãng mạn cho 2 người ở Hà Nội', {
  category: 'category:cafe',
  moods: ['romantic'],
});
const NEW = snap('Cho tôi quán cà phê ngoài trời cho 3 người', {
  category: 'category:cafe',
  settings: ['outdoor'],
});

describe('#738 reconcile: the owner example', () => {
  it('asks the wishes, the party size and the area — not the same kind of place', () => {
    expect(OLD.facts.areaText).toBe('Hà Nội');
    expect(diffRequests(OLD, NEW)).toEqual([
      { field: 'preferences', kind: 'changed' },
      { field: 'partySize', kind: 'changed' },
      { field: 'area', kind: 'old_only' },
    ]);
  });

  it('words each question with the new value first, from fixed vocabulary', () => {
    const [prefs, party, area] = diffRequests(OLD, NEW);
    const q = (item: typeof prefs) => itemQuestion(item!, OLD, NEW, labels, 'vi');
    expect(q(prefs).text).toBe('Bạn muốn ngoài trời hay lãng mạn?');
    expect(q(prefs).group.options.map((o) => o.label)).toEqual([
      'ngoài trời',
      'lãng mạn',
      'Cả hai',
    ]);
    expect(q(party).text).toBe('Bạn muốn cho 3 người? (trước đó là 2 người)');
    expect(q(party).group.options.map((o) => o.label)).toEqual(['3 người', '2 người']);
    expect(q(area).text).toBe('Bạn vẫn muốn ở Hà Nội?');
    expect(q(area).group.options).toHaveLength(2);
    expect(choicesFor(area!)).toEqual(['keep', 'drop']);
    expect(choicesFor(prefs!)).toEqual(['new', 'old', 'both']);
  });

  it('joins the answers: both wishes, 3 people, Hà Nội kept from the earlier request', () => {
    const { snapshot, area } = mergeRequests(OLD, NEW, {
      preferences: 'both',
      partySize: 'new',
      area: 'keep',
    });
    expect(snapshot).toMatchObject({
      category: 'category:cafe',
      moods: ['romantic'],
      settings: ['outdoor'],
      facts: { partySize: 3, areaText: 'Hà Nội' },
    });
    expect(area).toBe('old');
  });

  it('a dropped area and the old wishes chosen', () => {
    const { snapshot, area } = mergeRequests(OLD, NEW, {
      preferences: 'old',
      partySize: 'old',
      area: 'drop',
    });
    expect(snapshot).toMatchObject({
      moods: ['romantic'],
      settings: [],
      facts: { partySize: 2, areaText: null },
    });
    expect(area).toBe('none');
  });

  it('the first question offers starting over or keeping and updating', () => {
    const q = modeQuestion('vi');
    expect(q.group.field).toBe('reconcile_mode');
    expect(q.group.options.map((o) => o.text)).toEqual([
      'Tạo yêu cầu mới',
      'Giữ thông tin cũ và cập nhật',
    ]);
  });
});

describe('#738 reconcile: edges', () => {
  it('nothing to ask when the new request repeats or extends the old one', () => {
    const extended = snap('Cho tôi quán cà phê lãng mạn cho 2 người ở Hà Nội tối nay', {
      category: 'category:cafe',
      moods: ['romantic'],
    });
    expect(diffRequests(OLD, extended)).toEqual([]);
  });

  it('a request with no details has nothing to keep', () => {
    expect(hasDetails(snap('chào bạn', {}))).toBe(false);
    expect(hasDetails(OLD)).toBe(true);
  });

  it('a different kind of place is asked, new first', () => {
    const dinner = snap('nhà hàng cho 2 người ở Hà Nội', {
      category: 'category:restaurant',
      moods: ['romantic'],
    });
    const items = diffRequests(OLD, dinner);
    expect(items[0]).toEqual({ field: 'category', kind: 'changed' });
    expect(itemQuestion(items[0]!, OLD, dinner, labels, 'vi').text).toBe(
      'Bạn muốn nhà hàng? (trước đó là cà phê)',
    );
  });

  it('budgets and times read as people say them', () => {
    const a = snap('cà phê 300k/người thứ 7', { category: 'category:cafe' });
    const b = snap('cà phê tổng 1 triệu tối nay', { category: 'category:cafe' });
    const items = diffRequests(a, b);
    const words = items.map((i) => itemQuestion(i, a, b, labels, 'vi').text);
    expect(words).toContain('Bạn muốn tối nay? (trước đó là thứ 7)');
    expect(words.some((w) => w.includes('300k/người'))).toBe(true);
  });
});

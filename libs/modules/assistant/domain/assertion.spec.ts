import { describe, expect, it } from 'vitest';
import {
  assertedText,
  bareAreaPhrase,
  bareBudget,
  bareParty,
  bareTerm,
  bareTime,
  isOnlyParticles,
  lonePart,
  readMessage,
  rejectedText,
  statesTerm,
  termStatus,
} from './assertion';

describe('#738 D-19 a parsed fact asserts only when it is not negated', () => {
  const cases: [string, number | null, number | null][] = [
    ['3 người', 3, null],
    ['không phải 3 người', null, 3],
    ['3 người thì không nhé', null, 3],
    ['không phải 3 người, 4 người', 4, 3],
    ['không 3 người đâu, 4 người', 4, 3],
    ['3 người chứ không phải 2 người', 3, 2],
    ['bỏ 3 người đi', null, 3],
    ['đừng 3 người', null, 3],
    ['khong phai 3 người', null, 3],
    ['thôi 3 người nữa', null, 3],
    ['“3 người” thì đông quá', null, null],
    ['"3 người" hơi đông', null, null],
    ["'3 người' hơi đông", null, null],
    ['5 người nhưng không đi xa', 5, null],
  ];
  for (const [text, asserted, rejected] of cases) {
    it(`"${text}"`, () => {
      const r = readMessage(text);
      expect(r.asserted.partySize).toBe(asserted);
      expect(r.rejected.partySize).toEqual(rejected === null ? [] : [rejected]);
    });
  }

  it('a marked word that only folds to a marker is no marker', () => {
    expect(readMessage('quán bò cho 3 người').asserted.partySize).toBe(3);
    expect(readMessage('đúng 3 người').asserted.partySize).toBe(3);
  });

  it('a noun that begins with "không" is no marker', () => {
    expect(readMessage('không gian đẹp cho 3 người').asserted.partySize).toBe(3);
    expect(readMessage('không khí vui 3 người').asserted.partySize).toBe(3);
  });

  it('with no marker the message reads whole: numbers and dotted names intact', () => {
    const r = readMessage('1,5 triệu cho Q. Bình Thạnh. 4 người');
    expect(r.asserted.budget?.amount).toBe(1_500_000);
    expect(r.asserted.partySize).toBe(4);
    expect(r.clauses).toHaveLength(1);
  });

  it('a budget with a decimal mark survives the clause split', () => {
    const r = readMessage('không 2 triệu, 1,5 triệu thôi');
    expect(r.asserted.budget?.amount).toBe(1_500_000);
    expect(r.rejected.budget.map((b) => b.amount)).toEqual([2_000_000]);
  });

  it('clause order decides: a later clause about the same value stands (F-02)', () => {
    const denied = readMessage('4 người, không phải 4 người');
    expect(denied.asserted.partySize).toBeNull();
    expect(denied.rejected.partySize).toEqual([4]);
    const again = readMessage('không phải 4 người, 4 người');
    expect(again.asserted.partySize).toBe(4);
    expect(again.rejected.partySize).toEqual([]);
  });

  it('only asserting clauses read as asserted text (F-01)', () => {
    expect(assertedText('“Đà Nẵng” nghe xa quá').includes('Đà Nẵng')).toBe(false);
    expect(assertedText('không ở Hà Nội, ở Đà Nẵng')).toBe('ở Đà Nẵng');
    expect(rejectedText('không ở Hà Nội, ở Đà Nẵng')).toBe('không ở Hà Nội');
  });

  it('terms: asserted in one clause, rejected in another', () => {
    const r = readMessage('không lãng mạn, ngoài trời');
    expect(termStatus(r, ['lãng mạn'])).toBe('rejected');
    expect(termStatus(r, ['ngoài trời'])).toBe('asserted');
    expect(termStatus(r, ['yên tĩnh'])).toBeNull();
    expect(statesTerm(['Quán Lãng Mạn'], ['lang man'])).toBe(true);
    expect(statesTerm(['nhà hàng'], ['nhà'])).toBe(true);
    expect(statesTerm(['anha hang'], ['nha'])).toBe(false);
  });
});

describe('#738 D-16 rule 1 a bare answer', () => {
  it.each(['4 người', 'cho 4 người nhé', 'cho mình 4 người', '4 người thôi', 'là 4 người ạ'])(
    '"%s" is bare',
    (text) => expect(bareParty(text)).toBe(4),
  );
  it.each([
    'thôi, tìm nhà hàng cho 4 người',
    'thôi, 4 người',
    'quán nào cho 4 người',
    'không phải 4 người',
    '“4 người”',
  ])('"%s" is not', (text) => expect(bareParty(text)).toBeNull());

  it('budget, time and term', () => {
    expect(bareBudget('300k/người')?.amount).toBe(300_000);
    expect(bareBudget('tìm chỗ 300k')).toBeNull();
    expect(bareTime('thứ 7 tối')).toEqual({ timeHint: 'saturday', dayPart: 'evening' });
    expect(bareTime('tối nhé')).toEqual({ timeHint: null, dayPart: 'evening' });
    expect(bareTime('đi ăn tối đã')).toBeNull();
    expect(bareTerm('ngoài trời nhé', ['ngoài trời'])).toBe(true);
    expect(bareTerm('tìm chỗ ngoài trời', ['ngoài trời'])).toBe(false);
    expect(bareTerm('không ngoài trời', ['ngoài trời'])).toBe(false);
    // A-F-01: a quoted answer is a mention.
    expect(bareTerm('“ngoài trời”', ['ngoài trời'])).toBe(false);
    expect(bareTime('“tối”')).toBeNull();
    expect(bareParty('“4 người”')).toBeNull();
  });

  it('area, with its locative word and nothing else', () => {
    expect(bareAreaPhrase('ở Hà Nội nhé')).toBe('Hà Nội');
    expect(bareAreaPhrase('tìm quán ở Hà Nội')).toBeNull();
    expect(bareAreaPhrase('không ở Hà Nội')).toBeNull();
  });

  it('a lone part of the day is no meal', () => {
    expect(lonePart('cà phê buổi tối')).toBe('evening');
    expect(lonePart('đi ăn tối')).toBeNull();
    expect(lonePart('tối đa 300k')).toBeNull();
    expect(isOnlyParticles('cho mình nhé')).toBe(true);
    expect(isOnlyParticles('thôi,')).toBe(false);
  });
});

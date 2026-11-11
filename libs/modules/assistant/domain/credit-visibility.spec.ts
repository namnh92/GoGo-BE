import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { creditEntryFacts, decodeCreditCursor, encodeCreditCursor } from './credit-visibility';
import { creditHistoryQuery } from '../presentation/me-credits.controller';

describe('V credit facts and cursor', () => {
  const subject = randomUUID();
  const row = { at: '2026-11-10T09:00:00.123456Z', id: randomUUID() };

  it('round trips full microseconds, version and subject without rounding through Date', () => {
    expect(decodeCreditCursor(encodeCreditCursor(subject, row), subject)).toEqual(row);
    expect(decodeCreditCursor(undefined, subject)).toBeNull();
  });

  it('rejects wrong subject, version, UUID, precision, date, shape and encoding as INVALID_CURSOR', () => {
    const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString('base64url');
    for (const value of [
      '',
      '!',
      'a'.repeat(513),
      encode([1, randomUUID(), row.at, row.id]),
      encode([2, subject, row.at, row.id]),
      encode([1, subject, row.at, 'not-uuid']),
      encode([1, subject, '2026-11-10T09:00:00.123Z', row.id]),
      encode([1, subject, '2026-02-30T09:00:00.123456Z', row.id]),
      encode([1, subject, '0000-01-01T00:00:00.123456Z', row.id]),
      encode([1, subject, row.at, row.id, 'extra']),
      encode([1, subject, row.at, row.id]) + '=',
    ]) {
      expect(() => decodeCreditCursor(value, subject), value).toThrowError(
        expect.objectContaining({ code: 'INVALID_CURSOR', httpStatus: 400 }),
      );
    }
  });

  it('accepts only fixed page size ten, rejects identity parameters', () => {
    expect(creditHistoryQuery.parse({})).toEqual({ limit: 10 });
    expect(creditHistoryQuery.parse({ limit: '10' })).toEqual({ limit: 10 });
    for (const limit of [0, 1, 9, 11, 100, 10.1, 'bad']) {
      expect(creditHistoryQuery.safeParse({ limit }).success).toBe(false);
    }
    expect(creditHistoryQuery.safeParse({ userId: subject }).success).toBe(false);
  });

  it('projects open grant keys and usage refunds without private linkage or localized copy', () => {
    expect(creditEntryFacts('submission_approved', 70)).toEqual({
      direction: 'earned',
      eventKey: 'submission_approved',
      source: { type: 'contribution' },
    });
    expect(creditEntryFacts('review_published', 5).source.type).toBe('review');
    expect(creditEntryFacts('future_catalogue_event', 12)).toEqual({
      direction: 'earned',
      eventKey: 'future_catalogue_event',
      source: { type: 'event' },
    });
    expect(creditEntryFacts('message_spent', -1)).toEqual({
      direction: 'spent',
      eventKey: 'assistant_usage',
      source: { type: 'assistant_usage' },
    });
    expect(creditEntryFacts('assistant_usage_adjustment', 5).direction).toBe('earned');
    expect(creditEntryFacts('assistant_usage_adjustment', 1, true)).toEqual({
      direction: 'adjustment',
      eventKey: 'assistant_usage_adjustment',
      source: { type: 'assistant_usage' },
    });
  });
});

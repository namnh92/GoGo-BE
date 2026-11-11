import { z } from 'zod';
import { AppError } from '../../shared/app-error';

const payload = z.tuple([
  z.literal(1),
  z.string().uuid(),
  z
    .string()
    .datetime({ precision: 6 })
    .refine((at) => !at.startsWith('0000-')),
  z.string().uuid(),
]);

export type CreditCursor = { at: string; id: string };

export function decodeCreditCursor(value: string | undefined, userId: string): CreditCursor | null {
  if (value === undefined) return null;
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('encoding');
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('encoding');
    const [, subject, at, id] = payload.parse(JSON.parse(bytes.toString('utf8')));
    if (subject.toLowerCase() !== userId.toLowerCase()) throw new Error('subject');
    return { at, id };
  } catch {
    throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid');
  }
}

export function encodeCreditCursor(userId: string, row: CreditCursor): string {
  return Buffer.from(JSON.stringify([1, userId, row.at, row.id])).toString('base64url');
}

/** Usage refunds are net spending, never new earnings. Keys stay open for S2. */
export function creditEntryFacts(reason: string, delta: number, usageLinked = false) {
  if (reason === 'message_spent' || (reason === 'assistant_usage_adjustment' && usageLinked)) {
    return {
      direction: reason === 'message_spent' ? 'spent' : 'adjustment',
      eventKey: reason === 'message_spent' ? 'assistant_usage' : reason,
      source: { type: 'assistant_usage' },
    };
  }
  return {
    direction: delta > 0 ? 'earned' : 'adjustment',
    eventKey: reason,
    source: {
      type: reason.startsWith('submission_')
        ? 'contribution'
        : reason === 'review_published'
          ? 'review'
          : 'event',
    },
  };
}

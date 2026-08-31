import { AppError } from './app-error';

/**
 * Keyset cursor over `(timestamp, uuid)` — the pair every CMS list already
 * sorts by.
 *
 * Offset paging is wrong for these queues specifically: a moderator reads them
 * while users keep writing into them, so page 2 of an offset scan repeats rows
 * that shifted down and skips rows that shifted up. The tuple comparison
 * `(created_at, id) < (cursorAt, cursorId)` has no such drift, and the id
 * breaks ties so two rows written in the same millisecond cannot hide each
 * other.
 *
 * Opaque to the client on purpose: it is base64url, not a promise about what
 * is inside, so the sort key can change without breaking a stored cursor —
 * a malformed one is rejected rather than coerced.
 */
export function encodeKeysetCursor(occurredAt: Date | string, id: string): string {
  const raw = occurredAt instanceof Date ? occurredAt.toISOString() : String(occurredAt);
  return Buffer.from(JSON.stringify([raw, id])).toString('base64url');
}

export function decodeKeysetCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string];
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) throw new Error('bad');
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('bad');
    return { at, id };
  } catch {
    throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid');
  }
}

/** Driver rows carry a Date or the raw string depending on the parser in play. */
export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

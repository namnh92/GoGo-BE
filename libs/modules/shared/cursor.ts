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

/**
 * RFC 3339 `date-time` for a timestamp column, whichever form the driver handed
 * back. Typed Drizzle selects give a Date; a raw `db.execute` gives the
 * Postgres text form — "2026-09-06 11:16:24.599968+00", a space for the `T` and
 * a two-digit offset — which `format: date-time` rejects and Safari cannot
 * parse (#443). Rewrite that form to ISO-8601 before parsing so the result does
 * not rest on an engine's leniency. A value that still does not parse is
 * returned as-is rather than turned into a 500.
 *
 * Never feed this into a cursor: a JS Date keeps milliseconds, the column keeps
 * microseconds, and keyset paging needs the exact value.
 */
export function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const raw = String(value);
  const parsed = new Date(
    raw
      .trim()
      .replace(' ', 'T')
      .replace(/([+-]\d{2})$/, '$1:00'),
  );
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

import { AppError } from '../../shared/app-error';

/**
 * Keyset cursor over `(timestamptz, uuid)`. The timestamp travels as the
 * column's own microsecond ISO text (written by SQL, never by a JS Date), so
 * the tuple comparison is exact.
 */
export function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id])).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string];
    if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(at)) {
      throw new Error('bad');
    }
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('bad');
    return { at, id };
  } catch {
    throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid');
  }
}

/** SQL for a timestamptz column as the exact ISO text a cursor carries. */
export const isoUs = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

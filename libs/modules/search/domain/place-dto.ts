import { isPublicKey } from '../../shared/media-url';
/**
 * #169 — the boundary between a SQL row and the `/v1` contract.
 *
 * `GET /places/{id}` used to return the row as it came out of Postgres, and
 * three things leaked that no generated type could catch: `numeric` columns
 * arrive as strings (`"4.60"`, which crashed a client calling `.toFixed`),
 * timestamps arrive in Postgres' own format rather than ISO-8601, and column
 * names arrive in snake_case while the contract promises camelCase.
 *
 * Search results were already mapped; only the detail path was not. Everything
 * that leaves this module goes through here.
 */

export type PlacePhotoRow = {
  id: string;
  storageKey: string;
  width: number | null;
  height: number | null;
  source: 'manual' | 'community';
  moderation: string;
};

export type PlacePhoto = {
  id: string;
  url: string;
  width?: number | undefined;
  height?: number | undefined;
  source: 'google' | 'community' | 'manual';
  attribution?: string | undefined;
};

/** `numeric` is a string over the wire; `null` stays absent, never NaN. */
export function num(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function iso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Photos are only offered when they can actually be loaded. With no public
 * media base configured the list is empty, so a client shows its placeholder
 * instead of a broken image — the honest failure of the two.
 *
 * The same reasoning excludes a key that is not on the public host. Catalogue
 * uploads were presigned against the private bucket while this URL was
 * composed against the public one (ADR-0005), so those objects answer 404 and
 * no URL will make them appear. Handing one to a phone buys a broken tile in a
 * search result; omitting it buys the placeholder this comment already
 * promises.
 */
export function toPhotos(
  rows: PlacePhotoRow[] | null | undefined,
  baseUrl: string,
  attribution?: string | undefined,
): PlacePhoto[] {
  if (!baseUrl || !rows) return [];
  const base = baseUrl.replace(/\/$/, '');
  return rows
    .filter((row) => isPublicKey(row.storageKey))
    .map((row) => ({
      id: row.id,
      url: `${base}/${row.storageKey.replace(/^\//, '')}`,
      ...(row.width !== null ? { width: row.width } : {}),
      ...(row.height !== null ? { height: row.height } : {}),
      source: row.source,
      // Provider imagery must be shown with its attribution; GoGo's own is not
      // attributed to anyone.
      ...(row.source !== 'manual' && attribution ? { attribution } : {}),
    }));
}

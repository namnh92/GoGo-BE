import { isSubmissionPhotoKey, communityPhotoUrl } from '../../shared/submission-photo-url';
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
  source: 'google' | 'manual' | 'community';
  attribution?: string | null;
  providerPhoto?: {
    authorAttributions: { displayName: string; uri: string | null; photoUri: string | null }[];
    googleMapsUri: string | null;
  } | null;
  moderation: string;
  contributor?: { displayName: string } | null;
};

export type PlacePhoto = {
  id: string;
  url: string;
  width?: number | undefined;
  height?: number | undefined;
  source: 'google' | 'community' | 'manual';
  attribution?: string | undefined;
  authorAttributions?: { displayName: string; uri: string | null; photoUri: string | null }[];
  googleMapsUri?: string | null;
  contributor?: { displayName: string } | undefined;
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

/** Approved catalogue objects use the CDN; sanitised community derivatives
 * use a BFF URL which rechecks moderation and place visibility on every read.
 * Unknown private keys are never offered, including uploaded originals.
 */
export function toPhotos(
  rows: PlacePhotoRow[] | null | undefined,
  baseUrl: string,
  attribution?: string | undefined,
  placeId?: string,
): PlacePhoto[] {
  if (!rows) return [];
  const base = baseUrl.replace(/\/$/, '');
  return rows
    .filter(
      (row) =>
        row.moderation === 'approved' &&
        ((!!baseUrl && isPublicKey(row.storageKey)) ||
          (!!placeId && isSubmissionPhotoKey(row.storageKey))),
    )
    .map((row) => ({
      id: row.id,
      url: isSubmissionPhotoKey(row.storageKey)
        ? communityPhotoUrl(placeId!, row.id)
        : `${base}/${row.storageKey.replace(/^\//, '')}`,
      ...(row.width !== null ? { width: row.width } : {}),
      ...(row.height !== null ? { height: row.height } : {}),
      source: row.source,
      ...(row.contributor ? { contributor: row.contributor } : {}),
      // Provider imagery must be shown with its attribution; GoGo's own is not
      // attributed to anyone.
      ...(!isSubmissionPhotoKey(row.storageKey) &&
      row.source !== 'manual' &&
      (row.attribution || attribution)
        ? { attribution: row.attribution || attribution }
        : {}),
      ...(row.source === 'google' && row.providerPhoto
        ? {
            authorAttributions: row.providerPhoto.authorAttributions,
            googleMapsUri: row.providerPhoto.googleMapsUri,
          }
        : {}),
    }));
}

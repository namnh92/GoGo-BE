/**
 * ADR-0005 — which purposes are catalogue media, and the prefix each lands on.
 *
 * Catalogue media is public: it is what the app exists to show, served from
 * `assets-<env>.gogo.id.vn` with a year-long immutable cache. A presigned GET
 * per image would defeat both the edge cache and on-device caching. User media
 * (check-in and bill photos) stays private behind a signed GET — publishing
 * somebody's evening or their receipt is not a performance decision.
 *
 * Two buckets rather than two prefixes in one: an R2 custom domain publishes a
 * whole bucket and cannot be scoped to a prefix, so with a single bucket
 * "public" would be a rule about key names that nothing enforces.
 *
 * Declared here, in a leaf, because both the upload path that writes the key
 * and the read path that resolves it need the same answer.
 */
export const PUBLIC_UPLOAD_PREFIXES: Partial<Record<string, string>> = {
  place_image: 'places',
  banner_image: 'banners',
  campaign_image: 'campaigns',
};

/**
 * A key served from the public host, as opposed to one needing a signature.
 *
 * Decided from the key rather than from the purpose that made it: the row that
 * remembers the purpose can be pruned, and a key already stored on a resource
 * has to keep resolving the same way for as long as the object exists.
 */
export function isPublicKey(key: string): boolean {
  return Object.values(PUBLIC_UPLOAD_PREFIXES).some((prefix) => key.startsWith(`${prefix!}/`));
}

/**
 * Where a public object is readable, or null when media hosting is not
 * configured in this environment (`MEDIA_PUBLIC_BASE_URL` empty).
 *
 * One function, because the same composition was about to be written for the
 * third time — profile, member list, cleanup purge — and three copies of "base
 * plus key" drift the day one of them learns about a CDN prefix. An honest
 * null beats a URL that would 404: every client falls back to initials.
 */
export function publicMediaUrl(
  base: string | undefined,
  key: string | null | undefined,
): string | null {
  const trimmed = base?.replace(/\/$/, '');
  return trimmed && key ? `${trimmed}/${key.replace(/^\//, '')}` : null;
}

/**
 * The same, for a key that is only readable if it lives in the public bucket.
 *
 * Catalogue uploads used to be presigned against the private bucket while this
 * URL was composed against the public host, so every one of them resolved and
 * returned 404 — and a 404 is worse than an absence, because a client cannot
 * tell it from a broken deployment. A legacy `u/` key is one of those objects:
 * it is not on the public host and no URL will make it appear there, so it
 * reads as missing until the object is re-uploaded under a public prefix.
 */
export function publicCatalogueUrl(
  base: string | undefined,
  key: string | null | undefined,
): string | null {
  if (!key || !isPublicKey(key)) return null;
  return publicMediaUrl(base, key);
}

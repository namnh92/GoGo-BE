import { createHash } from 'node:crypto';

/**
 * ADM-003 (#456) / ADR-0019 §8 — deterministic ETags.
 *
 * The entity is `datasetVersion` plus the *resolved* request: not the raw query
 * string, but every parameter after defaults have been applied and values
 * canonicalised. Two spellings of the same request (`?includeLegacy=false` and
 * the default) are the same entity and share a tag; two different requests
 * cannot, because every parameter that changes the body is in the hash.
 *
 * No clock and no process-local randomness. Two processes serving the same
 * version answer with the same tag, which is what makes the tag useful behind
 * more than one instance — and what stops a restart from invalidating every
 * client's cache for no reason.
 *
 * The tag is strong, not weak: the body is byte-deterministic for a given
 * version and resolved request, so there is nothing to be vague about.
 */
export type EtagParts = Record<string, string | number | boolean | null | undefined>;

export function administrativeEtag(
  datasetVersion: string,
  route: string,
  parts: EtagParts,
): string {
  // Sorted so parameter order in the URL cannot change the tag, and typed so
  // `1` and `"1"` cannot collide into one entry.
  const canonical = Object.keys(parts)
    .sort()
    .filter((key) => parts[key] !== undefined)
    .map((key) => [key, typeof parts[key], String(parts[key])]);
  const digest = createHash('sha256')
    .update(JSON.stringify([datasetVersion, route, canonical]))
    .digest('base64url');
  return `"${digest}"`;
}

/**
 * `If-None-Match` may carry a list, and a proxy may weaken a tag on the way
 * through. A weak comparison is the correct one for a cache validator on a
 * GET, so `W/` is stripped before comparing.
 */
export function ifNoneMatchSatisfied(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (value: string) => value.trim().replace(/^W\//, '');
  const wanted = strip(etag);
  return header.split(',').some((candidate) => {
    const value = strip(candidate);
    return value === '*' || value === wanted;
  });
}

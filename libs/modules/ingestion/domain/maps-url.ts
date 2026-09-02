/**
 * COST-BE-006 (#339) — the Maps URL parser and its SSRF-guarded redirect
 * walker now live in `@gogo/providers`.
 *
 * They moved because there were two short-link expanders and only one of them
 * was safe. This one — hostname allowlist, private-IP block, manual redirects,
 * hop cap, timeout — was in `libs/modules`, where `GooglePlacesAdapter` cannot
 * reach it: `libs/providers` is a leaf package. So the adapter grew its own,
 * a bare `fetch(url, { redirect: 'follow' })`, and `/v1/places/imports` handed
 * it raw user URLs.
 *
 * The code is provider-shaped anyway. It knows Google's hostnames and Google's
 * URL formats and nothing about GoGo's domain, so `libs/providers` is where it
 * belonged.
 *
 * This file stays as a re-export: every existing importer keeps working, and
 * the move is not what a reviewer of this PR has to check.
 */
export {
  MAX_REDIRECTS,
  REDIRECT_TIMEOUT_MS,
  expandShortLink,
  isAllowedMapsHost,
  parseMapsUrl,
  type Fetcher,
  type MapsUrlHints,
  type UrlParseResult,
} from '@gogo/providers';

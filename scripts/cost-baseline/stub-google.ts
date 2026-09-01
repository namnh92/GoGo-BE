/**
 * PR3 / COST-BE-003 (#336) — a Google that never changes.
 *
 * The BEFORE baseline has to be frozen before PR4 touches anything, and it has
 * to stay re-runnable afterwards or it cannot be the thing PR4 is measured
 * against. Two properties are therefore non-negotiable, and live Google has
 * neither: the same input must produce the same counts every time, and running
 * it must not require a credential the team does not currently have.
 *
 * So this replaces the *transport* and nothing else. Above it sit the real
 * `GooglePlacesAdapter`, the real field masks, the real resilience wrapper,
 * the real resolver, the real import pipeline, the real metrics port and the
 * real ledger. What a scenario costs is decided by how many times that stack
 * calls `fetch` and with what — which is exactly what PR4 (same-execution
 * reuse, DB-first) and PR5 (tier by need) change.
 *
 * What it therefore does **not** measure, and what the artifact says out loud:
 * real latency, real error rates, real Google-side billable units. Those need
 * the `live` transport on DEV. A stubbed p95 is a measurement of this laptop.
 *
 * Field masks are honoured rather than ignored. A `core` request gets a `core`
 * response, so when PR5 moves the resolver from `quality` to `core` the
 * baseline shows fields disappearing as well as a cheaper SKU — a stub that
 * always returned everything would let a tier change look free of consequence.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type GoogleCatalog = {
  places: Record<string, Record<string, unknown>>;
  /** Exact composed query → the ids Text Search answers with, in order. */
  searchText: Record<string, string[]>;
  /** Short link → the URL it redirects to. */
  expand: Record<string, string>;
};

export type StubRequest = {
  /** `searchText` | `details` | `expand` | `unmatched` */
  kind: 'searchText' | 'details' | 'expand' | 'unmatched';
  url: string;
  method: string;
  /** The field mask the caller sent, so a tier change is visible in the log. */
  fieldMask?: string;
  status: number;
};

/**
 * Walk up from the working directory to the workspace root.
 *
 * Not `__dirname` and not `import.meta.dirname`: this module is loaded both by
 * vitest (ESM) and by `node -r @swc-node/register` (CJS), and exactly one of
 * those two identifiers exists in each. The marker file is unambiguous and
 * costs one stat per level.
 */
function repoRoot(from: string = process.cwd()): string {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(from);
    dir = parent;
  }
}

export const FIXTURES_DIR = path.join(repoRoot(), 'docs/cost-baselines/fixtures');

export function loadCatalog(dir: string = FIXTURES_DIR): GoogleCatalog {
  return JSON.parse(readFileSync(path.join(dir, 'google-catalog.json'), 'utf8')) as GoogleCatalog;
}

export type StubHandle = {
  /** Every request the stack made, in order. The audit trail for a run. */
  readonly requests: StubRequest[];
  restore(): void;
};

/**
 * Install the stub over `globalThis.fetch`.
 *
 * Global rather than injected because the two expanders and the adapter each
 * reach for `fetch` independently, and a baseline that only intercepted one of
 * them would report a hop it did not count as a hop that did not happen —
 * which is the precise bug #336 found in the resolver's own walker.
 *
 * Anything the catalog does not name gets a 404 with Google's error envelope.
 * A stub that invented a plausible answer for an unknown id would let a
 * fixture drift produce a different, still-green baseline.
 */
export function installGoogleStub(catalog: GoogleCatalog): StubHandle {
  const requests: StubRequest[] = [];
  const original = globalThis.fetch;

  const stub = async (input: unknown, init?: Record<string, unknown>): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const fieldMask = headers['X-Goog-FieldMask'];

    if (url.startsWith('https://places.googleapis.com/v1/places:searchText')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { textQuery?: string };
      const ids = catalog.searchText[body.textQuery ?? ''] ?? [];
      requests.push({
        kind: 'searchText',
        url,
        method,
        ...(fieldMask ? { fieldMask } : {}),
        status: 200,
      });
      return json(200, { places: ids.map((id) => ({ id })) });
    }

    if (url.startsWith('https://places.googleapis.com/v1/places/')) {
      const id = decodeURIComponent(url.slice('https://places.googleapis.com/v1/places/'.length));
      const place = catalog.places[id];
      const status = place ? 200 : 404;
      requests.push({ kind: 'details', url, method, ...(fieldMask ? { fieldMask } : {}), status });
      if (!place) return json(404, googleError(404, 'NOT_FOUND'));
      return json(200, applyFieldMask(place, fieldMask));
    }

    if (/(maps\.app\.goo\.gl|goo\.gl\/maps)/.test(url)) {
      const target = catalog.expand[url];
      const status = target ? 302 : 404;
      requests.push({ kind: 'expand', url, method, status });
      if (!target) return new Response(null, { status: 404 });
      // Both expanders are served at once: the resolver's walker reads
      // `location` off a manual redirect, the adapter's reads `res.url` after
      // following one. Answering both from the same response is what lets the
      // baseline count them under one operation without pretending they are
      // one code path.
      const res = new Response(null, { status: 302, headers: { location: target } });
      Object.defineProperty(res, 'url', { value: target });
      return res;
    }

    requests.push({ kind: 'unmatched', url, method, status: 404 });
    return json(404, googleError(404, 'NOT_FOUND'));
  };

  (globalThis as { fetch: unknown }).fetch = stub;
  return {
    requests,
    restore() {
      (globalThis as { fetch: unknown }).fetch = original;
    },
  };
}

/**
 * Keep only the top-level fields the mask names.
 *
 * Google's mask syntax is a dotted path list (`places.id`,
 * `regularOpeningHours`); the adapter only ever sends whole top-level fields
 * for Details, so matching on the first segment is exact for every mask this
 * codebase produces rather than an approximation of the real grammar.
 */
export function applyFieldMask(
  place: Record<string, unknown>,
  fieldMask: string | undefined,
): Record<string, unknown> {
  if (!fieldMask) return place;
  const wanted = new Set(fieldMask.split(',').map((f) => f.trim().split('.')[0]!));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(place)) {
    // `id` and `location` are what the adapter uses to decide the response is
    // usable at all, and every real mask includes them.
    if (wanted.has(key)) out[key] = value;
  }
  return out;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function googleError(code: number, status: string): unknown {
  return { error: { code, status, message: 'not found in the pinned baseline catalog' } };
}

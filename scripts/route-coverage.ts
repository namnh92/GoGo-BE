/**
 * BE-BFF-012 — the comparison behind `pnpm api:routes`, kept free of the Nest
 * boot so it can be tested on its own (`check-route-coverage.ts` runs it
 * against the real router table).
 *
 * GoGo-BE#713 adds one rule. A contract-first slice declares operations before
 * the module that serves them exists, so Mobile and CMS can generate a client
 * while the backend is built. Such an operation carries
 * `x-gogo-planned: <issue>` and is allowed to be documented-but-not-served.
 * The marker is not a way to park drift:
 *
 * - a planned operation that **is** served fails the gate — the PR that serves
 *   it must remove the marker, so the document never says "not served yet"
 *   about a route that answers;
 * - the marker must name an issue (`GoGo-BE#713`, `GoGo-CMS#249`), so every
 *   planned operation points at the work that removes it;
 * - an unmarked operation that is not served still fails, exactly as before.
 */
import { parse as parseYaml } from 'yaml';

/** `/rooms/{id}` and `/rooms/:id` are the same route. */
export function normalize(route: string): string {
  return (
    route
      .replace(/\s+/g, '')
      .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      .replace(/\/$/, '') || '/'
  );
}

export const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/**
 * operationId must be unique across the document — client generators name
 * methods after it, so a duplicate silently collides one operation with
 * another. Neither `api:check` (type drift) nor oasdiff (breaking changes)
 * catches this, and the Mobile team generates its client from this file.
 */
export function duplicateOperationIds(text: string): string[] {
  const seen = new Map<string, number>();
  for (const match of text.matchAll(/^\s+operationId:\s*(\S+)\s*$/gm)) {
    const id = match[1]!;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id} (×${n})`);
}

/**
 * Operations in the spec as `METHOD path`.
 *
 * Comparing paths alone let a new method on an existing path through unnoticed:
 * adding `GET /rooms` next to `POST /rooms` was invisible to this check until
 * it counted the pair.
 */
export function specOperations(text: string): Set<string> {
  const out = new Set<string>();
  let inPaths = false;
  let current: string | null = null;
  for (const line of text.split('\n')) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^[a-z]/.test(line)) break;

    const pathMatch = /^ {2}(\/[^:]*):\s*$/.exec(line);
    if (pathMatch) {
      current = normalize(pathMatch[1]!);
      continue;
    }
    const methodMatch = /^ {4}([a-z]+):\s*$/.exec(line);
    if (current && methodMatch && METHODS.includes(methodMatch[1]!)) {
      out.add(`${methodMatch[1]!.toUpperCase()} ${current}`);
    }
  }
  return out;
}

/** `GoGo-BE#713`, `GoGo-CMS#249` — the work that will serve the operation. */
export const PLANNED_MARKER = /^GoGo-[A-Za-z]+#\d+$/;

export type PlannedOperations = {
  /** `METHOD path` → the issue it names. */
  planned: Map<string, string>;
  /** Operations whose marker is present but does not name an issue. */
  malformed: string[];
};

/** Operations carrying `x-gogo-planned`, read from the parsed document. */
export function plannedOperations(text: string): PlannedOperations {
  const doc = parseYaml(text) as { paths?: Record<string, Record<string, unknown>> } | null;
  const planned = new Map<string, string>();
  const malformed: string[] = [];
  for (const [route, item] of Object.entries(doc?.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (!METHODS.includes(method) || typeof operation !== 'object' || operation === null) {
        continue;
      }
      if (!('x-gogo-planned' in operation)) continue;
      const key = `${method.toUpperCase()} ${normalize(route)}`;
      const marker = (operation as Record<string, unknown>)['x-gogo-planned'];
      if (typeof marker === 'string' && PLANNED_MARKER.test(marker)) planned.set(key, marker);
      else malformed.push(key);
    }
  }
  return { planned, malformed: malformed.sort() };
}

/**
 * printRoutes collapses parametric siblings that differ only by name into a
 * single `{id}|{roomId}` node. Expand it back so `/rooms/{roomId}/members` in
 * the spec still matches the `/rooms/{id}|{roomId}/members` the router prints.
 */
export function expand(route: string): string[] {
  const match = /\{[^}]*\}(?:\|\{[^}]*\})+/.exec(route);
  if (!match) return [route];
  return match[0]
    .split('|')
    .flatMap((alternative) =>
      expand(
        route.slice(0, match.index) + alternative + route.slice(match.index + match[0].length),
      ),
    );
}

export type Coverage = {
  /** Served but not documented. */
  missing: string[];
  /** Documented, not served, and not marked planned. */
  specOnly: string[];
  /** Documented as planned and not served — allowed, reported. */
  plannedPending: string[];
  /** Marked planned but served — the marker is stale. */
  plannedServed: string[];
  /** Marker present but naming no issue. */
  plannedMalformed: string[];
  ok: boolean;
};

export function compareRoutes(
  spec: Set<string>,
  served: Set<string>,
  planned: PlannedOperations,
): Coverage {
  const missing = [...served].filter((r) => !expand(r).some((v) => spec.has(v))).sort();
  const servedVariants = new Set([...served].flatMap(expand));
  const notServed = [...spec].filter((r) => !servedVariants.has(r));
  const specOnly = notServed.filter((r) => !planned.planned.has(r)).sort();
  const plannedPending = notServed.filter((r) => planned.planned.has(r)).sort();
  const plannedServed = [...planned.planned.keys()].filter((r) => servedVariants.has(r)).sort();
  const plannedMalformed = planned.malformed;
  return {
    missing,
    specOnly,
    plannedPending,
    plannedServed,
    plannedMalformed,
    ok:
      missing.length === 0 &&
      specOnly.length === 0 &&
      plannedServed.length === 0 &&
      plannedMalformed.length === 0,
  };
}

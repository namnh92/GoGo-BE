/**
 * BE-BFF-012 — proves the OpenAPI file still describes every route the app
 * actually serves. This used to be a hand-check (it once answered 60/91);
 * as a script it cannot silently regress.
 *
 * Routes come from the booted Nest app (the real router table), not from a
 * regex over the source, so a decorator typo shows up as a missing path.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

process.env.NODE_ENV ||= 'test';
process.env.DATABASE_URL ||= 'postgres://gogo:gogo@127.0.0.1:5432/gogo';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.AUTH_JWT_SECRET ||= 'route-coverage-check-secret'.padEnd(48, 'x');

/** `/rooms/{id}` and `/rooms/:id` are the same route. */
function normalize(route: string): string {
  return (
    route
      .replace(/\s+/g, '')
      .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      .replace(/\/$/, '') || '/'
  );
}

/**
 * operationId must be unique across the document — client generators name
 * methods after it, so a duplicate silently collides one operation with
 * another. Neither `api:check` (type drift) nor oasdiff (breaking changes)
 * catches this, and the Mobile team generates its client from this file.
 */
function duplicateOperationIds(text: string): string[] {
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
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function specOperations(text: string): Set<string> {
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

async function servedRoutes(): Promise<Set<string>> {
  // require, not import(): the ESM loader bypasses @swc-node/register, which
  // is what emits the decorator metadata Nest DI needs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createApp } = require('../apps/api/src/main') as {
    createApp: () => Promise<NestFastifyApplication>;
  };
  const app = await createApp();
  await app.init();
  const fastify = app.getHttpAdapter().getInstance();
  const table: string = fastify.printRoutes({ commonPrefix: false });
  await app.close();

  // printRoutes renders a tree; rebuild full paths from the indentation.
  const routes = new Set<string>();
  const stack: { depth: number; segment: string }[] = [];
  for (const raw of table.split('\n')) {
    const match = /^([│└├─\s]*)(\S.*)$/.exec(raw);
    if (!match) continue;
    const depth = match[1]!.length;
    let segment = match[2]!;
    const methods = /\((.*)\)\s*$/.exec(segment);
    // A node can carry methods *and* children, so strip the "(GET, POST)"
    // suffix and the padding before it from the segment either way.
    if (methods) segment = segment.slice(0, methods.index);
    segment = segment.trim();
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const full = stack.map((s) => s.segment).join('') + segment;
    stack.push({ depth, segment });
    if (methods) {
      const path = normalize(full.replace(/^\/v1/, ''));
      for (const method of methods[1]!.split(',').map((m) => m.trim())) {
        if (method === 'HEAD') continue; // fastify adds HEAD for every GET
        routes.add(`${method} ${path}`);
      }
    }
  }
  return routes;
}

/**
 * printRoutes collapses parametric siblings that differ only by name into a
 * single `{id}|{roomId}` node. Expand it back so `/rooms/{roomId}/members` in
 * the spec still matches the `/rooms/{id}|{roomId}/members` the router prints.
 */
function expand(route: string): string[] {
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

/** Not routes: the fastify catch-all and the empty root node of the tree. */
const IGNORED = new Set(['/*', '']);

const pathOf = (operation: string) => operation.slice(operation.indexOf(' ') + 1);

async function main(): Promise<void> {
  const specText = readFileSync(path.resolve('openapi/gogo.v1.yaml'), 'utf8');
  const spec = specOperations(specText);
  const duplicates = duplicateOperationIds(specText);
  const served = new Set([...(await servedRoutes())].filter((r) => !IGNORED.has(pathOf(r))));

  const missing = [...served].filter((r) => !expand(r).some((v) => spec.has(v))).sort();
  const servedVariants = new Set([...served].flatMap(expand));
  const specOnly = [...spec].filter((r) => !servedVariants.has(r)).sort();

  console.log(`served ops : ${served.size}`);
  console.log(`spec ops   : ${spec.size}`);
  console.log(`MISSING from spec (${missing.length}):`);
  for (const r of missing) console.log(`  - ${r}`);
  console.log(`SPEC-ONLY, not served (${specOnly.length}):`);
  for (const r of specOnly) console.log(`  - ${r}`);

  console.log(`DUPLICATE operationIds (${duplicates.length}):`);
  for (const d of duplicates) console.log(`  - ${d}`);

  if (missing.length > 0 || specOnly.length > 0) {
    console.error('\nOpenAPI and the router disagree — update openapi/gogo.v1.yaml.');
    process.exit(1);
  }
  if (duplicates.length > 0) {
    console.error('\noperationId must be unique — client generators name methods after it.');
    process.exit(1);
  }
  console.log('\nOK: routes documented, paths served, operationIds unique.');
  process.exit(0);
}

void main();

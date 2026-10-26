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
import {
  compareRoutes,
  duplicateOperationIds,
  normalize,
  plannedOperations,
  specOperations,
} from './route-coverage';

process.env.NODE_ENV ||= 'test';
process.env.DATABASE_URL ||= 'postgres://gogo:gogo@127.0.0.1:5432/gogo';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.AUTH_JWT_SECRET ||= 'route-coverage-check-secret'.padEnd(48, 'x');

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

/** Not routes: the fastify catch-all and the empty root node of the tree. */
const IGNORED = new Set(['/*', '']);

const pathOf = (operation: string) => operation.slice(operation.indexOf(' ') + 1);

async function main(): Promise<void> {
  const specText = readFileSync(path.resolve('openapi/gogo.v1.yaml'), 'utf8');
  const spec = specOperations(specText);
  const duplicates = duplicateOperationIds(specText);
  const served = new Set([...(await servedRoutes())].filter((r) => !IGNORED.has(pathOf(r))));
  const planned = plannedOperations(specText);
  const coverage = compareRoutes(spec, served, planned);

  const list = (title: string, items: string[], note = (_r: string) => '') => {
    console.log(`${title} (${items.length}):`);
    for (const r of items) console.log(`  - ${r}${note(r)}`);
  };

  console.log(`served ops : ${served.size}`);
  console.log(`spec ops   : ${spec.size}`);
  list('MISSING from spec', coverage.missing);
  list('SPEC-ONLY, not served', coverage.specOnly);
  list(
    'PLANNED, not served yet (x-gogo-planned)',
    coverage.plannedPending,
    (r) => ` — ${planned.planned.get(r)}`,
  );
  list('PLANNED but served — remove x-gogo-planned', coverage.plannedServed);
  list('x-gogo-planned not naming an issue (GoGo-<Repo>#<n>)', coverage.plannedMalformed);
  list('DUPLICATE operationIds', duplicates);

  if (!coverage.ok) {
    console.error('\nOpenAPI and the router disagree — update openapi/gogo.v1.yaml.');
    process.exit(1);
  }
  if (duplicates.length > 0) {
    console.error('\noperationId must be unique — client generators name methods after it.');
    process.exit(1);
  }
  console.log('\nOK: routes documented, paths served (or planned), operationIds unique.');
  process.exit(0);
}

void main();

# ADR-0001: Backend runtime, repo layout and build tooling

- **Status:** Accepted
- **Date:** 2026-08-27
- **Related:** FND-001, FND-002, BE-BFF-001

## Context

GoGo-BE hosts the API BFF, workers, DB schema, search, suggestion and CMS APIs. The SRS locks NestJS + Fastify on Node LTS, PostgreSQL/PostGIS, Redis/BullMQ, modular monolith with `api` + `worker` processes.

## Decision

1. **pnpm workspace + Turborepo** inside GoGo-BE: packages `apps/api`, `apps/worker`, `libs/modules`, `libs/database`, `libs/providers`, `libs/observability`. Libs are internal packages exporting TypeScript source (`main: ./src/index.ts`); each app compiles itself with `tsc`, dev runs via `tsx`.
2. **TypeScript strict** plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. CJS output (`module: NodeNext`, no `"type": "module"`) — Node 22 `require(esm)` covers ESM-only deps.
3. **NestJS 11 + Fastify 5** for `api`; `worker` is a plain Node process hosting BullMQ consumers (no Nest HTTP stack where none is needed).
4. **Vitest** with two projects: `unit` (`*.spec.ts`) and `integration` (`*.int.spec.ts`, Testcontainers).
5. Modular monolith; no microservice split before load/ownership evidence (SRS §6.2).

## Consequences

- One lockfile, atomic cross-layer changes, single CI.
- Internal TS-source packages mean no per-lib build step; app builds compile the graph. If build times grow, switch libs to prebuilt `tsc -b` project references — layout already compatible.

## Rollback

Turborepo is thin (two tasks); removing it degrades to plain pnpm scripts. Nest/Fastify locked by SRS — changing them requires a superseding ADR.

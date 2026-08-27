# ADR-0005: API client generation & contract artifacts

- **Status:** Accepted
- **Date:** 2026-08-27
- **Related:** FND-003, FND-004, QP-002, `.claude/rules/api-contract.md`

## Context

The contract rule: OpenAPI is the source contract; TypeScript clients are
generated, never hand-written, and consumer CI must fail when the generated
client does not match the declared spec version.

## Decision

1. **Generator: `openapi-typescript`** — zero runtime, emits pure types
   (`paths`/`components`/`operations`) from `openapi/gogo.v1.yaml`. Clients
   pair it with a thin typed fetch wrapper (`openapi-fetch`) in their own
   repos; no generated runtime code crosses repo boundaries.
   - Rejected: `orval`/`openapi-generator` — generated runtime + heavier
     toolchains; more surface to drift.
2. **Generated types are committed** at `openapi/gogo.v1.d.ts`.
   `pnpm api:types` regenerates; **`pnpm api:check` fails CI on drift**
   (spec edited without regenerating, or hand-edits to the generated file).
   Generation also acts as spec validation — an invalid spec fails the build.
3. **Contract artifacts published per CI run** (`gogo-api-contract`:
   spec + types). Web/Mini/App pin a GoGo-BE commit/release and download the
   artifact — no hand-copying. When the release process matures this becomes
   a versioned npm package in the org registry (needs registry decision).
4. Version discipline: breaking `/v1` changes are prohibited without a
   deprecation policy (BE-BFF-012); consumers compare `info.version`.

## Consequences

- FE repos get compile-time breakage on contract drift instead of runtime
  surprises; BE cannot silently change the contract (CI gate both sides).
- Event schemas + design tokens ride the same artifact pattern later.

## Rollback

Generator swap touches only the two package scripts and the committed
`.d.ts`; the YAML spec is unaffected.

# GoGo-BE #887 — S5 aliases validation

Authority: rev3 shape §§4.2–4.3, 4.6, 7–9 and the 2026-11-12 S3/S4 amendments. Owner authorized implementation on `feature/GOGO-887-place-aliases` from `50c6691a`. No commit, push, deployment or flag change was performed. Local baseline SHA remains `50c6691a`.

## Delivered behavior

- `0103_place-aliases.sql` creates an empty editorial table, composite unique primary key, place-delete cascade, nullable staff attribution with staff-delete SET NULL, equality and trigram indexes. Journal idx 103 has `when=1794355200103`, strictly newer than idx 102. No existing places are rewritten. Drizzle maps the same schema.
- CMS GET detail always returns `aliases: string[]`. PATCH replaces the complete set when supplied, preserves it when omitted, and clears it with `[]`. Create remains unchanged; aliases are edited after creation. All replacements, including removal, require `expectedUpdatedAt` and `aliasProvenance={sourceType:'editorial',sourceReference,collectedAt}`. One source must support the entire replacement batch. Evidence uses the existing independent-source checks: no Google/transport-only reference, required zoned collection timestamp, maximum five-minute future skew. Provider/model/chat origins are rejected; transcription never transfers ownership.
- Maximum 20 submitted entries before deduplication, 120 characters each; empty/control/format/separator values rejected before trimming. Normalized duplicate aliases collapse. No import/provider/model/chat ingestion path was added.
- Existing editor write guard (including existing super-admin override), transactional row lock, version recheck and immutable audit are reused. Alias saves advance the millisecond form version even for two saves in the same millisecond. Audit stores counts, sorted-set SHA-256 digests and evidence; no raw alias text. Queries bind parameters; existing error/request serializers suppress parameters and bodies.
- Exact canonical and alias candidates are complete before fuzzy cutoff. Canonical and alias equality use separate indexed channels; alias equality groups by place ID, and alias fuzzy channels group by place ID before their cutoff. Existing current-area/publication/provider-closure predicates apply to aliases as well. Shared exact aliases form a family. Resolver outcome/ordinal precedence and the S4 producer are unchanged.
- `place-qa-cases.s5.vi.json` fixes 12 realistic synthetic alias cases and four venue fixtures: abbreviation, old name, English/Vietnamese name, nickname, normalization and two branches sharing a brand alias. These are test identities, not assertions about real merchants. The new S5 integration companion exercises real resolver SQL and public send → SSE → history with zero model calls; CMS tests cover evidence, roles, concurrency, audit, omission/clear and FK lifecycle.

## Contract and generated artifacts

MINOR `10.2.0-alpha.1` → `10.3.0-alpha.1`. Adds `CmsPlaceAliases`, `CmsAliasProvenance`, optional PATCH `aliases`/`aliasProvenance`, and required GET-detail `aliases` (empty array for existing places). Existing PATCH callers gain no required field. Six existing contract tests change only their literal version assertion. `openapi/gogo.v1.d.ts` is generated; `pnpm artifacts` generates the ignored manifest/OpenAPI/client bundle under `artifacts/`. Consumer repositories were not modified. Astra/CODEOWNER contract review and consumer regeneration/adoption remain release gates.

## Privacy and deletion assessment

`created_by` references **admin_users**, not consumer `users`. CMS staff IDs and consumer IDs are separate identity namespaces. Consumer data export/account deletion therefore gains no alias-owned personal rows and must not export other staff's catalog edits. Catalog aliases are GoGo editorial data and survive consumer deletion. A hard deletion of a staff row sets `created_by` NULL while retaining the independently sourced alias; the integration fixture tests that FK action. Existing privileged audit retention/erasure policy still applies to `audit_logs.actor_id`; this slice introduces no consumer-to-staff linkage or new staff account-deletion endpoint. Neither public DTOs nor resolver output expose alias authors or provenance. Place deletion cascades aliases. Migration rollback is documented inline: stop alias writes, deploy a pre-S5 reader, preserve evidence if required, then DROP TABLE place_aliases (loses alias content only). Do not roll the assistant below its existing marker-aware reader floor.

## Preservation

No S3 overlay/corpus/fixture or S4 Layer A harness/corpus was edited. `frozen-layer-a.exit` records a zero diff against HEAD for the preserved paths. The original S4 test is run separately against the combined implementation. The S5 companion and baseline script are new files; no S4 harness exception was needed. Existing resolver telemetry labels and trace shape are unchanged.

## Commands and evidence

All commands run from this worktree on 2026-11-12. Logs and exit files are under `docs/plans/887-evidence/`. Failed infrastructure setup is BLOCKED, never FAIL-before or PASS-after.

| Command                                                                                                                                                    | Exit    | Result                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm api:types`                                                                                                                                           | 0       | Generated tracked types                                                                              |
| `pnpm artifacts`                                                                                                                                           | 0       | Generated local publication bundle                                                                   |
| `pnpm vitest run --project unit libs/modules/cms/domain/place-aliases.spec.ts libs/modules/cms/presentation/place-aliases.contract.spec.ts`                | 0       | 27 passed; input, contract, editor metadata and log redaction                                        |
| `pnpm lint`                                                                                                                                                | pending | See final gate results below                                                                         |
| `pnpm format:check`                                                                                                                                        | pending | See final gate results below                                                                         |
| `pnpm typecheck`                                                                                                                                           | pending | See final gate results below                                                                         |
| `pnpm api:check`                                                                                                                                           | 0       | Generated type parity                                                                                |
| `pnpm api:routes`                                                                                                                                          | 0       | Route coverage                                                                                       |
| `pnpm check:boundaries`                                                                                                                                    | 0       | Module boundary check                                                                                |
| `pnpm test`                                                                                                                                                | pending | Full suite; sandbox prohibits the pre-existing Sentry HTTP listen test                               |
| `pnpm build`                                                                                                                                               | 0       | API and worker compiled                                                                              |
| `pnpm vitest run --project integration --no-file-parallelism apps/api/test/place-aliases-s5.int.spec.ts apps/api/test/place-aliases-migration.int.spec.ts` | 1       | BLOCKED: no working container runtime; 31 cases did not execute                                      |
| `pnpm vitest run --project integration apps/api/test/assistant-place-qa-s4.int.spec.ts`                                                                    | 1       | BLOCKED at container setup; preservation assertions did not execute                                  |
| `bash scripts/eval/place-qa-s5-base.sh 50c6691a docs/plans/887-evidence/base`                                                                              | 1       | BLOCKED before tests: offline store missing `@swc-node/register` tarball; no baseline behavior claim |

Initial full test run found six obsolete literal contract version assertions and the sandbox `listen EPERM` suite. Those six assertions were updated. Initial typecheck caught errors in the new integration harness; they were corrected before the final gate rerun. Initial logs are retained separately where applicable.

## Initial sandbox limitations (superseded where noted below)

Database assertions have **not run**: forward migration on populated pre-S5 DB, rerun/rollback, constraints/FKs/indexes; twelve alias FAIL-before/PASS-after pairs at resolver and public Layer A; competing CMS saves, roles, audit and evidence; combined S4 corpus/zero-model preservation. No claim of DEV acceptance or fresh EXPLAIN/p95/cancellation evidence. Docker socket access is denied by this sandbox. No external database was used.

DEV must run the candidate integration commands above, the unchanged S4 oracle, and the archived-production baseline script with dependencies available. The baseline copies only the S5 test and golden JSON; it provisions **test-only alias fixture storage** because pre-S5 production has no alias table. Candidate production code/migrations/configuration are never copied. Inspect each alias resolver and public-question row: baseline failures must reach the `SYMPTOM` assertions; head must pass every corresponding row. Setup/admission/model-adapter failures do not qualify. Migration/CMS safety cases are head acceptance, not expected failures to count toward the 12 alias pairs.

Also outstanding: independent Sol/Astra/CODEOWNER reviews; GoGo-CMS child issue/field implementation and generated-client adoption. DEV flag is already on per owner; this work does not change it. Owner DEV cases and release acceptance remain external evidence requirements.

## Files by purpose

| Purpose              | Files                                                                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage              | `migrations/0103_place-aliases.sql`, `migrations/meta/_journal.json`, `libs/database/src/schema/place-aliases.ts`, schema barrel `index.ts`                                                                                                                                                                     |
| CMS input/read/write | `libs/modules/cms/domain/place-aliases.ts`, `libs/modules/cms/application/cms-catalog.service.ts`, `libs/modules/cms/presentation/cms.controllers.ts`                                                                                                                                                           |
| Resolver             | `libs/modules/search/infrastructure/place-qa-queries.ts`                                                                                                                                                                                                                                                        |
| Contract             | `openapi/gogo.v1.yaml`, generated `openapi/gogo.v1.d.ts`; six version-literal contract tests in assistant, ingestion (two), notifications and reviews (two)                                                                                                                                                     |
| Golden / proof       | `libs/modules/assistant/eval/place-qa-cases.s5.vi.json`, `libs/modules/cms/domain/place-aliases.spec.ts`, `libs/modules/cms/presentation/place-aliases.contract.spec.ts`, `apps/api/test/place-aliases-s5.int.spec.ts`, `apps/api/test/place-aliases-migration.int.spec.ts`, `scripts/eval/place-qa-s5-base.sh` |
| Evidence             | This document and `docs/plans/887-evidence/`; local publication bundle `artifacts/` is generated and ignored                                                                                                                                                                                                    |

The candidate is uncommitted. `candidate-files.sha256` identifies changed source/tests/contracts/docs; `candidate-head.txt` identifies the unchanged Git HEAD. Final logs carry the corresponding gate outcomes. Turbo also reports cache-write permission warnings; successful command exits are preserved, and those warnings are not database/DEV proof.

## Sol continuation — 2026-11-12

Read DEV's external `dev/test-evidence/be-887/r1/int-place-aliases-s5.log`: 17 passed, 13 failed. All twelve public alias rows stopped at conversation admission with `503 ASSISTANT_DISABLED`; the CMS round trip stopped at PostgreSQL `42883` (`text = uuid`). These are fixture failures, not alias FAIL-before evidence. The owner reports the other specs green: S4 412, S3 417, fence 46, S2 25, #875, #877, CMS create 42, place-editor contract 68, search 33, migration 1. These reported results precede the continuation fixture changes.

Changes are confined to the S5 integration harness, baseline runner and this record:

- Copied S4's monthly budget and existing `f.setFlag(true)` / `flag(true)` setup. Both provider keys and bounded allowances remain configured; no readiness mock or production flag change.
- Seeded fictional addresses and editorial field provenance using S4's pattern. The public questions ask for addresses and still require `answer`, so missing facts must not change the expected outcome to `no_data`.
- Queried `audit_logs.resource_id` with a bound `::text` value, matching `libs/database/src/schema/cms.ts`.
- Preserved every assertion and added a public check rejecting fuzzy `place_confirm` follow-ups, since a fuzzy canonical match can return the same card as an exact alias. Resolver exact-venue failures now also carry an explicit `SYMPTOM` label.
- Baseline dependencies may download missing tarballs (`pnpm install --frozen-lockfile`). Only the harness/corpus are overlaid on archived baseline production. The runner requires a fresh evidence directory and produces a 24-row `alias-proof.json` (12 IDs × resolver/public); only a unique failed row with one `AssertionError: SYMPTOM:` failure qualifies. Admission/setup/skipped/missing/duplicate rows are BLOCKED and unexpected passes fail verification. `proof.exit=0` requires every row to qualify; a nonzero Vitest exit alone never qualifies.

Local continuation logs and exit files are in `docs/plans/887-evidence/r2/`. Focused units: 43 passed across alias domain/contract, place-QA read and #877 unit specs (exit 0). The classifier's seven synthetic smoke cases passed (exit 0), including rejection of admission/setup/missing/duplicate/unexpected-pass/no-report input; this validates classification only, not baseline behavior. The local integration attempt exited 1 at container startup with all 30 tests skipped. No PASS-after or FAIL-before integration claim is made for this revision. Final typecheck/lint/Prettier results are recorded in the corresponding `.exit`/`.log` files; `candidate-files.sha256` in this directory identifies the continuation source snapshot.

DEV must run these commands **outside the sandbox**, from this same worktree, with Docker/Testcontainers available (or the existing `ASSISTANT_TEST_DATABASE_URL` fixture configuration) and network access for missing baseline dependencies. Use a fresh directory for every rerun:

```bash
cd /Users/maxnguyen/MyWorks/GoGo/dev/worktrees/be-887
evidence_dir=/Users/maxnguyen/MyWorks/GoGo/dev/test-evidence/be-887/r2
mkdir -p "$evidence_dir"
pnpm exec vitest run --project integration apps/api/test/place-aliases-s5.int.spec.ts \
  --reporter=default --reporter=json --outputFile="$evidence_dir/candidate.vitest.json" \
  > "$evidence_dir/candidate.log" 2>&1
candidate_exit=$?
printf '%s\n' "$candidate_exit" > "$evidence_dir/candidate.exit"
bash scripts/eval/place-qa-s5-base.sh 50c6691a "$evidence_dir/base" \
  > "$evidence_dir/base-runner.log" 2>&1
baseline_exit=$?
printf '%s\n' "$baseline_exit" > "$evidence_dir/base-runner.exit"
```

Required evidence: candidate exit 0, all 30 rows passing; baseline `base.sha` equals the full SHA for `50c6691a`; `install.exit=0`, `test.exit=1`, `proof.exit=0`, and `alias-proof.json.status=FAIL_BEFORE_VERIFIED` with all 24 rows `FAIL_BEFORE`. The baseline runner itself returns 1 for the expected failing tests. CMS/FK and the two additional resolver safety rows are head acceptance, not part of the twelve golden alias pairs. Match every alias ID/layer against the passing candidate JSON and verify the overlay hashes still match the candidate harness/corpus.

## DEV r2 results and timestamp assertion correction — 2026-11-12

External evidence root: `/Users/maxnguyen/MyWorks/GoGo/dev/test-evidence/be-887/r2/`.

- Candidate integration: `int-s5.log` records **29/30 PASS**, with one failed CMS audit assertion. The stored `evidence.collectedAt` is the correct normalized UTC value `2026-11-01T10:00:00.000Z`; the test expected the raw input `2026-11-01T10:00:00Z`. This continuation expects `new Date(evidence.collectedAt).toISOString()` in the audit object, preserving the source type/reference, before/after counts, raw-alias exclusion and every other assertion. A DEV rerun of the corrected candidate is still required before claiming 30/30 PASS.
- Baseline proof: `base/base.sha` records `50c6691a178917d7ea91fcede8fe07c2c59994d3`; `base/install.exit=0`, `base/test.exit=1`, and `base/proof.exit=0`. `base/alias-proof.json` reports `FAIL_BEFORE_VERIFIED`, with **24/24 FAIL_BEFORE** rows (12 alias IDs × resolver/public). Detailed execution evidence is in `base/test.log` and `base/vitest.json`; copied harness/corpus identity is recorded in `base/overlay.sha256`.

These results supersede the earlier pending-DEV status for baseline proof and the pre-correction candidate run only. The baseline proof binds to its archived overlay; the timestamp assertion edit changes the candidate harness identity. Preserve the original evidence and capture fresh candidate results and overlay hashes when completing verification. No 30/30 PASS-after or DEV acceptance is claimed by this assertion-only correction.

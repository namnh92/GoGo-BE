# ADR-0031: Address, phone and website are GoGo-owned place data

- **Status:** accepted (owner decision 2026-10-02, option A; shape by SA review)
- **Date:** 2026-10-02
- **Deciders:** owner (product), SA (shape), DEV (implementation) — GoGo-BE#280

## Context

`places.address_text`, `phone` and `website` have existed since DB-005, but
nothing said whose data they are. The address was written from Google's
formatted address on every import and approval; phone and website could be
typed in the console or a sheet and were then recorded `editorial` with no
reference — a person typing a value was enough to "own" it. The CMS import
wizard offered an `address` mapping that `/v1` silently discarded
(`RETIRED_FIELDS`, PR #278).

GoGo-BE#280 asked which of three options applies: A (GoGo-owned), B (Google
attribute, never stored) or C (address Google, contacts GoGo). The owner chose
**A** on 2026-10-02, consistent with `GOGO_PRODUCT_DATA_ARCHITECTURE.md`: GoGo
owns Places; Google is identity, routes and directions only. Copying, retyping
or confirming Google content never transfers ownership.

## Options considered

1. **New columns or a contact JSON blob** — duplicates storage the schema
   already has; rejected.
2. **Provider-source columns per field** — reintroduces persisted Google
   content; rejected under the permanent persistence freeze.
3. **Reuse the existing columns, prove ownership with per-field evidence** —
   chosen.

## Decision

- **Storage.** Reuse `places.address_text`, `phone`, `website` and the API names
  `addressText`, `phone`, `website`. Add one nullable column,
  `place_field_provenance.collected_at` (migration 0070). No other schema change.
- **Validation** (`libs/modules/shared/place-contact.ts`, shared by the console,
  bulk import and submission approval): address trimmed, non-blank, ≤ 400
  characters, plain text (no control characters, no angle brackets), Unicode
  kept, never used to infer coordinates or codes. Phone normalized to E.164 and
  checked against `^\+[1-9][0-9]{7,14}$`, input ≤ 40 characters, no extensions or
  letters. Website `http`/`https` on a public DNS host, ≤ 500 characters after
  normalization, no credentials, IP literals, `localhost` or private suffixes;
  never fetched.
- **Evidence.** A non-null value is written only with `sourceType`
  (`editorial` | `community` | `provider` — never `google_derived`),
  `sourceReference` (≤ 500 characters, naming the non-Google origin; Google
  links, Place IDs and "Google" are refused) and `collectedAt` (not in the
  future). Actor and `verified_at` are server-owned. `null` clears the value and
  removes its provenance row without inventing evidence. Re-sending an
  unchanged value without evidence is not a write and does not advance
  `verified_at`.
- **Ownership verdict** (`contactOwnership`): `gogo` only with an independent
  source type, a non-Google reference and a collection time; `google` for a
  `google_derived` seed; `unknown` otherwise — including every legacy
  `editorial` row with no reference. Nothing is backfilled or relabelled.
- **Doors.** Console create/edit (`provenance` body property; edit requires
  `expectedUpdatedAt` for a contact write and re-checks it under `FOR UPDATE`;
  value, evidence, clear and audit commit in one transaction; the existing
  `place.updated` outbox event triggers reindex). Bulk import (`address` is
  canonical again; `<field>_source_type|_source_reference|_collected_at`
  columns; missing/invalid evidence is a row error in dry-run and commit;
  blank cells preserve; `update_existing` now writes all three). Submission
  approval (review draft carries `provenance`; a pre-#280 draft without it is
  refused `409 REVIEW_EVIDENCE_REQUIRED`).
- **No Google writes.** No door writes Google's formatted address any more:
  bulk import create and `update_existing`, submission approval, `/v1/places/imports`
  and the console's create (any non-empty `googleDerivedFields` is refused
  `GOOGLE_CONTENT_NOT_PERSISTABLE` since GoGo-BE#440; see below).
  Google disagreement can neither overwrite, resurrect nor relabel these fields.
- **Public exposure.** `PlaceDetail.provenance` keyed by field,
  `{ sourceType: gogo|google|unknown, verifiedAt?, provider? }`; references and
  actors stay CMS-only. Stored phone/website that fail today's rules are
  suppressed at the public mapper.

## Transport guard (SA decision 2026-10-03, after review findings F-05 → F-10)

`sourceReference` must name an origin; a job, sheet or row id names only how a
cell travelled. Detecting that is done by a **bounded lexical guard** in
`isTransportReference` (`libs/modules/shared/place-contact.ts`), shared by
`validateEvidence` (console, import, submission save and approval) and by the
ownership read (`contactOwnership`), so stored evidence the write path would
refuse never reads as `gogo`. Order:

1. required / length (≤ 500) / control-character / Google checks
   (`google_not_independent`);
2. the whole trimmed reference parses with `normalizeWebsite` (scheme optional,
   fragment allowed) → origin, exempt from steps 3–4; nothing is fetched;
3. NFC, case-insensitive: the reference starts with a frozen keyword — `job`,
   `jobs`, `sheet`, `sheets`, `tab`, `row`, `rows`, `dòng`, `dong`, `cột`,
   `cot`, `col`, `column`, `cell`, `import`, `batch`, `file`, `upload`, `csv`,
   `xlsx`, `spreadsheet`, `id`, `r` — and the next character is absent or not a
   Unicode letter → `transport_only`;
4. the whole reference is an ASCII decimal number, a hexadecimal UUID
   `8-4-4-4-12`, an A1 cell/range (optional `$`, 1–3 column letters, positive
   row) with an optional non-empty `label!`, or a non-empty `label#digits` →
   `transport_only`.

Everything else passes **this guard**. There is deliberately no "contains a
digit" rule, no token scoring and no short-uppercase heuristic: each was tried
in review and produced a gap (F-07) or a false positive (F-08 `…#2` URLs,
F-09 `pho24.vn`, F-10 language-dependence, `Tab Quận 1`).

**Accepted limitations.** Conservative false positives: a genuine origin that
begins with a keyword is refused (`job 123; gọi chủ quán`, `Job Café merchant
statement`) — put the origin first. Detection gaps: unfamiliar labels,
reordered identifiers and non-Google transport URLs pass (`Bảng Quận 1`,
`123, row 4`); passing is an editorial assertion, not adequate evidence.
Extending detection, or requiring mechanically verifiable evidence, needs a new
architecture decision rather than another token patch. Transport stays in the
importer's own job/sheet/row metadata and never supplies missing origin.

**Test corpus.** Every row of the SA decision's table is an independent unit
case in `libs/modules/shared/place-contact.spec.ts` ("Astra transport-guard
corpus"), together with the earlier F-05/F-07/F-08 tables.

## Relation to GoGo-BE#440 (SA decision 2026-10-03, contract 1.0.0-alpha.66)

GoGo-BE#440 (merged first, contract alpha.62) made `POST /v1/cms/places`
require a `sourceReferences` entry for every supplied canonical fact, contact
fields included. Two channels for the same evidence would let a contact value
be "owned" on a bare string with no source type or collection time, so the
reconciliation is:

1. **One channel per field.** On create _and_ edit, the evidence for
   `addressText`, `phone` and `website` is `provenance.<field>`
   (`planContactWrite` + `validateEvidence` + the transport guard). Every other
   #440 rule stands — required name/geom, references for the other facts,
   code-claim settlement, identity, duplicates, idempotency, rate limit,
   one-commit create.
2. **Disjoint key sets.** POST `sourceReferences` = `name`, `geom`,
   `description`, `areaKey`, `city`, `district`, `provinceCode`, `communeCode`,
   `taxonomyIds`; PATCH `sourceReferences` = `provinceCode`, `communeCode`;
   `provenance` = the three contacts. A `sourceReferences` key for a contact is
   `400 SOURCE_REFERENCE_INVALID`, `code: unknown`, message naming
   `provenance.<field>` — no alias, no fallback, not even when both carry the
   same text.
3. **Create rule** (`planContactWrite(input, null)`): non-null without entry →
   `provenance.<field>` `required`; entry without value → `value_missing`;
   `null` with entry → `not_allowed`; `null` alone writes nothing. Any non-empty
   `googleDerivedFields` → `GOOGLE_CONTENT_NOT_PERSISTABLE` (#440's rule; the
   earlier #280 `addressText`-only check is withdrawn as redundant).
4. **Edit rule** unchanged from this ADR; `expectedUpdatedAt` is re-checked
   under #440's existing `FOR UPDATE` read (no second lock). Contact columns are
   left out of generic key-presence `editorial` stamping.
5. **Storage.** The same `place_field_provenance` rows. Contact rows carry the
   client source type (never `google_derived`), reference, `collected_at`,
   actor and `verified_at` = now; #440's other rows keep `collected_at` NULL.
   The CMS read model returns `collectedAt` on every row (null outside the
   contacts) and `ownership` on the three.
6. **Audit / events.** #440's in-transaction create audit gains
   `contact: { written: [{field, sourceType}], cleared }`; `claimedFields`
   excludes the three. The edit audit and the `place.updated` outbox on a real
   contact write are this ADR's.
7. **Compatibility.** Breaking versus alpha.62–65 for POST:
   `sourceReferences.<contact>` is refused and a contact value now needs
   `provenance`. Released as alpha.66 with a coordinated GoGo-CMS rollout.
   No backfill: a contact row written under alpha.62–65 (reference, no
   `collected_at`) reads `ownership: unknown` until re-verified.

## Consequences

- Places created after this change carry no address unless someone supplies
  one with evidence. That is the intended trade: an empty field is honest, a
  Google string presented as GoGo's is not.
- Writes are tighter: the console and sheets must send evidence and, for edits,
  the form version. GoGo-CMS needs evidence inputs on the place editor, the
  import wizard and the submission review form before editors can write these
  fields again. Coordinated rollout; CODEOWNER approval (OpenAPI + migration).
- Evidence can still be asserted falsely; it remains an editorial-review matter.
- Legacy data clean-up and wider Google-content remediation are separate work.
- **Amends** ADR-0006 §3 (address no longer provider-owned) and §9.3's
  "Formatted address — needs decision" row (decided: not persisted from Google),
  and ADR-0016's field-provenance section (contact fields now need evidence;
  typing alone confers nothing). ADR-0020's attributed provider facts
  (rating, review count, hours, Maps URI) are unchanged and do not authorize
  contact/address persistence.

## Migration & rollback

`migrations/0070_place-field-provenance-collected-at.sql` adds one nullable
column with no default — a catalog-only change, no rewrite, short lock — guarded
on the table existing. Rollback is application-only: the previous release
neither reads nor writes `collected_at`, so the column and the evidence in it
are retained. Rehearsal-only down: `ALTER TABLE place_field_provenance DROP
COLUMN collected_at;`.

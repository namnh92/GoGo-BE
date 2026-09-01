# Place bulk import (CMS)

Backend for `GOGO_PLACE_INGESTION_SPEC.md` §4, §9, §10 — tasks PI-BE-011..017.
Shares the resolver, dedup and provider-snapshot code with Mobile add-by-link:
one pipeline, two entry points.

## Pipeline

```
upload / sheet → parse → map columns → validate → [dry-run stops here]
              → start → worker chunks (50 rows) → resolve → dedup
              → review (confirm candidate / merge / skip) → publish → reindex
```

Dry-run never calls the provider — validation is a pure function of the row,
so it costs nothing and repeats identically on retry.

## Sources and limits

| Source        | Accepted                          | Notes                                                           |
| ------------- | --------------------------------- | --------------------------------------------------------------- |
| CSV           | UTF-8, `,` `;` or tab             | BOM stripped; invalid UTF-8 is rejected, not mangled            |
| XLSX          | real workbook, any number of tabs | macros (`xl/vbaProject.bin`) rejected; nothing is ever executed |
| Google Sheets | `docs.google.com` link or bare id | bounded range read; the URL itself is never fetched             |

Caps (`INGEST_LIMITS`): 20 MB/file, 5.000 data rows/job, 64 columns,
2.000 chars/cell, 200 MB total archive expansion, 200× per-entry ratio.

The format is decided by the **leading bytes**, not the extension or the
multipart mimetype — both are attacker-controlled. A `.xlsx` name over CSV
bytes fails with `FILE_TYPE_MISMATCH`.

## Column mapping

Resolution order per header: explicit wizard mapping → canonical template name
→ legacy GOGO sheet header (`Tên địa điểm`, `Khoảng giá/người`, `Đi cùng ai?`,
…). Unmapped headers are reported in `unmappedHeaders`, never guessed.

The canonical vocabulary is `CANONICAL_FIELDS` in `domain/column-mapping.ts` —
one list, published to clients as the OpenAPI enum `ImportCanonicalField`. The
YAML is handwritten, so `import-parsing.spec.ts` fails the build if the two
drift; a published vocabulary the parser does not implement is how the CMS came
to offer `address`, `phone` and `website`, which nothing could ever accept.

**An explicit mapping is honoured or the request is refused.** `resolveMapping`
used to skip any value it did not recognise and quietly fall through to
auto-detection, so a client sending its own vocabulary (`googleMapsUrl` for
`google_maps_url`) got a clean 201 in which its mapping screen had done nothing
at all. `parseColumnMapping` validates at the edge instead. Auto-detection is
for headers the caller said nothing about; mapping a header to `""` means
ignore it. Malformed JSON on the multipart route stays a separate
`MAPPING_INVALID` — a typo and a wrong vocabulary are different mistakes.

The request property stays `additionalProperties: { type: string }`. Narrowing
an existing `/v1` request to an enum is a breaking change under ADR-0005, and
the `contract-compat` gate is right to refuse it; the vocabulary is published
as `ImportCanonicalField` for clients to generate from, and enforced at
runtime.

### `/v1` mapping compatibility

Rejecting an unknown mapping is itself a behavioural change that oasdiff cannot
see: `/v1` answered 200 and ignored the value. So the shipped vocabulary was
audited rather than guessed — `MAPPABLE_FIELDS` and `HEADER_HINTS` in GoGo-CMS
are byte-identical across every commit that has ever held them (`3efb5bd`,
`fa951e6`, `e33cfc6`, `origin/develop`), and between them emit exactly eleven
values. No other client sends `mapping`.

| Shipped value                                  | Treatment                                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `city`, `district`, `category`, `note` | already canonical                                                                                                                   |
| `googleMapsUrl`, `priceMin`, `priceMax`        | normalised via `LEGACY_FIELD_ALIASES`; behave exactly like the canonical field, counted as `place_import_legacy_mapping_total`      |
| `address`, `phone`, `website`                  | `RETIRED_FIELDS`: still accepted, column skipped, header reported in `unmappedHeaders` so the outcome is visible rather than silent |
| anything else                                  | 400 `MAPPING_FIELD_UNKNOWN`, naming every offending column in `field_errors`                                                        |

The last row is the only behavioural delta, and it is unreachable by any
shipped client: GoGo-CMS `master` carries no application code, and the repo has
no tags or releases, so nothing has ever emitted a value outside those eleven.
What it catches is a typo or a future client's invented vocabulary — precisely
the case where silence hides the mistake.

Legacy aliases are compatibility only: never offered as a choice, never added
to. Whether GoGo should hold address/phone/website at all is a catalog
question, tracked separately.

Free text becomes structured facts: `45 - 75k` → `{min: 45000, max: 75000,
unit: per_person}`, `Cặp đôi|Bạn bè` → `['couple','group']`. A tab named
`HCM`/`HN` supplies the city via `tabCityMapping`.

Unknown taxonomy keys are a **validation error** (`CATEGORY_UNKNOWN`) or a
warning (`CATEGORY_UNMAPPED`). Import never creates taxonomy.

Headers the parser could not place are returned in `unmappedHeaders`; required
canonical fields no header covers are returned in `missingRequiredColumns`.
Both are `tabName:value` strings, both are **persisted on the job**, and both
come back from `GET …/{jobId}` — not just the create response. They used to be
create-only, which meant the CMS rendered them into a job detail that had never
been sent them, and an editor never found out that `tags` and `notes` had been
dropped from their sheet.

`missingRequiredColumns` holds only what an operator must go and add. A
requirement the job satisfies by itself is left out: `source_row_id`, which is
always derivable from row position on a grid source, and `city` whenever
`defaultCity` or `tabCityMapping` supplies one. What remains genuinely blocks —
the wizard is meant to stop on this list, so padding it teaches editors to skim
past the one list that matters. The cost of a derived `source_row_id` is
reported per row instead, as `ROW_ID_DERIVED`.

## What Google supplies, and what the sheet must

ADR-0006 §2 defines three field-mask tiers. Until #286 the adapter sent one flat
mask that matched none of them: it carried the `quality` aggregates while
omitting `types`, `googleMapsUri` and `photos`, all three of which the ADR puts
in `core`. `place_provider_sources.fetch_tier` recorded `'quality'` for every
row regardless, and `provider_uri` — a column present since the first ingestion
migration — was never written, because nothing ever asked Google for the URI.

The masks now live in `PLACE_FIELD_MASKS` (`libs/providers/src/google-places.adapter.ts`),
one tier built from the one below it, with a test asserting each exact string.
The field mask is the cost decision, so a containment check is not enough —
that is precisely what let the drift survive.

`details(id, tier)` defaults to `quality`. Every current caller resolves a place
in order to keep it, so asking for `core` first would mean two billed calls for
one row. No caller requests `core` alone today; the tier exists, is tested, and
is what `fetch_tier` now records.

### Category comes from `types[]`

A row that names a place Google can find no longer has to carry a category.
`domain/google-types.ts` holds **one** table mapping Google place types to two
views: a GoGo category key (only where the mapping is honest) and a coarse
family (always, for identity-change). It replaces two tables that pointed in
opposite directions and did not agree — `TYPE_FAMILY` in `identity-change.ts`
and `TYPE_TO_CATEGORY` in `match-score.ts`.

Precedence, in order:

1. An explicit valid `category` from the sheet. Never overwritten — taxonomy is
   GoGo-owned (ADR-0006 §3), and an editor who files a place under `bar` that
   Google calls `restaurant` is usually right about why members go there.
2. `primaryType`, when it maps. Google's own answer to "mainly what".
3. The lowest-ranked category among `types[]`, under the **GoGo Category
   Selection Policy v1**. **Rank, not array order** — Google publishes no
   ranking, precedence or ordering promise over `types[]`, so position would
   make the same place import as `cafe` today and `restaurant` after a
   provider-side reshuffle.

   The rank is `lodging > museum > cinema > bar > cafe > park > shopping >
restaurant`, defined as `CATEGORY_RANK` in `google-types.ts`. It is GoGo's
   own editorial judgement — specific types beat the generic parents (`food`,
   `restaurant`, `store`) Google hangs off almost everything — **not** anything
   Google asserts. Changing it changes what published places are filed under,
   so it carries a version and is a product decision, not a tuning knob.

4. Nothing. The row fails with `CATEGORY_REQUIRED`, naming the Google type it
   saw, and an editor supplies one.

A type GoGo has no honest category for stays unmapped. `tourist_attraction` is
the case that matters: Bến Thành market, the War Remnants Museum and a rooftop
bar are all tourist attractions, and mapping it to `park` would put a wrong
category on a published place to save an operator one column.

Row messages: `CATEGORY_PENDING_PROVIDER` (warning, at parse — deferred),
`CATEGORY_DERIVED` (warning, after resolve — names the source type),
`CATEGORY_REQUIRED` (error — either nothing to resolve from, or Google could
not classify it).

### The sheet a human should be filling in

Everything Google owns comes from the link. The columns worth an operator's time
are the ones GoGo owns:

| Column                                   | Who owns it                                       |
| ---------------------------------------- | ------------------------------------------------- |
| `google_maps_url`                        | the anchor — ADR-0006 §8 requires one per place   |
| `category`                               | optional override; leave blank and Google decides |
| `highlight`                              | GoGo                                              |
| `price_min` / `price_max` / `price_unit` | GoGo (verified price, not `priceLevel`)           |
| `audiences`                              | GoGo                                              |
| `vibes`                                  | GoGo                                              |
| `note`                                   | GoGo                                              |

`category` stays in the canonical vocabulary: a row with no resolvable link
still needs it, and an override is still legitimate. `name`, `city` and
`district` remain accepted — they are match hints for a row whose link has to be
resolved by text search, not data GoGo keeps.

### Photos are references, not images

`core` now includes `photos`, and they arrive as `ProviderPhotoRef` — an opaque
provider handle, the original dimensions, and the author attributions the
licence requires to be rendered with the image. **Nothing stores them.** Turning
a reference into bytes is a second, separately billed Google call, and GoGo has
no provider-image storage: `place_photos` does not exist, and `ImportCandidate`
has no `photoUrl` in the OpenAPI spec (the GoGo-CMS zod mirror declares one that
the server has never populated). Materialization needs its own decision about
storage, cost and cache lifetime. It is not smuggled in here.

## Row identity: `source_row_id` and its fallback

Rows are keyed `(job_id, source_row_id)`. A sheet with no such column used to
fail **every** row on `ROW_ID_MISSING`, even though the service went on to
derive `Tab#12` from the row's position and store that. Requiring a human to
hand-author unique ids in a Google Sheet was the design error, not the sheets
that lacked them — so the derived id is now applied **before** validation and
reported as a `ROW_ID_DERIVED` warning.

**A derived id is positional, and position is not identity.** `Tab#12` names
whatever row sits twelfth today. Insert a row above it and the same place
imports under a different id while `Tab#12` points at its neighbour. The case
this breaks is re-importing an edited sheet: `(job_id, source_row_id)` no
longer lines up with the previous job, so `update_existing` re-resolves rows it
had already matched, and the sheet's edits land on the wrong place. A sheet
meant to be re-synced needs a real `source_row_id` column; the warning on every
row says so.

Intended precedence, once the stronger sources are wired (#274):

```
explicit source_row_id  >  Google Place ID  >  normalized Maps URL identity  >  sheet/row fallback
```

Only the first and last exist today. The middle two are available on rows that
carry a `google_maps_url` — a `place_id` URL parameter is already extracted by
`parseMapsUrl`, and it is stable across reorder in a way position never is.
Moving a row up the list is a strict improvement and needs no migration: the
fallback stays as the floor for rows that have nothing better.

## Mode `update_existing`

Re-sync một sheet đã sửa lên place đã tồn tại. Trước khi có mode này, sửa giá trong sheet rồi import lại **không có tác dụng gì**: dòng khớp provider id, thành `duplicate`, dừng.

Quyền sở hữu field theo ADR-0006 §8:

| Nhóm                                                       | Ai thắng                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| name, địa chỉ, geo, rating, review count, price level, giờ | **Google** — place có thể đã đổi tên/dời chỗ/mở lại                                 |
| giá VND, highlight, note                                   | **Sheet**                                                                           |
| category, vibes, audiences                                 | Sheet, **chỉ khi ô không rỗng** — ô rỗng nghĩa là "không biết", không phải "xoá đi" |

### Trước khi ghi bất cứ thứ gì: có phải vẫn là business cũ không?

Cùng một `google_place_id` không đảm bảo cùng một quán. Nếu đổi chủ, lấy tên mới trong khi giữ nguyên highlight, giá GoGo curate và category cũ sẽ tạo ra **một record nói dối** — và review, saved place, plan stop đang trỏ vào dòng đó sẽ âm thầm đi theo.

Nên `update_existing` chạy composite check trước; **bất kỳ** tín hiệu nào bật thì dòng vào `needs_confirmation`, **không ghi gì cả**, người quyết:

| Tín hiệu                      | Vì sao                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| `RATING_COUNT_RESET`          | Google reset review cho business mới. Tín hiệu **mạnh nhất** ta có |
| `PRIMARY_TYPE_CHANGED`        | Nhà hàng thành karaoke — tên không bắt được                        |
| `BUSINESS_CLOSED_PERMANENTLY` | Rõ ràng                                                            |
| `NAME_UNRECOGNISABLE`         | similarity < 0.3                                                   |

**Tên một mình là cổng sai** — đo trên ca thật: `Highlands Coffee Nguyễn Huệ → The Coffee House Nguyễn Huệ` (đổi chủ) được **0.60**, còn `Cà Phê Sài Gòn → Saigon Coffee House` (cùng chủ) được **0.00**. Token địa chỉ và loại hình thổi phồng điểm đúng chỗ cần cảnh báo.

Không có tín hiệu nào **auto-reject**. Tín hiệu nghĩa là "người quyết", không bao giờ nghĩa là "bỏ đi".

## Job statuses

`uploaded → validating → review_required → processing → completed |
partial_success | failed`, plus `cancelled` and `paused_provider_quota`.

Row statuses: `pending → resolving → ready | needs_confirmation | duplicate |
unresolved | failed`, then `imported` after publish. `validation_failed` rows
never reach the provider.

## Idempotency and restartability

- Job key: `sha256(file bytes) + mode`. Re-uploading identical bytes returns
  the existing job with `reused: true` instead of re-billing the provider.
- Row key: `(job_id, source_row_id)` — unique. A retried chunk updates rows, it
  cannot duplicate them or create a second canonical place.
- Chunks claim rows with `UPDATE … FOR UPDATE SKIP LOCKED`, so two workers
  never process the same row.
- **Quota**: `ProviderQuotaExceededError` parks the job at
  `paused_provider_quota` and returns the claimed rows to `pending`. No row is
  marked invalid, no data is discarded. `POST …/start` resumes it.
- **Cancel** stops unprocessed chunks only. Rows already imported stay.

## Who can do what

| Action                                                       | Role                  |
| ------------------------------------------------------------ | --------------------- |
| create / start / cancel / retry / review rows / error report | `editor`, `ops_admin` |
| publish (create catalog places)                              | `ops_admin` only      |

`super_admin` passes everywhere. Every mutation writes an `audit_logs` row
against the job id. RBAC is enforced at the API — hiding a CMS button is not
authorization.

## Error report

`GET /v1/cms/place-imports/{jobId}/error-report` returns UTF-8 CSV (with BOM,
so Excel opens Vietnamese correctly). Cells starting with `=`, `+`, `-`, `@`,
tab or CR are prefixed with an apostrophe: the report is opened by the same
people who uploaded the file, and a row is attacker-influenced text.

## Running it

The API only flips a job to `processing`; **the worker does the work**. It
polls every 5s for started jobs (`gogo-ingest` scheduler) rather than consuming
an enqueue, so a start survives an API restart and no lost message can strand a
job. Heartbeat: `HEARTBEAT_URL_INGEST`.

Without `GOOGLE_PLACES_API_KEY` / `GOOGLE_SHEETS_API_KEY` the fakes are bound
and the whole flow is exercisable locally — resolve returns seeded places only.
Each key covers one API and no other; neither stands in for the other, and boot
logs a warn naming whichever is missing.

## The only import path

`POST /v1/cms/place-imports` replaced the old `POST /v1/cms/import-jobs`, which
took JSON rows and wrote straight to `places` — no provider resolve, no dedup,
no provider snapshot. That endpoint and its `import_jobs` table were removed in
migration `0003`; nothing consumed them (the CMS UI does not exist yet).

Uploads are **not** virus-scanned: operators vet files before uploading, and the
backend parses bytes in-process without ever executing or re-serving them. This
is a recorded decision, not an oversight — see `docs/threat-model.md`.

## Still open

- PI-CMS-001..006 — the CMS wizard UI on top of these APIs.
- PI-SRE-001 — metrics are emitted (spec §13 names, as structured log lines);
  a scrape endpoint and dashboard still need a destination decided (#36/#120).
- Provider photo materialization — references are carried, nothing stores them.
- `phone`, `website`, `editorialSummary` — outside ADR-0006's masks. Whether
  GoGo holds this data at all is #280, and it changes provider spend.
- `scoreMatch`'s category agreement never runs: `toTarget` builds a `MatchTarget`
  without `primaryType`, so the 0.1 category weight has been inert since it
  shipped. Consolidating the type table did not activate it — that changes row
  outcomes and belongs in its own change (#288).

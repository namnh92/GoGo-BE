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

Free text becomes structured facts: `45 - 75k` → `{min: 45000, max: 75000,
unit: per_person}`, `Cặp đôi|Bạn bè` → `['couple','group']`. A tab named
`HCM`/`HN` supplies the city via `tabCityMapping`.

Unknown taxonomy keys are a **validation error** (`CATEGORY_UNKNOWN`) or a
warning (`CATEGORY_UNMAPPED`). Import never creates taxonomy.

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

Without `GOOGLE_MAPS_API_KEY` / `GOOGLE_SHEETS_API_KEY` the fakes are bound and
the whole flow is exercisable locally — resolve returns seeded places only.

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

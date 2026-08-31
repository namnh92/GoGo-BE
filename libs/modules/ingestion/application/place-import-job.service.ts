import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db, type IngestMessage, type MatchCandidate } from '@gogo/database';
import {
  ProviderConfigurationError,
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  SHEETS_PROVIDER,
  SheetAccessError,
  parseSpreadsheetId,
  type ResolvedProviderPlace,
  type SheetsPort,
} from '@gogo/providers';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import {
  applyMapping,
  resolveMapping,
  unusableHeaders,
  type CanonicalField,
  type ColumnMappingResult,
} from '../domain/column-mapping';
import { buildErrorReportCsv } from '../domain/error-report';
import {
  INGEST_LIMITS,
  IngestFileError,
  parseTabularSource,
  type SheetGrid,
} from '../domain/tabular';
import { detectIdentityChange } from '../domain/identity-change';
import { deriveCategory } from '../domain/google-types';
import { validateRow, type NormalizedImportRow } from '../domain/template';
import { PlaceDedupService } from './place-dedup.service';
import { PlaceResolverService } from './place-resolver.service';
import { writeAudit } from '../../shared/audit';

export type ImportMode = 'dry_run' | 'create_drafts' | 'publish_approved' | 'update_existing';

type JobRow = typeof schema.placeIngestJobs.$inferSelect;
type IngestRow = typeof schema.placeIngestRows.$inferSelect;

const ACTIVE_STATUSES = new Set(['uploaded', 'validating', 'processing']);

/**
 * PI-BE-015/016 — bulk import orchestration.
 *
 * Everything here is restartable: rows are keyed by `(job_id, source_row_id)`,
 * chunks claim their rows atomically, and a provider quota error parks the job
 * without discarding a single validated row (spec §9.4).
 */
@Injectable()
export class PlaceImportJobService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly resolver: PlaceResolverService,
    private readonly dedup: PlaceDedupService,
    @Inject(SHEETS_PROVIDER) private readonly sheets: SheetsPort,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  // --- creation ------------------------------------------------------------

  async createFromFile(input: {
    bytes: Buffer;
    fileName: string;
    mode: ImportMode;
    defaultCity?: string | undefined;
    mapping?: ColumnMappingResult | undefined;
    adminId: string;
  }) {
    let grids: SheetGrid[];
    let format: 'csv' | 'xlsx';
    try {
      const parsed = parseTabularSource(input.bytes, input.fileName);
      grids = parsed.grids;
      format = parsed.format;
    } catch (err) {
      if (err instanceof IngestFileError) throw AppError.badRequest(err.code, err.message);
      throw err;
    }

    const checksum = createHash('sha256').update(input.bytes).digest('hex');
    return this.createJob({
      sourceType: format,
      sourceFileName: input.fileName,
      checksum,
      grids,
      mode: input.mode,
      defaultCity: input.defaultCity,
      mapping: input.mapping,
      adminId: input.adminId,
    });
  }

  async createFromSheet(input: {
    spreadsheetUrl: string;
    tabs?: string[] | undefined;
    tabCityMapping?: Record<string, string> | undefined;
    mode: ImportMode;
    defaultCity?: string | undefined;
    mapping?: ColumnMappingResult | undefined;
    adminId: string;
  }) {
    let spreadsheetId: string;
    try {
      spreadsheetId = parseSpreadsheetId(input.spreadsheetUrl);
    } catch (err) {
      throw sheetError(err);
    }

    let grids: SheetGrid[];
    try {
      const available = await this.sheets.listTabs(spreadsheetId);
      const wanted = input.tabs?.length
        ? available.filter((t) => input.tabs!.includes(t.title))
        : available;
      if (wanted.length === 0) {
        throw new SheetAccessError('SHEET_TAB_NOT_FOUND', 'Không tìm thấy tab đã chọn');
      }
      grids = [];
      for (const tab of wanted) {
        const rows = await this.sheets.readTab(spreadsheetId, tab.title, INGEST_LIMITS.maxRows);
        const [headers = [], ...data] = rows;
        grids.push({ name: tab.title, headers: headers.map((h) => h.trim()), rows: data });
      }
    } catch (err) {
      throw sheetError(err);
    }

    // The sheet content is the idempotency anchor — re-running the same wizard
    // on unchanged data reuses the job instead of re-billing the provider.
    const checksum = createHash('sha256')
      .update(JSON.stringify({ spreadsheetId, grids }))
      .digest('hex');

    return this.createJob({
      sourceType: 'google_sheet',
      sourceFileName: spreadsheetId,
      checksum,
      grids,
      mode: input.mode,
      defaultCity: input.defaultCity,
      mapping: input.mapping,
      adminId: input.adminId,
      tabCityMapping: input.tabCityMapping,
    });
  }

  private async createJob(input: {
    sourceType: 'csv' | 'xlsx' | 'google_sheet';
    sourceFileName: string;
    checksum: string;
    grids: SheetGrid[];
    mode: ImportMode;
    defaultCity?: string | undefined;
    mapping?: ColumnMappingResult | undefined;
    adminId: string;
    tabCityMapping?: Record<string, string> | undefined;
  }) {
    const [existing] = await this.db
      .select()
      .from(schema.placeIngestJobs)
      .where(
        and(
          eq(schema.placeIngestJobs.sourceChecksum, input.checksum),
          eq(schema.placeIngestJobs.mode, input.mode),
        ),
      )
      .limit(1);
    if (existing) return { ...(await this.getJob(existing.id)), reused: true };

    const taxonomy = await this.taxonomyKeys();
    const seenRowIds = new Set<string>();
    const prepared: {
      sourceRowId: string;
      rowNumber: number;
      raw: Partial<Record<CanonicalField, string>>;
      normalized: NormalizedImportRow;
      errors: IngestMessage[];
      warnings: IngestMessage[];
    }[] = [];
    const unmappedHeaders = new Set<string>();
    const missingRequiredColumns = new Set<string>();

    // Compatibility spellings the shipped CMS emitted. They behave exactly like
    // the canonical field from here on; the counter is the only way anyone
    // finds out a client still needs updating.
    for (const legacy of input.mapping?.normalizedLegacy ?? []) {
      this.metrics.increment('place_import_legacy_mapping_total', {
        from: legacy.from,
        to: legacy.to,
      });
    }
    // `/v1` accepted an unusable mapping value and carried on, so it still
    // does. The counter is a structured log line (`LogMetrics`), which is the
    // warning: the field is operator-authored config, never sheet content, and
    // it is truncated so a real exporter does not get one series per typo.
    for (const unknown of input.mapping?.unknown ?? []) {
      this.metrics.increment('place_import_unknown_mapping_total', {
        code: 'IMPORT_MAPPING_UNKNOWN',
        field: unknown.value.slice(0, 64),
      });
    }

    const unusable = input.mapping ? unusableHeaders(input.mapping) : undefined;

    let rowNumber = 0;
    for (const grid of input.grids) {
      const { mapping, unmapped, missing } = resolveMapping(
        grid.headers,
        input.mapping?.mapping,
        unusable,
      );
      unmapped.forEach((h) => unmappedHeaders.add(`${grid.name}:${h}`));
      // A column mapped onto a retired field has nowhere to go, so it is
      // skipped like any unmapped column — and reported like one, rather than
      // vanishing the way `/v1` used to let it.
      for (const retired of input.mapping?.retired ?? []) {
        if (grid.headers.some((h) => h.trim() === retired.header)) {
          unmappedHeaders.add(`${grid.name}:${retired.header}`);
        }
      }
      // A tab named HCM/HN is the city fallback for its rows (spec §4.4).
      const tabCity = input.tabCityMapping?.[grid.name] ?? input.defaultCity;
      // This list is what the wizard blocks on, so it holds only columns the
      // operator actually has to go and add. A requirement the job satisfies
      // by itself is not one of them:
      //   - `source_row_id` is always derivable here, because every row in a
      //     grid has a position. The cost of that derivation is per-row and
      //     positional, so it is reported per-row as `ROW_ID_DERIVED` — not
      //     here, where it would read as "this file cannot be imported".
      //   - `city` is covered whenever a default or tab mapping supplies one.
      // Anything left is genuinely blocking; padding it would teach editors to
      // skim past the one list that is meant to stop them.
      missing
        .filter((field) => field !== 'source_row_id' && (field !== 'city' || !tabCity))
        .forEach((field) => missingRequiredColumns.add(`${grid.name}:${field}`));

      for (const cells of grid.rows) {
        rowNumber += 1;
        if (rowNumber > INGEST_LIMITS.maxRows) {
          throw AppError.badRequest('TOO_MANY_ROWS', `More than ${INGEST_LIMITS.maxRows} rows`);
        }
        const raw = applyMapping(grid.headers, cells, mapping);
        if (Object.keys(raw).length === 0) {
          rowNumber -= 1;
          continue; // fully blank line
        }
        const validated = validateRow(raw, {
          defaultCity: tabCity ?? null,
          knownCategoryKeys: taxonomy.category,
          knownVibeKeys: taxonomy.vibe,
          knownAudienceKeys: taxonomy.suitability,
          // Bounded to the 100-char rule (spec §4.3) here rather than in the
          // validator: a tab title may run to 120 chars on its own.
          fallbackRowId: `${grid.name.slice(0, 80)}#${rowNumber}`,
        });

        const errors = [...validated.errors];
        const sourceRowId = validated.normalized.sourceRowId;
        if (seenRowIds.has(sourceRowId)) {
          errors.push({
            code: 'ROW_ID_DUPLICATE',
            field: 'source_row_id',
            message: `source_row_id bị trùng trong job: ${sourceRowId}`,
          });
        }
        seenRowIds.add(sourceRowId);

        prepared.push({
          sourceRowId,
          rowNumber,
          raw,
          normalized: validated.normalized,
          errors,
          warnings: validated.warnings,
        });
      }
    }

    if (prepared.length === 0) {
      throw AppError.badRequest('FILE_EMPTY', 'Không có dòng dữ liệu nào trong file');
    }

    const failedRows = prepared.filter((r) => r.errors.length > 0).length;
    const warningRows = prepared.filter(
      (r) => r.errors.length === 0 && r.warnings.length > 0,
    ).length;

    const job = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.placeIngestJobs)
        .values({
          sourceType: input.sourceType,
          sourceFileName: input.sourceFileName,
          sourceChecksum: input.checksum,
          // Dry-run stops here: validation is the whole deliverable and no
          // provider call has been made yet.
          status: input.mode === 'dry_run' ? 'completed' : 'review_required',
          mode: input.mode,
          defaultCity: input.defaultCity ?? null,
          mapping: input.mapping?.mapping ?? null,
          unmappedHeaders: [...unmappedHeaders],
          missingRequiredColumns: [...missingRequiredColumns],
          totalRows: prepared.length,
          processedRows: input.mode === 'dry_run' ? prepared.length : failedRows,
          failedRows,
          warningRows,
          createdByAdminId: input.adminId,
          ...(input.mode === 'dry_run' ? { completedAt: new Date() } : {}),
        })
        .returning();

      for (let i = 0; i < prepared.length; i += 200) {
        await tx.insert(schema.placeIngestRows).values(
          prepared.slice(i, i + 200).map((r) => ({
            jobId: created!.id,
            sourceRowId: r.sourceRowId,
            rowNumber: r.rowNumber,
            rawInput: r.raw,
            normalizedInput: r.normalized,
            status: r.errors.length > 0 ? ('validation_failed' as const) : ('pending' as const),
            errors: r.errors,
            warnings: r.warnings,
          })),
        );
      }
      return created!;
    });

    this.metrics.increment('place_import_jobs_total', {
      status: job.status,
      source_type: input.sourceType,
    });
    await this.audit(input.adminId, 'place_import.created', job.id, {
      sourceType: input.sourceType,
      mode: input.mode,
      totalRows: prepared.length,
      failedRows,
    });

    // `getJob` reads the diagnostics back off the row it just wrote, so the
    // create response and every later refetch agree by construction.
    return { ...(await this.getJob(job.id)), reused: false };
  }

  // --- reads ---------------------------------------------------------------

  /** Import history (spec §9.2), newest first. */
  async listJobs(options: { limit: number; offset: number }) {
    // limit + 1 so `nextOffset` means "there is more", not "maybe more" —
    // the CMS table should never have to fetch an empty page to find out.
    const page = await this.db
      .select()
      .from(schema.placeIngestJobs)
      .orderBy(desc(schema.placeIngestJobs.createdAt))
      .limit(options.limit + 1)
      .offset(options.offset);
    const rows = page.slice(0, options.limit);
    return {
      items: rows.map((j) => ({
        id: j.id,
        status: j.status,
        mode: j.mode,
        sourceType: j.sourceType,
        sourceFileName: j.sourceFileName,
        totals: {
          rows: j.totalRows,
          processed: j.processedRows,
          success: j.successRows,
          warnings: j.warningRows,
          failed: j.failedRows,
        },
        createdAt: j.createdAt.toISOString(),
        completedAt: j.completedAt?.toISOString(),
      })),
      nextOffset: page.length > options.limit ? options.offset + rows.length : null,
    };
  }

  async getJob(jobId: string) {
    const job = await this.requireJob(jobId);
    const counts = await this.db
      .select({ status: schema.placeIngestRows.status, n: sql<number>`count(*)::int` })
      .from(schema.placeIngestRows)
      .where(eq(schema.placeIngestRows.jobId, jobId))
      .groupBy(schema.placeIngestRows.status);

    return {
      id: job.id,
      status: job.status,
      mode: job.mode,
      sourceType: job.sourceType,
      sourceFileName: job.sourceFileName,
      defaultCity: job.defaultCity,
      totals: {
        rows: job.totalRows,
        processed: job.processedRows,
        success: job.successRows,
        warnings: job.warningRows,
        failed: job.failedRows,
      },
      rowsByStatus: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      // Parse-time diagnostics survive the navigation away from the wizard.
      unmappedHeaders: job.unmappedHeaders,
      missingRequiredColumns: job.missingRequiredColumns,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString(),
      completedAt: job.completedAt?.toISOString(),
      cancelledAt: job.cancelledAt?.toISOString(),
    };
  }

  async listRows(
    jobId: string,
    options: { status?: string | undefined; limit: number; offset: number },
  ) {
    await this.requireJob(jobId);
    const where = options.status
      ? and(
          eq(schema.placeIngestRows.jobId, jobId),
          eq(schema.placeIngestRows.status, options.status as IngestRow['status']),
        )
      : eq(schema.placeIngestRows.jobId, jobId);

    const page = await this.db
      .select()
      .from(schema.placeIngestRows)
      .where(where)
      .orderBy(asc(schema.placeIngestRows.rowNumber))
      .limit(options.limit + 1)
      .offset(options.offset);
    const rows = page.slice(0, options.limit);

    return {
      items: rows.map((r) => ({
        id: r.id,
        rowNumber: r.rowNumber,
        sourceRowId: r.sourceRowId,
        status: r.status,
        normalized: r.normalizedInput,
        resolvedGooglePlaceId: r.resolvedGooglePlaceId,
        matchedPlaceId: r.matchedPlaceId,
        matchConfidence: r.matchConfidence !== null ? Number(r.matchConfidence) : null,
        matchReasons: r.matchReasons,
        // Spec §10.4: the ambiguous-match error carries its candidates.
        candidates: r.candidates,
        errors: r.errors,
        warnings: r.warnings,
      })),
      nextOffset: page.length > options.limit ? options.offset + rows.length : null,
    };
  }

  async errorReportCsv(jobId: string): Promise<string> {
    await this.requireJob(jobId);
    const rows = await this.db
      .select()
      .from(schema.placeIngestRows)
      .where(eq(schema.placeIngestRows.jobId, jobId))
      .orderBy(asc(schema.placeIngestRows.rowNumber));

    return buildErrorReportCsv(
      rows
        .filter((r) => r.errors.length > 0 || r.warnings.length > 0)
        .map((r) => ({
          rowNumber: r.rowNumber,
          sourceRowId: r.sourceRowId,
          status: r.status,
          errors: r.errors,
          warnings: r.warnings,
        })),
    );
  }

  // --- lifecycle -----------------------------------------------------------

  async start(jobId: string, adminId: string) {
    const job = await this.requireJob(jobId);
    if (job.mode === 'dry_run') {
      throw AppError.conflict('DRY_RUN_JOB', 'Dry-run job không chạy import');
    }
    if (job.status === 'processing') return this.getJob(jobId);
    if (!['review_required', 'uploaded', 'paused_provider_quota'].includes(job.status)) {
      throw AppError.conflict('JOB_NOT_STARTABLE', `Job đang ở trạng thái ${job.status}`);
    }
    await this.db
      .update(schema.placeIngestJobs)
      .set({ status: 'processing', startedAt: job.startedAt ?? new Date(), cancelledAt: null })
      .where(eq(schema.placeIngestJobs.id, jobId));
    // No enqueue: the worker polls for `processing` jobs, so a start survives
    // an API restart and a lost message cannot strand a job.
    await this.audit(adminId, 'place_import.started', jobId, { from: job.status });
    return this.getJob(jobId);
  }

  async cancel(jobId: string, adminId: string) {
    const job = await this.requireJob(jobId);
    if (!ACTIVE_STATUSES.has(job.status) && job.status !== 'paused_provider_quota') {
      throw AppError.conflict('JOB_NOT_CANCELLABLE', `Job đang ở trạng thái ${job.status}`);
    }
    // Only unprocessed work stops; rows already imported are left alone.
    await this.db
      .update(schema.placeIngestJobs)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(eq(schema.placeIngestJobs.id, jobId));
    await this.audit(adminId, 'place_import.cancelled', jobId, {});
    return this.getJob(jobId);
  }

  async retry(jobId: string, adminId: string) {
    const job = await this.requireJob(jobId);
    if (job.mode === 'dry_run') {
      throw AppError.conflict('DRY_RUN_JOB', 'Dry-run job không chạy import');
    }
    const reset = await this.db
      .update(schema.placeIngestRows)
      .set({ status: 'pending', errors: [], updatedAt: new Date() })
      .where(
        and(
          eq(schema.placeIngestRows.jobId, jobId),
          inArray(schema.placeIngestRows.status, ['failed', 'unresolved', 'resolving']),
        ),
      )
      .returning({ id: schema.placeIngestRows.id });

    await this.db
      .update(schema.placeIngestJobs)
      .set({ status: 'processing', cancelledAt: null, startedAt: job.startedAt ?? new Date() })
      .where(eq(schema.placeIngestJobs.id, jobId));
    await this.audit(adminId, 'place_import.retried', jobId, { rows: reset.length });
    return { ...(await this.getJob(jobId)), retriedRows: reset.length };
  }

  // --- processing ----------------------------------------------------------

  /**
   * Worker entry point: advances every job an admin has started. One chunk per
   * job per tick keeps a 5.000-row job from starving the others.
   */
  async processPendingJobs(maxJobs = 5): Promise<{ jobId: string; processed: number }[]> {
    const jobs = await this.db
      .select({ id: schema.placeIngestJobs.id })
      .from(schema.placeIngestJobs)
      .where(eq(schema.placeIngestJobs.status, 'processing'))
      .orderBy(asc(schema.placeIngestJobs.startedAt))
      .limit(maxJobs);

    const results: { jobId: string; processed: number }[] = [];
    for (const job of jobs) {
      const chunk = await this.processChunk(job.id);
      if (chunk.processed > 0) results.push({ jobId: job.id, processed: chunk.processed });
    }
    return results;
  }

  /** Runs chunks until the job is done, cancelled or parked. */
  async processJob(
    jobId: string,
    maxChunks = 1000,
  ): Promise<{ processed: number; status: string }> {
    let processed = 0;
    for (let i = 0; i < maxChunks; i++) {
      const chunk = await this.processChunk(jobId);
      processed += chunk.processed;
      if (!chunk.hasMore) break;
    }
    const job = await this.requireJob(jobId);
    return { processed, status: job.status };
  }

  /**
   * One chunk of {@link INGEST_LIMITS.chunkSize} rows. Rows are claimed with a
   * single UPDATE … RETURNING so two workers never process the same row.
   */
  async processChunk(jobId: string): Promise<{ processed: number; hasMore: boolean }> {
    const job = await this.requireJob(jobId);
    if (job.status !== 'processing') return { processed: 0, hasMore: false };

    const claimed = await this.db.execute(sql`
      update place_ingest_rows set status = 'resolving', updated_at = now()
      where id in (
        select id from place_ingest_rows
        where job_id = ${jobId} and status = 'pending'
        order by row_number
        limit ${INGEST_LIMITS.chunkSize}
        for update skip locked
      )
      returning id, source_row_id, row_number, normalized_input
    `);
    const rows = claimed.rows as {
      id: string;
      source_row_id: string;
      row_number: number;
      normalized_input: NormalizedImportRow;
    }[];
    if (rows.length === 0) {
      await this.finalize(jobId);
      return { processed: 0, hasMore: false };
    }

    // One taxonomy read per chunk, not per row: category derivation needs the
    // live key set and a 5.000-row job would otherwise issue 5.000 identical
    // queries to learn the same eight keys.
    const knownCategories = (await this.taxonomyKeys()).category;

    for (const row of rows) {
      try {
        await this.resolveRow(
          row.id,
          row.normalized_input,
          job.mode as ImportMode,
          knownCategories,
        );
      } catch (err) {
        // #279: a provider that could not answer must park the job, not consume
        // rows. Quota already did; a disabled API, an invalid key and an
        // upstream outage now reach here too instead of being swallowed into
        // "unresolved", and every one of them would otherwise burn a whole
        // spreadsheet of good rows on a fault that has nothing to do with them.
        const operational =
          err instanceof ProviderQuotaExceededError ||
          err instanceof ProviderConfigurationError ||
          err instanceof ProviderUnavailableError;
        if (operational) {
          // Park the job: the remaining rows go back to pending untouched so a
          // resume re-processes exactly what was left (spec §9.4).
          await this.db
            .update(schema.placeIngestRows)
            .set({ status: 'pending', updatedAt: new Date() })
            .where(
              and(
                eq(schema.placeIngestRows.jobId, jobId),
                eq(schema.placeIngestRows.status, 'resolving'),
              ),
            );
          await this.db
            .update(schema.placeIngestJobs)
            .set({ status: 'paused_provider_quota' })
            .where(eq(schema.placeIngestJobs.id, jobId));
          this.metrics.increment('place_import_jobs_total', {
            status: 'paused_provider_quota',
            source_type: job.sourceType,
            // The status enum has one paused value and adding another needs a
            // migration, so the distinction rides the metric until GoGo-BE#284
            // renames it: quota clears by waiting, a configuration fault does
            // not, and a runbook has to be able to tell them apart.
            reason:
              err instanceof ProviderQuotaExceededError
                ? 'QUOTA_EXHAUSTED'
                : err instanceof ProviderConfigurationError
                  ? err.faultCode
                  : 'UPSTREAM_UNAVAILABLE',
          });
          return { processed: 0, hasMore: false };
        }
        await this.failRow(row.id, {
          code: 'ROW_PROCESSING_FAILED',
          message: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
    }

    await this.refreshCounters(jobId);
    const after = await this.requireJob(jobId);
    return { processed: rows.length, hasMore: after.status === 'processing' };
  }

  private async resolveRow(
    rowId: string,
    normalized: NormalizedImportRow,
    mode: ImportMode,
    knownCategories?: ReadonlySet<string>,
  ): Promise<void> {
    const hints = {
      name: normalized.name ?? normalized.googleMapsQuery ?? undefined,
      city: normalized.city ?? undefined,
      district: normalized.district ?? undefined,
      categoryKey: normalized.categoryKey ?? undefined,
    };
    const url =
      normalized.googleMapsUrl ??
      `https://www.google.com/maps/place/${encodeURIComponent(
        [hints.name, hints.district, hints.city].filter(Boolean).join(' '),
      )}`;

    const outcome = await this.metrics.time(
      'place_resolve_duration_ms',
      { source: 'cms_import' },
      () => this.resolver.resolveFromUrl(url, hints),
    );
    this.metrics.increment('place_resolve_confidence_bucket', {
      source: 'cms_import',
      bucket: confidenceBucket(
        outcome.status === 'UNRESOLVED'
          ? outcome.decision?.best?.confidence
          : outcome.decision.best?.confidence,
      ),
    });

    if (outcome.status === 'NEEDS_CONFIRMATION') {
      await this.db
        .update(schema.placeIngestRows)
        .set({
          status: 'needs_confirmation',
          matchConfidence: confidenceText(outcome.decision.best?.confidence),
          matchReasons: outcome.decision.reasons,
          candidates: outcome.decision.candidates.map(toCandidate),
          errors: [
            {
              code: 'PLACE_MATCH_AMBIGUOUS',
              field: 'google_maps_url',
              message: 'Tìm thấy nhiều chi nhánh phù hợp',
            },
          ],
          updatedAt: new Date(),
        })
        .where(eq(schema.placeIngestRows.id, rowId));
      this.countRow('needs_confirmation', 'PLACE_MATCH_AMBIGUOUS');
      return;
    }

    if (outcome.status === 'UNRESOLVED') {
      await this.db
        .update(schema.placeIngestRows)
        .set({
          status: 'unresolved',
          matchReasons: outcome.decision?.reasons ?? [outcome.reasonCode],
          candidates: (outcome.decision?.candidates ?? []).map(toCandidate),
          errors: [
            {
              code: `PLACE_${outcome.reasonCode}`,
              field: 'google_maps_url',
              message: 'Không resolve được địa điểm từ dữ liệu dòng này',
            },
          ],
          updatedAt: new Date(),
        })
        .where(eq(schema.placeIngestRows.id, rowId));
      this.countRow('unresolved', `PLACE_${outcome.reasonCode}`);
      return;
    }

    await this.applyResolved(
      rowId,
      outcome.details,
      outcome.decision.reasons,
      outcome.decision.best?.confidence,
      { mode, normalized, knownCategories },
    );
  }

  private async applyResolved(
    rowId: string,
    details: ResolvedProviderPlace,
    reasons: string[],
    confidence: number | undefined,
    context?: {
      mode: ImportMode;
      normalized: NormalizedImportRow;
      knownCategories?: ReadonlySet<string> | undefined;
    },
  ): Promise<void> {
    // Google has answered by the time we get here, so a row that deferred its
    // category can be settled now — before dedup, because `update_existing`
    // and the publish step both read `normalized.categoryKey`.
    const settled = await this.settleCategory(rowId, details, context);
    if (settled === 'BLOCKED') return;
    if (context) context.normalized = settled;

    const verdict = await this.dedup.check(details);
    const base = {
      resolvedGooglePlaceId: details.providerPlaceId,
      matchConfidence: confidenceText(confidence),
      matchReasons: reasons,
      candidates: [] as MatchCandidate[],
      errors: [] as IngestMessage[],
      updatedAt: new Date(),
    };

    if (verdict.kind === 'LINKED_EXISTING') {
      if (context?.mode === 'update_existing') {
        await this.updateExisting(rowId, verdict.placeId, details, context.normalized, base);
        return;
      }
      await this.db
        .update(schema.placeIngestRows)
        .set({ ...base, status: 'duplicate', matchedPlaceId: verdict.placeId })
        .where(eq(schema.placeIngestRows.id, rowId));
      this.countRow('duplicate', 'PLACE_ALREADY_LINKED');
      this.metrics.increment('place_duplicate_candidates_total', { kind: 'provider_id' });
      return;
    }
    if (verdict.kind === 'MERGE_CANDIDATE') {
      await this.db
        .update(schema.placeIngestRows)
        .set({
          ...base,
          status: 'duplicate',
          matchedPlaceId: verdict.placeId,
          errors: [
            {
              code: 'PLACE_DUPLICATE_CANDIDATE',
              field: 'name',
              message: `Trùng khả năng cao (${verdict.distanceM}m, sim ${verdict.similarity.toFixed(2)})`,
            },
          ],
        })
        .where(eq(schema.placeIngestRows.id, rowId));
      this.countRow('duplicate', 'PLACE_DUPLICATE_CANDIDATE');
      this.metrics.increment('place_duplicate_candidates_total', { kind: 'name_distance' });
      return;
    }

    await this.db
      .update(schema.placeIngestRows)
      .set({ ...base, status: 'ready' })
      .where(eq(schema.placeIngestRows.id, rowId));
    this.countRow('ready');
  }

  /**
   * PI-BE-023 — settle the category once the provider has described the place.
   *
   * A row reaches here having either carried a category from the sheet, or
   * having deferred it (`CATEGORY_PENDING_PROVIDER`). An operator's explicit,
   * valid category is never overwritten: ADR-0006 §3 puts taxonomy on GoGo's
   * side of the ownership line, and an editor who typed `bar` for a place
   * Google files under `restaurant` is usually right about what GoGo members
   * will go there for.
   *
   * Returns `'BLOCKED'` when the category could not be settled at all — Google
   * described the place in terms GoGo has no category for, and the sheet said
   * nothing. That is the same `CATEGORY_REQUIRED` the operator would have seen
   * at parse time, raised at the first moment it is actually true.
   */
  private async settleCategory(
    rowId: string,
    details: ResolvedProviderPlace,
    context?: {
      normalized: NormalizedImportRow;
      knownCategories?: ReadonlySet<string> | undefined;
    },
  ): Promise<NormalizedImportRow | 'BLOCKED'> {
    let normalized = context?.normalized;
    if (!normalized) {
      const [row] = await this.db
        .select({ normalizedInput: schema.placeIngestRows.normalizedInput })
        .from(schema.placeIngestRows)
        .where(eq(schema.placeIngestRows.id, rowId))
        .limit(1);
      normalized = (row?.normalizedInput ?? {}) as NormalizedImportRow;
    }
    if (normalized.categoryKey) return normalized;

    const derived = deriveCategory(details);
    const known = context?.knownCategories ?? (await this.taxonomyKeys()).category;
    // The table proposes; the catalog disposes. A key the taxonomy does not
    // hold is not usable, however confident the mapping was.
    const usable = derived && known.has(derived.key) ? derived : null;

    if (usable) {
      const settledRow: NormalizedImportRow = { ...normalized, categoryKey: usable.key };
      await this.db
        .update(schema.placeIngestRows)
        .set({
          normalizedInput: settledRow,
          warnings: sql`${schema.placeIngestRows.warnings} || ${JSON.stringify([
            {
              code: 'CATEGORY_DERIVED',
              field: 'category',
              message: `category suy ra từ Google: ${usable.key} (${usable.source} = ${usable.fromType})`,
            },
          ])}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(schema.placeIngestRows.id, rowId));
      this.metrics.increment('place_import_category_derived_total', {
        source: usable.source,
        category: usable.key,
      });
      return settledRow;
    }

    // A free-text category is already flagged `CATEGORY_UNMAPPED` for an editor
    // to resolve, and has been publishable without a taxonomy link since the
    // first import shipped. Not this change's argument to have.
    if (normalized.categoryRaw) return normalized;

    // Name what Google actually said. "category là bắt buộc" on a row the
    // operator deliberately left blank reads as a bug in the importer.
    const saw = details.primaryType ?? details.types[0] ?? 'không rõ';
    await this.db
      .update(schema.placeIngestRows)
      .set({
        status: 'validation_failed',
        errors: [
          {
            code: 'CATEGORY_REQUIRED',
            field: 'category',
            message: `Không suy ra được category từ Google (${saw}). Điền cột category cho dòng này.`,
          },
        ],
        updatedAt: new Date(),
      })
      .where(eq(schema.placeIngestRows.id, rowId));
    this.countRow('validation_failed', 'CATEGORY_REQUIRED');
    this.metrics.increment('place_import_category_underivable_total', { google_type: saw });
    return 'BLOCKED';
  }

  private countRow(status: string, errorCode?: string): void {
    this.metrics.increment('place_import_rows_total', { status, error_code: errorCode });
  }

  /**
   * BE-IMP-004 — `update_existing`: re-sync a corrected sheet onto a place that
   * already exists. Without this mode, fixing a price in the sheet and
   * re-importing did nothing: the row matched by provider id, was marked
   * `duplicate`, and stopped.
   *
   * Field ownership follows ADR-0006 §8 — provider facts refresh from Google
   * (the place may have been renamed, moved or reopened since), editorial
   * fields come from the sheet, and an empty sheet cell means "unknown", never
   * "delete this".
   *
   * Before any of that: if the provider place looks like a *different business*
   * now, nothing is written. Taking the new name while keeping the old
   * highlight, price and category produces a record that lies — and the reviews
   * and saved places pointing at that row would silently follow. A human
   * decides; the importer does not.
   */
  private async updateExisting(
    rowId: string,
    placeId: string,
    details: ResolvedProviderPlace,
    normalized: NormalizedImportRow,
    base: Record<string, unknown>,
  ): Promise<void> {
    const [snapshot] = await this.db
      .select({
        name: schema.places.name,
        ratingCount: schema.placeProviderSources.ratingCount,
        primaryType: schema.placeProviderSources.primaryType,
      })
      .from(schema.places)
      .leftJoin(
        schema.placeProviderSources,
        eq(schema.placeProviderSources.placeId, schema.places.id),
      )
      .where(eq(schema.places.id, placeId))
      .limit(1);

    const verdict = detectIdentityChange(
      {
        name: snapshot?.name ?? details.name,
        ratingCount: snapshot?.ratingCount ?? null,
        primaryType: snapshot?.primaryType ?? null,
      },
      {
        name: details.name,
        ratingCount: details.ratingCount,
        primaryType: details.primaryType,
        businessStatus: details.businessStatus,
      },
    );

    if (verdict.changed) {
      await this.db
        .update(schema.placeIngestRows)
        .set({
          ...base,
          status: 'needs_confirmation',
          matchedPlaceId: placeId,
          matchReasons: verdict.reasons,
          errors: [
            {
              code: 'PLACE_IDENTITY_CHANGED',
              field: 'name',
              message: `Có thể đã đổi chủ/đổi loại hình (${verdict.reasons.join(', ')})`,
            },
          ],
        })
        .where(eq(schema.placeIngestRows.id, rowId));
      this.countRow('needs_confirmation', 'PLACE_IDENTITY_CHANGED');
      this.metrics.increment('place_identity_change_total', {
        reason: verdict.reasons[0] ?? 'unknown',
      });
      return;
    }

    const score = await this.resolver.scoreFor(details, null, normalized.categoryKey);
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.places)
        .set({
          // Provider owns these — the place may have been renamed or moved.
          name: details.name,
          addressText: details.addressText,
          geom: { x: details.lng, y: details.lat },
          rating: details.rating !== null ? details.rating.toFixed(2) : null,
          ratingCount: details.ratingCount,
          priceLevel: details.priceLevel,
          freshnessCheckedAt: new Date(),
          // Sheet owns this one; an empty cell leaves what is already there.
          ...(normalized.highlight ? { description: normalized.highlight } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.places.id, placeId));

      const unit = dbPriceUnit(normalized.priceUnit);
      if (normalized.priceMin !== null && normalized.priceMax !== null && unit) {
        await tx.insert(schema.placePrices).values({
          placeId,
          priceMin: normalized.priceMin,
          priceMax: normalized.priceMax,
          currency: 'VND',
          unit,
          confidence: '0.50',
          source: 'editor',
        });
      }
    });

    await this.dedup.upsertProviderSource({
      placeId,
      details,
      derivedScore: score,
      fetchTier: details.fetchTier,
    });
    await this.dedup.emitReindex(placeId, 'updated');

    await this.db
      .update(schema.placeIngestRows)
      .set({ ...base, status: 'imported', matchedPlaceId: placeId })
      .where(eq(schema.placeIngestRows.id, rowId));
    this.countRow('imported');
  }

  private async failRow(rowId: string, message: IngestMessage): Promise<void> {
    this.countRow('failed', message.code);
    await this.db
      .update(schema.placeIngestRows)
      .set({ status: 'failed', errors: [message], updatedAt: new Date() })
      .where(eq(schema.placeIngestRows.id, rowId));
  }

  // --- row decisions -------------------------------------------------------

  async confirmCandidate(jobId: string, rowId: string, googlePlaceId: string, adminId: string) {
    const row = await this.requireRow(jobId, rowId);
    const allowed = row.candidates.some((c) => c.googlePlaceId === googlePlaceId);
    if (!allowed) {
      // Only ids the resolver actually surfaced — never an arbitrary provider
      // id typed into the request.
      throw AppError.badRequest('CANDIDATE_NOT_LISTED', 'Candidate không thuộc dòng này');
    }
    const outcome = await this.resolver.resolveFromUrl(
      `https://www.google.com/maps?place_id=${googlePlaceId}`,
    );
    if (outcome.status !== 'RESOLVED') {
      throw AppError.conflict('PROVIDER_UNAVAILABLE', 'Không xác minh được địa điểm lúc này');
    }
    await this.applyResolved(rowId, outcome.details, ['ADMIN_CONFIRMED'], 1);
    await this.audit(adminId, 'place_import.candidate_confirmed', jobId, { rowId, googlePlaceId });
    await this.refreshCounters(jobId);
    return this.rowView(rowId);
  }

  async mergeRow(jobId: string, rowId: string, placeId: string, adminId: string) {
    const row = await this.requireRow(jobId, rowId);
    if (!row.resolvedGooglePlaceId) {
      throw AppError.conflict('ROW_NOT_RESOLVED', 'Dòng chưa resolve được provider place');
    }
    const [place] = await this.db
      .select({ id: schema.places.id })
      .from(schema.places)
      .where(eq(schema.places.id, placeId))
      .limit(1);
    if (!place) throw AppError.notFound('PLACE_NOT_FOUND', 'Place không tồn tại');

    const outcome = await this.resolver.resolveFromUrl(
      `https://www.google.com/maps?place_id=${row.resolvedGooglePlaceId}`,
    );
    if (outcome.status === 'RESOLVED') {
      const score = await this.resolver.scoreFor(
        outcome.details,
        null,
        normalizedOf(row).categoryKey ?? null,
      );
      await this.dedup.upsertProviderSource({
        placeId,
        details: outcome.details,
        derivedScore: score,
        fetchTier: outcome.details.fetchTier,
      });
    }
    await this.db
      .update(schema.placeIngestRows)
      .set({ status: 'imported', matchedPlaceId: placeId, updatedAt: new Date() })
      .where(eq(schema.placeIngestRows.id, rowId));
    await this.dedup.emitReindex(placeId, 'merged');
    await this.audit(adminId, 'place_import.row_merged', jobId, { rowId, placeId });
    await this.refreshCounters(jobId);
    return this.rowView(rowId);
  }

  async skipRow(jobId: string, rowId: string, adminId: string) {
    await this.requireRow(jobId, rowId);
    await this.db
      .update(schema.placeIngestRows)
      .set({
        status: 'failed',
        errors: [{ code: 'ROW_SKIPPED', message: 'Bỏ qua bởi admin' }],
        updatedAt: new Date(),
      })
      .where(eq(schema.placeIngestRows.id, rowId));
    await this.audit(adminId, 'place_import.row_skipped', jobId, { rowId });
    await this.refreshCounters(jobId);
    return this.rowView(rowId);
  }

  // --- publish -------------------------------------------------------------

  /**
   * Creates canonical places from `ready` rows. `create_drafts` leaves them in
   * `draft`; `publish_approved` publishes — which the controller restricts to
   * roles allowed to publish (spec §9.3).
   */
  async publish(jobId: string, adminId: string, rowIds?: string[]) {
    const job = await this.requireJob(jobId);
    if (job.mode === 'dry_run') {
      throw AppError.conflict('DRY_RUN_JOB', 'Dry-run job không tạo place');
    }
    const where = rowIds?.length
      ? and(
          eq(schema.placeIngestRows.jobId, jobId),
          eq(schema.placeIngestRows.status, 'ready'),
          inArray(schema.placeIngestRows.id, rowIds),
        )
      : and(eq(schema.placeIngestRows.jobId, jobId), eq(schema.placeIngestRows.status, 'ready'));

    const rows = await this.db.select().from(schema.placeIngestRows).where(where);
    const created: string[] = [];
    const failed: { rowId: string; code: string }[] = [];

    for (const row of rows) {
      try {
        const placeId = await this.createPlaceFromRow(row, job.mode as ImportMode);
        created.push(placeId);
      } catch (err) {
        failed.push({
          rowId: row.id,
          code: err instanceof AppError ? err.code : 'PLACE_CREATE_FAILED',
        });
        await this.failRow(row.id, {
          code: 'PLACE_CREATE_FAILED',
          message: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
    }

    await this.audit(adminId, 'place_import.published', jobId, {
      created: created.length,
      failed: failed.length,
    });
    await this.refreshCounters(jobId);
    return { created: created.length, failed, jobId };
  }

  private async createPlaceFromRow(row: IngestRow, mode: ImportMode): Promise<string> {
    if (!row.resolvedGooglePlaceId) {
      throw AppError.conflict('ROW_NOT_RESOLVED', 'Dòng chưa resolve được provider place');
    }
    const outcome = await this.resolver.resolveFromUrl(
      `https://www.google.com/maps?place_id=${row.resolvedGooglePlaceId}`,
    );
    if (outcome.status !== 'RESOLVED') {
      throw AppError.conflict('PROVIDER_UNAVAILABLE', 'Không xác minh được địa điểm lúc này');
    }
    const details = outcome.details;
    const normalized = normalizedOf(row);
    const score = await this.resolver.scoreFor(details, null, normalized.categoryKey ?? null);
    const status = mode === 'publish_approved' ? 'published' : 'draft';

    const placeId = await this.db.transaction(async (tx) => {
      const [place] = await tx
        .insert(schema.places)
        .values({
          // Editorial name from the sheet wins; provider name is the fallback.
          name: normalized.name ?? details.name,
          nameNormalized: 'set-by-trigger',
          description: normalized.highlight ?? null,
          status,
          geom: { x: details.lng, y: details.lat },
          addressText: details.addressText,
          rating: details.rating !== null ? details.rating.toFixed(2) : null,
          ratingCount: details.ratingCount,
          priceLevel: details.priceLevel,
          confidence: '0.70',
          freshnessCheckedAt: new Date(),
        })
        .returning();

      for (const h of details.hours) {
        await tx.insert(schema.placeHours).values({
          placeId: place!.id,
          dayOfWeek: h.dayOfWeek,
          openMinute: h.openMinute,
          closeMinute: h.closeMinute,
          isOvernight: h.isOvernight,
          source: 'provider',
          verifiedAt: new Date(),
        });
      }

      const unit = dbPriceUnit(normalized.priceUnit);
      if (normalized.priceMin !== null && normalized.priceMax !== null && unit) {
        await tx.insert(schema.placePrices).values({
          placeId: place!.id,
          priceMin: normalized.priceMin,
          priceMax: normalized.priceMax,
          currency: 'VND',
          unit,
          confidence: '0.50',
          source: 'editor',
        });
      }

      const keys = [
        ...(normalized.categoryKey ? [{ kind: 'category', key: normalized.categoryKey }] : []),
        ...normalized.vibes.map((key) => ({ kind: 'mood', key })),
        ...normalized.audiences.map((key) => ({ kind: 'suitability', key })),
      ];
      for (const { kind, key } of keys) {
        const [tax] = await tx
          .select({ id: schema.taxonomies.id })
          .from(schema.taxonomies)
          .where(
            and(eq(schema.taxonomies.kind, kind as 'category'), eq(schema.taxonomies.key, key)),
          )
          .limit(1);
        // Missing taxonomy is skipped, never created (spec §4.3).
        if (tax) {
          await tx
            .insert(schema.placeTaxonomies)
            .values({ placeId: place!.id, taxonomyId: tax.id })
            .onConflictDoNothing();
        }
      }
      return place!.id;
    });

    await this.dedup.upsertProviderSource({
      placeId,
      details,
      derivedScore: score,
      fetchTier: details.fetchTier,
    });
    await this.db
      .update(schema.placeIngestRows)
      .set({ status: 'imported', matchedPlaceId: placeId, updatedAt: new Date() })
      .where(eq(schema.placeIngestRows.id, row.id));
    if (status === 'published') await this.dedup.emitReindex(placeId, 'published');
    return placeId;
  }

  // --- helpers -------------------------------------------------------------

  private async refreshCounters(jobId: string): Promise<void> {
    await this.db.execute(sql`
      update place_ingest_jobs j set
        processed_rows = c.processed,
        success_rows = c.success,
        failed_rows = c.failed,
        warning_rows = c.warned
      from (
        select
          count(*) filter (where status not in ('pending','resolving'))::int as processed,
          count(*) filter (where status in ('ready','imported'))::int as success,
          count(*) filter (where status in ('validation_failed','failed'))::int as failed,
          count(*) filter (where jsonb_array_length(warnings) > 0)::int as warned
        from place_ingest_rows where job_id = ${jobId}
      ) c
      where j.id = ${jobId}
    `);
    await this.finalize(jobId);
  }

  /** Moves a processing job to its terminal state once no rows are pending. */
  private async finalize(jobId: string): Promise<void> {
    const job = await this.requireJob(jobId);
    if (job.status !== 'processing') return;
    const [pending] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.placeIngestRows)
      .where(
        and(
          eq(schema.placeIngestRows.jobId, jobId),
          inArray(schema.placeIngestRows.status, ['pending', 'resolving']),
        ),
      );
    if ((pending?.n ?? 0) > 0) return;

    const [counts] = await this.db
      .select({
        ok: sql<number>`count(*) filter (where status in ('ready','imported','duplicate','needs_confirmation'))::int`,
        bad: sql<number>`count(*) filter (where status in ('validation_failed','failed','unresolved'))::int`,
      })
      .from(schema.placeIngestRows)
      .where(eq(schema.placeIngestRows.jobId, jobId));

    const status =
      (counts?.ok ?? 0) === 0 ? 'failed' : (counts?.bad ?? 0) > 0 ? 'partial_success' : 'completed';
    await this.db
      .update(schema.placeIngestJobs)
      .set({ status, completedAt: new Date() })
      .where(eq(schema.placeIngestJobs.id, jobId));
    this.metrics.increment('place_import_jobs_total', { status, source_type: job.sourceType });
  }

  private async taxonomyKeys(): Promise<{
    category: Set<string>;
    vibe: Set<string>;
    suitability: Set<string>;
  }> {
    const rows = await this.db
      .select({ kind: schema.taxonomies.kind, key: schema.taxonomies.key })
      .from(schema.taxonomies)
      .where(eq(schema.taxonomies.isActive, true));
    const pick = (kind: string) => new Set(rows.filter((r) => r.kind === kind).map((r) => r.key));
    // Vibe keys live under the `mood` taxonomy kind.
    return { category: pick('category'), vibe: pick('mood'), suitability: pick('suitability') };
  }

  private async requireJob(jobId: string): Promise<JobRow> {
    const [job] = await this.db
      .select()
      .from(schema.placeIngestJobs)
      .where(eq(schema.placeIngestJobs.id, jobId))
      .limit(1);
    if (!job) throw AppError.notFound('IMPORT_JOB_NOT_FOUND', 'Import job không tồn tại');
    return job;
  }

  private async requireRow(jobId: string, rowId: string): Promise<IngestRow> {
    const [row] = await this.db
      .select()
      .from(schema.placeIngestRows)
      .where(and(eq(schema.placeIngestRows.jobId, jobId), eq(schema.placeIngestRows.id, rowId)))
      .limit(1);
    if (!row) throw AppError.notFound('IMPORT_ROW_NOT_FOUND', 'Dòng import không tồn tại');
    return row;
  }

  private async rowView(rowId: string) {
    const [row] = await this.db
      .select()
      .from(schema.placeIngestRows)
      .where(eq(schema.placeIngestRows.id, rowId))
      .limit(1);
    return {
      id: row!.id,
      status: row!.status,
      resolvedGooglePlaceId: row!.resolvedGooglePlaceId,
      matchedPlaceId: row!.matchedPlaceId,
      matchConfidence: row!.matchConfidence !== null ? Number(row!.matchConfidence) : null,
      errors: row!.errors,
      warnings: row!.warnings,
    };
  }

  private async audit(
    adminId: string,
    action: string,
    resourceId: string,
    diff: unknown,
  ): Promise<void> {
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action,
      resourceType: 'place_ingest_job',
      resourceId,
      diff,
    });
  }
}

function toCandidate(c: {
  target: { googlePlaceId: string; name: string; address: string; lat: number; lng: number };
  confidence: number;
}): MatchCandidate {
  return {
    googlePlaceId: c.target.googlePlaceId,
    name: c.target.name,
    address: c.target.address,
    confidence: c.confidence,
    lat: c.target.lat,
    lng: c.target.lng,
  };
}

/** Confidence histogram is coarse on purpose — ops read the shape, not the digits. */
function confidenceBucket(value: number | undefined): string {
  if (value === undefined) return 'none';
  if (value >= 0.9) return '0.9-1.0';
  if (value >= 0.7) return '0.7-0.9';
  if (value >= 0.5) return '0.5-0.7';
  return '0-0.5';
}

/** `normalized_input` is stored as jsonb; the writer is the only shape source. */
function normalizedOf(row: IngestRow): NormalizedImportRow {
  return (row.normalizedInput ?? {}) as NormalizedImportRow;
}

function confidenceText(value: number | undefined): string | null {
  return value === undefined ? null : value.toFixed(3);
}

/** The catalog only prices per person or per item; anything else needs an editor. */
function dbPriceUnit(unit: NormalizedImportRow['priceUnit']): 'per_person' | 'per_item' | null {
  if (unit === 'per_item') return 'per_item';
  if (unit === 'per_person' || unit === 'free') return 'per_person';
  return null;
}

function sheetError(err: unknown): AppError {
  if (err instanceof SheetAccessError) {
    // PI-BE-021: a missing credential is not a bad request. Nothing the caller
    // sends can succeed, so 4xx is both the wrong status and the wrong advice —
    // and it hides an outage inside a metric that counts user mistakes.
    // retryable=false: this one never clears on its own.
    if (err.code === 'SHEET_PROVIDER_NOT_CONFIGURED') {
      // PI-BE-022: cause carries the provider's reason into the 5xx log and
      // Sentry, where an operator can tell SERVICE_DISABLED from a revoked key.
      // It never reaches the envelope — the filter builds that from code and
      // message alone, and the reason's siblings in Google's body name our
      // project.
      return new AppError(err.code, err.message, 503, { retryable: false, cause: err });
    }
    return err.code === 'SHEET_PERMISSION_DENIED'
      ? AppError.forbidden(err.code, err.message)
      : AppError.badRequest(err.code, err.message);
  }
  if (err instanceof ProviderQuotaExceededError) {
    return AppError.tooManyRequests('Google Sheets quota exhausted');
  }
  return AppError.badRequest('SHEET_UNAVAILABLE', 'Không đọc được Google Sheet');
}

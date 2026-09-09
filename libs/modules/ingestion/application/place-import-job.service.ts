import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { schema, type Db, type IngestMessage, type MatchCandidate } from '@gogo/database';
import {
  ProviderConfigurationError,
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  SHEETS_PROVIDER,
  SheetAccessError,
  parseSpreadsheetId,
  type PlaceDescriptionTier,
  type ResolvedProviderPlace,
  type SheetsPort,
} from '@gogo/providers';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import {
  APP_CONFIG,
  type PlatformConfig,
  type VerificationWindowConfig,
} from '../../shared/config';
import { flagEnvironmentOf, resolveBooleanFlag } from '../../shared/feature-flags';
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
import { detectIdentityChange, type IdentityVerdict } from '../domain/identity-change';
import { deriveCategory } from '../domain/google-types';
import { validateRow, type NormalizedImportRow } from '../domain/template';
import { PlaceDedupService, type KnownProviderPlace } from './place-dedup.service';
import { PlaceResolverService, type ResolveOutcome } from './place-resolver.service';
import { writeAudit } from '../../shared/audit';
import { invalidateTravelOnMove } from '../../shared/place-relocation';
import {
  evaluatePlaceApproval,
  publicationOutcomeFor,
  type PublicationOutcome,
} from '../../administrative/application/place-approval';
import {
  AdministrativeResolverService,
  type PersistResult,
} from '../../administrative/application/administrative-resolver.service';
import {
  activeDataset,
  currentCommunes,
  unitNames,
} from '../../administrative/application/unit-lookup';
import {
  approvalBlock,
  type ActiveCommune,
  type ApprovalBlock,
} from '../../administrative/domain/approval-policy';
import type { MappingStatus } from '../../administrative/domain/mapping-status';

export type ImportMode = 'dry_run' | 'create_drafts' | 'publish_approved' | 'update_existing';

/**
 * Which Details tier a row's *resolve* needs, decided by what the job will do
 * with the answer (#338, plan §2.4).
 *
 * Resolving a row settles four things — which Google place it is, whether the
 * catalogue already holds it, which GoGo category its provider types imply, and
 * how confident the match was. `applyResolved` reads a name, an address, a
 * coordinate, `primaryType`/`types` and nothing else; the row it writes carries
 * an id, a confidence and a status. All Pro fields, so `core` is the honest
 * price of a resolve.
 *
 * `update_existing` is the exception, and it is not an exception about
 * resolving: that mode's whole purpose is to pull fresh provider facts onto a
 * place GoGo already has, so the same object goes on to write `rating`,
 * `ratingCount` and `priceLevel`. Those are Enterprise fields, and a `core`
 * fetch would overwrite a live rating with `null` — a cheaper call that
 * destroys catalogue data is not a saving.
 *
 * Publish is not covered here: it re-fetches at `quality` in
 * `createPlaceFromRow`, deliberately, because that call is what becomes the
 * catalogue row.
 */
function resolveTierFor(mode: ImportMode): PlaceDescriptionTier {
  return mode === 'update_existing' ? 'quality' : 'core';
}

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
    /**
     * ADM-017 — the one path from a coordinate to an administrative identity.
     * The import previews with it and commits with it, which is what makes the
     * two agree; a second classification here would be a second answer.
     */
    private readonly administrative: AdministrativeResolverService,
    @Inject(SHEETS_PROVIDER) private readonly sheets: SheetsPort,
    @Inject(APP_CONFIG) private readonly config: PlatformConfig & VerificationWindowConfig,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  /**
   * Every DB-first answer in this service is an **identity** answer — "this
   * Google ID is already a GoGo place", which ends the row as `duplicate` and
   * creates nothing. None of them decides whether a place is open, so none is
   * held to the short verification window; the window is still passed so the
   * lookup has one meaning everywhere (#337 review).
   */
  private verificationWindow(): { verificationWindowSeconds: number } {
    return { verificationWindowSeconds: this.config.PLACE_RESOLUTION_TTL_S };
  }

  /** #337 — rollback switch for every DB-first shortcut in this service. */
  private async dbFirst(): Promise<boolean> {
    return resolveBooleanFlag(this.db, 'place_dbfirst.enabled', {
      environment: flagEnvironmentOf(this.config.APP_ENV),
    });
  }

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
    // does. This counts how often that happens.
    //
    // #319: the value itself used to ride along as a `field` label, truncated
    // to 64 characters on the theory that truncation made it safe. It does
    // not: truncation caps a label's *length*, never the number of distinct
    // values it can take, and the value is free text an operator typed. One
    // series per typo, kept forever — the same defect #313 fixed for
    // `duration_ms`, in a different costume.
    //
    // Nothing operational is lost. The column that went unmapped is already
    // reported to the operator on the job itself (`unmappedHeaders`, persisted
    // and returned by the API), which is where they act on it. The counter's
    // job is only to answer "is this still happening", and a rate over one
    // series answers it.
    const unknownMappings = input.mapping?.unknown.length ?? 0;
    if (unknownMappings > 0) {
      this.metrics.increment(
        'place_import_unknown_mapping_total',
        { code: 'IMPORT_MAPPING_UNKNOWN' },
        unknownMappings,
      );
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

    /**
     * ADM-009 (#462): what happened to the publication the mode asked for.
     *
     * Kept apart from `rowsByStatus` because they answer different questions.
     * A row can be `imported` and not published, and a result that folded the
     * two together would tell the operator their places are live when they are
     * waiting for a reviewer.
     */
    const publicationRows = await this.db
      .select({
        outcome: schema.placeIngestRows.publicationOutcome,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.placeIngestRows)
      .where(
        and(
          eq(schema.placeIngestRows.jobId, jobId),
          isNotNull(schema.placeIngestRows.publicationOutcome),
        ),
      )
      .groupBy(schema.placeIngestRows.publicationOutcome);
    const byOutcome = Object.fromEntries(publicationRows.map((r) => [r.outcome!, r.n]));
    const publication = {
      /** Rows whose mode asked for publication. */
      requested: publicationRows.reduce((sum, r) => sum + r.n, 0),
      published: byOutcome.published ?? 0,
      mappingUnverified: byOutcome.deferred_mapping_unverified ?? 0,
      mappingInvalid: byOutcome.deferred_mapping_invalid ?? 0,
      noActiveAdministrativeDataset: byOutcome.deferred_no_active_dataset ?? 0,
      deferred:
        (byOutcome.deferred_mapping_unverified ?? 0) +
        (byOutcome.deferred_mapping_invalid ?? 0) +
        (byOutcome.deferred_no_active_dataset ?? 0),
    };

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
      publication,
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
    const administrative = await this.administrativeViews(rows);

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
        // ADM-017 — which commune this row lands in, and whether a person has
        // to look at it. Absent until the row has been resolved against the
        // provider, because until then there is no point to classify.
        administrative: administrative.get(r.id) ?? null,
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

    /**
     * PI-BE-024 — a row that carries both a link and an id is asserting they
     * name the same place, and the assertion is checked rather than assumed.
     *
     * The first cut compared `identifyUrl`'s id with the column and let the row
     * through whenever the parse produced none. That is most real links:
     * Google's own share URLs are `/maps/place/<name>/data=!3m1!4b1!4m6…`, and
     * the id inside that blob is not a Places API Place ID. So the check passed
     * by finding nothing, which is not agreement — it is the absence of a
     * second opinion, and the row went on to be filed under whichever id the
     * column happened to hold.
     */
    if (normalized.googlePlaceId && normalized.googleMapsUrl) {
      const verdict = await this.checkDeclaredIdentity(
        normalized.googleMapsUrl,
        normalized.googlePlaceId,
        hints,
        mode,
      );
      if (verdict.kind === 'MISMATCH') {
        await this.failIdentity(rowId, 'PLACE_ID_URL_MISMATCH', {
          field: 'google_place_id',
          message:
            `Link và Place ID trỏ tới hai địa điểm khác nhau: ` +
            `link → ${verdict.fromUrl}, cột → ${normalized.googlePlaceId}`,
        });
        return;
      }
      if (verdict.kind === 'UNVERIFIABLE') {
        await this.failIdentity(rowId, 'PLACE_ID_URL_UNVERIFIABLE', {
          field: 'google_maps_url',
          message:
            `Không xác định được link này trỏ tới địa điểm nào (${verdict.reasonCode}), ` +
            `nên không thể đối chiếu với google_place_id. Bỏ một trong hai cột đi.`,
        });
        return;
      }
      if (verdict.kind === 'AGREED_BY_RESOLUTION') {
        /**
         * Establishing agreement already cost the Details call, and it was made
         * at this mode's tier for exactly this id. Fetching again to "use the
         * supplied id" would buy the same answer twice.
         */
        await this.applyResolvedOutcome(rowId, verdict.outcome, mode, normalized, knownCategories);
        return;
      }
      // AGREED_LOCALLY: the URL named the id outright and nothing was spent.
    }

    const resolved = await this.metrics.time(
      'place_resolve_duration_seconds',
      { source: 'cms_import' },
      () => this.identifyThenResolve(url, hints, mode, normalized.googlePlaceId),
    );

    // DB-first hit: the sheet named a Google id the catalogue already holds, so
    // the row's outcome — `duplicate`, pointing at that place — was decided
    // without a Details call (#337, plan §4 scenario E).
    //
    // The category derivation `applyResolved` would have run is skipped with
    // it, on purpose: it exists to fill in a category for a place about to be
    // created, and a duplicate row creates none. Buying a category from Google
    // for a row that will never use it is the exact spend this PR removes.
    if (resolved.kind === 'DB_FIRST') {
      this.metrics.increment('place_dbfirst_hit_total', { path: 'ingest' });
      this.metrics.increment('place_resolve_confidence_bucket', {
        source: 'cms_import',
        bucket: confidenceBucket(1),
      });
      await this.db
        .update(schema.placeIngestRows)
        .set({
          resolvedGooglePlaceId: resolved.place.googlePlaceId,
          matchConfidence: confidenceText(1),
          matchReasons: ['EXACT_PROVIDER_ID', 'DB_FIRST'],
          candidates: [],
          errors: [],
          updatedAt: new Date(),
          status: 'duplicate',
          matchedPlaceId: resolved.place.placeId,
        })
        .where(eq(schema.placeIngestRows.id, rowId));
      this.countRow('duplicate', 'PLACE_ALREADY_LINKED');
      this.metrics.increment('place_duplicate_candidates_total', { kind: 'provider_id' });
      return;
    }
    if (resolved.kind === 'DB_FIRST_CONFLICT') {
      await this.markIdentityConflict(rowId, resolved.placeIds.length, {
        resolvedGooglePlaceId: resolved.googlePlaceId,
        matchConfidence: confidenceText(1),
        matchReasons: ['EXACT_PROVIDER_ID', 'DB_FIRST'],
        candidates: [] as MatchCandidate[],
        errors: [] as IngestMessage[],
        updatedAt: new Date(),
      });
      return;
    }

    await this.applyResolvedOutcome(rowId, resolved.outcome, mode, normalized, knownCategories);
  }

  /**
   * Everything that happens once a provider outcome exists, wherever it came
   * from.
   *
   * Two callers now reach it: the ordinary resolve, and the identity check that
   * had to resolve a link in order to compare it with a declared Place ID. The
   * second must not re-fetch what the first already bought, and it must not
   * grow a second, slightly different copy of these four branches.
   */
  private async applyResolvedOutcome(
    rowId: string,
    outcome: ResolveOutcome,
    mode: ImportMode,
    normalized: NormalizedImportRow,
    knownCategories?: ReadonlySet<string>,
  ): Promise<void> {
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

  /**
   * PI-BE-024 — does the link name the same place the `google_place_id` column
   * does?
   *
   * Four answers, and the third is the one the first cut got wrong.
   *
   *   1. The URL carries an explicit Places id (`place_id`, `placeid` or
   *      `query_place_id`) — compare the two strings and spend nothing.
   *   2. A short link expands to such a URL — the redirect walk is SSRF-guarded
   *      and costs one hop, then case 1 applies.
   *   3. The URL carries no Places id at all. This is most real links: Google's
   *      Share button produces `/maps/place/<name>/data=!3m1!4b1!4m6…`, and the
   *      hex feature id inside that blob is not a Places API Place ID. There is
   *      nothing to compare, so the link is resolved through the ordinary
   *      provider path and the id that comes back is compared instead.
   *   4. Resolution cannot settle what the link names — ambiguous branches, or
   *      nothing found. Then the row fails. Finding no second id is not
   *      agreement; it is the absence of a second opinion, and treating it as
   *      agreement is how a place gets filed under an id nobody checked.
   */
  private async checkDeclaredIdentity(
    url: string,
    declaredPlaceId: string,
    hints: Parameters<PlaceResolverService['resolveIdentified']>[2],
    mode: ImportMode,
  ): Promise<
    | { kind: 'AGREED_LOCALLY' }
    | { kind: 'AGREED_BY_RESOLUTION'; outcome: ResolveOutcome }
    | { kind: 'MISMATCH'; fromUrl: string }
    | { kind: 'UNVERIFIABLE'; reasonCode: string }
  > {
    const identified = await this.resolver.identifyUrl(url);
    if (!identified.ok) return { kind: 'UNVERIFIABLE', reasonCode: identified.reasonCode };

    const fromUrl = identified.value.providerPlaceId;
    if (fromUrl) {
      return fromUrl === declaredPlaceId
        ? { kind: 'AGREED_LOCALLY' }
        : { kind: 'MISMATCH', fromUrl };
    }

    const outcome = await this.resolver.resolveIdentified(
      identified.value,
      resolveTierFor(mode),
      hints,
    );
    if (outcome.status === 'RESOLVED') {
      return outcome.details.providerPlaceId === declaredPlaceId
        ? { kind: 'AGREED_BY_RESOLUTION', outcome }
        : { kind: 'MISMATCH', fromUrl: outcome.details.providerPlaceId };
    }
    return {
      kind: 'UNVERIFIABLE',
      reasonCode: outcome.status === 'UNRESOLVED' ? outcome.reasonCode : 'NEEDS_CONFIRMATION',
    };
  }

  /** One shape for both ways a declared identity can fail the row. */
  private async failIdentity(
    rowId: string,
    code: string,
    detail: { field: string; message: string },
  ): Promise<void> {
    await this.db
      .update(schema.placeIngestRows)
      .set({
        status: 'validation_failed',
        errors: [{ code, field: detail.field, message: detail.message }],
        updatedAt: new Date(),
      })
      .where(eq(schema.placeIngestRows.id, rowId));
    this.countRow('validation_failed', code);
  }

  /**
   * URL → id → catalogue → (only if still needed) Google.
   *
   * The order is the whole of #337 item 3: the Google Place ID is the dedup
   * key, the sheet often carries it outright, and asking Google to describe a
   * place we already catalogued — so that a moment later we can mark the row
   * `duplicate` — was an Enterprise `details` spent on a decision already made.
   */
  private async identifyThenResolve(
    url: string,
    hints: Parameters<PlaceResolverService['resolveIdentified']>[2],
    mode: ImportMode,
    /** PI-BE-024 — the id the sheet named outright, when it named one. */
    declaredPlaceId?: string | null,
  ): Promise<
    | { kind: 'DB_FIRST'; place: KnownProviderPlace }
    | { kind: 'DB_FIRST_CONFLICT'; googlePlaceId: string; placeIds: string[] }
    | { kind: 'RESOLVED'; outcome: ResolveOutcome }
  > {
    /**
     * PI-BE-024 — a declared Place ID skips URL parsing entirely.
     *
     * It is already the answer the parse exists to produce, and it is already
     * the dedup key. Wrapping it in a `google.com/maps?place_id=…` string so
     * that `parseMapsUrl` could unwrap it again was the workaround the audit
     * found operators being asked to perform; the code was doing the same
     * thing to itself.
     *
     * The catalogue is still asked first, and `resolveByProviderId` is still
     * the only thing that spends a Details call.
     */
    if (declaredPlaceId) {
      if (mode !== 'update_existing' && (await this.dbFirst())) {
        const known = await this.dedup.knownProviderPlace(
          declaredPlaceId,
          this.verificationWindow(),
        );
        if (known.kind === 'CONFLICT') {
          return {
            kind: 'DB_FIRST_CONFLICT',
            googlePlaceId: declaredPlaceId,
            placeIds: known.placeIds,
          };
        }
        if (known.kind === 'KNOWN') return { kind: 'DB_FIRST', place: known.place };
        this.metrics.increment('place_dbfirst_miss_total', { reason: known.reason });
      }
      return {
        kind: 'RESOLVED',
        outcome: await this.resolver.resolveByProviderId(declaredPlaceId, resolveTierFor(mode)),
      };
    }

    const identified = await this.resolver.identifyUrl(url);
    if (!identified.ok) {
      return {
        kind: 'RESOLVED',
        outcome: { status: 'UNRESOLVED', reasonCode: identified.reasonCode },
      };
    }

    const knownId = identified.value.providerPlaceId;
    // `update_existing` is the one mode that must not take the shortcut: it
    // exists to pull fresh provider facts onto a place we already have, so
    // answering it from that same place would make the mode do nothing.
    if (knownId && mode !== 'update_existing' && (await this.dbFirst())) {
      const known = await this.dedup.knownProviderPlace(knownId, this.verificationWindow());
      if (known.kind === 'CONFLICT') {
        return { kind: 'DB_FIRST_CONFLICT', googlePlaceId: knownId, placeIds: known.placeIds };
      }
      if (known.kind === 'KNOWN') return { kind: 'DB_FIRST', place: known.place };
      this.metrics.increment('place_dbfirst_miss_total', { reason: known.reason });
    }

    return {
      kind: 'RESOLVED',
      outcome: await this.resolver.resolveIdentified(identified.value, resolveTierFor(mode), hints),
    };
  }

  /**
   * #339 / ADR-0006 §8 — take a place out of circulation and tell an editor why.
   *
   * The audit row is the diff. `place_ingest_rows` records the finding for the
   * job, but a job is a transient artifact and the editor who eventually opens
   * the place has no reason to go looking through one; `audit_logs` is keyed by
   * the place and is where the CMS already shows a place's history. It carries
   * the before/after that triggered the verdict so the decision can be made
   * without re-fetching anything from Google.
   *
   * `actorType: 'system'` because nothing human decided this. The importer
   * noticed; a person still has to rule.
   */
  private async markPlaceForReview(
    placeId: string,
    previousName: string | null,
    details: ResolvedProviderPlace,
    verdict: IdentityVerdict,
  ): Promise<void> {
    const moved = await this.db
      .update(schema.places)
      .set({ status: 'review', updatedAt: sql`now()` })
      .where(and(eq(schema.places.id, placeId), eq(schema.places.status, 'published')))
      .returning({ id: schema.places.id });
    // Nothing to record when the place was not published: it was already out
    // of circulation, and an audit line saying "moved to review" about a place
    // that never left draft would be false.
    if (moved.length === 0) return;
    await writeAudit(this.db, {
      actorType: 'system',
      action: 'place.identity_review_required',
      resourceType: 'place',
      resourceId: placeId,
      diff: {
        reasons: verdict.reasons,
        nameSimilarity: verdict.nameSimilarity,
        name: { before: previousName, after: details.name },
        primaryType: { after: details.primaryType },
        businessStatus: { after: details.businessStatus },
      },
    });
  }

  /**
   * #334 — not `duplicate`: that status asserts which place this row is a
   * duplicate *of*, and that is the one thing nobody has decided yet.
   */
  private async markIdentityConflict(
    rowId: string,
    placeCount: number,
    base: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .update(schema.placeIngestRows)
      .set({
        ...base,
        status: 'needs_confirmation',
        errors: [
          {
            code: 'PLACE_IDENTITY_CONFLICT',
            field: 'google_maps_url',
            message: `Google Place ID này đang trỏ tới ${placeCount} place GoGo; cần gộp trước`,
          },
        ],
      })
      .where(eq(schema.placeIngestRows.id, rowId));
    this.countRow('needs_confirmation', 'PLACE_IDENTITY_CONFLICT');
    this.metrics.increment('place_identity_conflict_blocked_total', { path: 'ingest' });
  }

  /**
   * ADM-017 — the administrative preview for one resolved row.
   *
   * The same resolver, the same evidence order and the same adjudication the
   * commit will run; only the subject differs, because at this point there is
   * no place to name. That is the whole reason `resolveGeometry` exists: a
   * preview computed by a second, simpler rule is a preview that will
   * eventually disagree with what the import actually stores.
   *
   * The sheet's `city` and `district` cells are **not** passed. They are not
   * resolver inputs any more (ADR-0019 §7b) — `city` is the string an operator
   * wrote to help Google find the place, and treating a search hint as a claim
   * about which province the place is in is exactly how a wrong answer gets a
   * confident `AUTO_MATCHED`.
   *
   * Best-effort by design. A deployment with no published dataset still has to
   * be able to run an import — the rows land `UNMAPPED`, which already blocks
   * publication — so an absent dataset leaves the columns null rather than
   * failing the row.
   */
  private async administrativePreview(details: ResolvedProviderPlace): Promise<{
    administrativeProvinceCode: string | null;
    administrativeCommuneCode: string | null;
    administrativeMappingStatus: MappingStatus | null;
    administrativeDatasetVersion: string | null;
  }> {
    const empty = {
      administrativeProvinceCode: null,
      administrativeCommuneCode: null,
      administrativeMappingStatus: null,
      administrativeDatasetVersion: null,
    };
    if (!(await activeDataset(this.db))) return empty;

    const resolution = await this.administrative.resolveGeometry({
      // No place exists yet, so the row is what this answer is about.
      subjectId: details.providerPlaceId,
      geometry: { lng: details.lng, lat: details.lat },
    });
    return {
      administrativeProvinceCode: resolution.provinceCode,
      administrativeCommuneCode: resolution.communeCode,
      administrativeMappingStatus: resolution.status,
      administrativeDatasetVersion:
        resolution.status === 'UNMAPPED' ? null : resolution.datasetVersion,
    };
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

    this.dedup.reportIdMismatch(details, 'ingest');
    const verdict = await this.dedup.check(details);
    const base = {
      resolvedGooglePlaceId: details.providerPlaceId,
      matchConfidence: confidenceText(confidence),
      matchReasons: reasons,
      candidates: [] as MatchCandidate[],
      errors: [] as IngestMessage[],
      updatedAt: new Date(),
      // ADM-017 — which commune this row lands in, answered now rather than at
      // publish time. The review screen is the last point where an operator can
      // still act on it, and it was the one screen that could not see it.
      ...(await this.administrativePreview(details)),
    };

    if (verdict.kind === 'IDENTITY_CONFLICT') {
      await this.markIdentityConflict(rowId, verdict.placeIds.length, base);
      return;
    }
    if (verdict.kind === 'LINKED_EXISTING') {
      if (context?.mode === 'update_existing') {
        await this.updateExisting(rowId, verdict.placeId, details, context.normalized, base);
        return;
      }
      // ADM-009 (#462): a `publish_approved` row that matched an existing place
      // is still a duplicate — the import creates nothing — but the operator
      // did ask for it to be live. An existing place whose mapping a reviewer
      // already verified, and which is still valid against the active dataset,
      // is the one case a bulk row can legitimately publish. Decided by the
      // shared invariant inside its own transaction, never by the mode.
      const duplicatePublication =
        context?.mode === 'publish_approved' ? await this.settlePublication(verdict.placeId) : null;
      if (duplicatePublication === 'published') {
        await this.dedup.emitReindex(verdict.placeId, 'published');
      }
      await this.db
        .update(schema.placeIngestRows)
        .set({
          ...base,
          status: 'duplicate',
          matchedPlaceId: verdict.placeId,
          ...(duplicatePublication ? { publicationOutcome: duplicatePublication } : {}),
        })
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
      // #339 — ADR-0006 §8 says an identity change routes the *place* to
      // review, not just the import row that noticed it. Holding the finding on
      // the row alone left the suspect place published: it kept being searched,
      // suggested and planned onto someone's evening while a job artifact
      // nobody opens carried the only record that it might now be a different
      // business. Search reads `places.status`, so this is what takes it out of
      // circulation until an editor decides.
      //
      // Draft and community-submitted places are left alone: they are not
      // being served, and moving them would lose the state moderation is
      // already tracking them in.
      await this.markPlaceForReview(placeId, snapshot?.name ?? null, details, verdict);
      this.countRow('needs_confirmation', 'PLACE_IDENTITY_CHANGED');
      this.metrics.increment('place_identity_change_total', {
        reason: verdict.reasons[0] ?? 'unknown',
      });
      return;
    }

    const score = await this.resolver.scoreFor(details, null, normalized.categoryKey);
    await this.db.transaction(async (tx) => {
      // #339 — before the new coordinate lands, not after: the measurement is
      // against the stored position, and once it is overwritten the move
      // cannot be seen. "The place may have been renamed or moved" was already
      // written on the line below; nothing acted on the second half of it.
      const move = await invalidateTravelOnMove(tx, placeId, {
        lat: details.lat,
        lng: details.lng,
      });
      if (move?.invalidated) {
        this.metrics.increment('place_relocation_invalidated_total', { source: 'cms_import' });
      }
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
    const job = await this.requireJob(jobId);
    // Confirming a branch the catalogue already holds is a `duplicate` row, and
    // that verdict comes from the id alone (#337). `update_existing` still
    // fetches: refreshing the place from Google is the mode's entire purpose.
    if (job.mode !== 'update_existing' && (await this.dbFirst())) {
      const known = await this.dedup.knownProviderPlace(googlePlaceId, this.verificationWindow());
      if (known.kind === 'CONFLICT') {
        await this.markIdentityConflict(rowId, known.placeIds.length, {
          resolvedGooglePlaceId: googlePlaceId,
          matchConfidence: confidenceText(1),
          matchReasons: ['ADMIN_CONFIRMED', 'DB_FIRST'],
          candidates: [] as MatchCandidate[],
          errors: [] as IngestMessage[],
          updatedAt: new Date(),
        });
        await this.refreshCounters(jobId);
        return this.rowView(rowId);
      }
      if (known.kind === 'KNOWN') {
        this.metrics.increment('place_dbfirst_hit_total', { path: 'confirm' });
        await this.db
          .update(schema.placeIngestRows)
          .set({
            resolvedGooglePlaceId: known.place.googlePlaceId,
            matchConfidence: confidenceText(1),
            matchReasons: ['ADMIN_CONFIRMED', 'DB_FIRST'],
            candidates: [],
            errors: [],
            updatedAt: new Date(),
            status: 'duplicate',
            matchedPlaceId: known.place.placeId,
          })
          .where(eq(schema.placeIngestRows.id, rowId));
        this.countRow('duplicate', 'PLACE_ALREADY_LINKED');
        this.metrics.increment('place_duplicate_candidates_total', { kind: 'provider_id' });
        await this.audit(adminId, 'place_import.candidate_confirmed', jobId, {
          rowId,
          googlePlaceId,
        });
        await this.refreshCounters(jobId);
        return this.rowView(rowId);
      }
      this.metrics.increment('place_dbfirst_miss_total', { reason: known.reason });
    }

    // `core`, in every mode (#338). `applyResolved` is called below without a
    // `context`, which is what makes that safe rather than lucky: `update_existing`
    // is only reachable through the context branch, so nothing on this path can
    // write a rating, an hour or a price level from this object. It settles an
    // identity and a category, and both are Pro fields.
    const outcome = await this.resolver.resolveByProviderId(googlePlaceId, 'core');
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

    // Merging a row into the place its Google id already points at, with a
    // provider row still inside its freshness window, has nothing to fetch:
    // `upsertProviderSource` would rewrite the same values onto the same row
    // (#337).
    const alreadyLinked = (await this.dbFirst())
      ? await this.dedup.knownProviderPlace(row.resolvedGooglePlaceId, this.verificationWindow())
      : ({ kind: 'MISS', reason: 'absent' } as const);
    if (alreadyLinked.kind === 'KNOWN' && alreadyLinked.place.placeId === placeId) {
      this.metrics.increment('place_dbfirst_hit_total', { path: 'merge' });
      await this.db
        .update(schema.placeIngestRows)
        .set({ status: 'imported', matchedPlaceId: placeId, updatedAt: new Date() })
        .where(eq(schema.placeIngestRows.id, rowId));
      await this.dedup.emitReindex(placeId, 'merged');
      await this.audit(adminId, 'place_import.row_merged', jobId, { rowId, placeId });
      await this.refreshCounters(jobId);
      return this.rowView(rowId);
    }

    // `quality`: a merge that gets past the DB-first shortcut writes the
    // provider row for the place it merges into, and `upsertProviderSource`
    // stores `rating`, `ratingCount`, the score derived from them and
    // `priceLevel` (#338).
    const outcome = await this.resolver.resolveByProviderId(row.resolvedGooglePlaceId, 'quality');
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
    // Publish still re-fetches, deliberately: it writes the catalogue row, and
    // the plan keeps that call until PR8 settles what may be stored (plan §3
    // PR4 item 4). `quality` is the tier that row needs — `rating`,
    // `ratingCount`, `priceLevel` and the weekly hours all come from it (#338).
    const outcome = await this.resolver.resolveByProviderId(row.resolvedGooglePlaceId, 'quality');
    if (outcome.status !== 'RESOLVED') {
      throw AppError.conflict('PROVIDER_UNAVAILABLE', 'Không xác minh được địa điểm lúc này');
    }
    const details = outcome.details;
    // #339 — the third door. Submit and `/v1/places/imports` both refuse a
    // place that has not opened; bulk publish did not, and it is the one door
    // that could not be made safe downstream: a closed place reaches the
    // catalogue and is then hidden by the `source_status` filter, but
    // `FUTURE_OPENING` has no `provider_source_status` to be stored as (see
    // `upsertProviderSource`), so it would land on `unknown` and stay
    // searchable. Refusing it here is what makes the lossy mapping harmless
    // rather than a hole.
    if (details.businessStatus === 'FUTURE_OPENING') {
      throw AppError.conflict('PLACE_NOT_YET_OPEN', 'Địa điểm chưa khai trương');
    }
    const normalized = normalizedOf(row);
    const score = await this.resolver.scoreFor(details, null, normalized.categoryKey ?? null);
    /**
     * ADM-009 (#462): `publish_approved` is a request, not a permission.
     *
     * A place created here has never been verified by anybody, so the approval
     * invariant cannot pass — and the honest outcome is to ingest it into the
     * moderation queue rather than publish it. `review` rather than `draft`
     * because the operator did ask for it to go live: it belongs in front of a
     * reviewer, not in a drawer.
     */
    const wantsPublication = mode === 'publish_approved';
    const status = wantsPublication ? 'review' : 'draft';

    type CommittedMapping = {
      provinceCode: string | null;
      communeCode: string | null;
      status: MappingStatus;
      datasetVersion: string | null;
    };

    const stored = await this.db.transaction(async (tx) => {
      let committedMapping: CommittedMapping | null = null;
      let mappingWrite: PersistResult | null = null;
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
          /**
           * PI-BE-025 — the GoGo-owned values the sheet carried.
           *
           * Written only where the file actually said something: `undefined`
           * leaves the column at its default, which is what an empty cell
           * means. They are normalized at parse time, so what lands here is the
           * same shape the console would have written.
           */
          ...(normalized.phone !== null ? { phone: normalized.phone } : {}),
          ...(normalized.website !== null ? { website: normalized.website } : {}),
          ...(normalized.avgVisitMinutes !== null
            ? { avgVisitMinutes: normalized.avgVisitMinutes }
            : {}),
          ...(normalized.isLodging !== null ? { isLodging: normalized.isLodging } : {}),
          ...(normalized.curatedRank !== null ? { curatedRank: normalized.curatedRank } : {}),
        })
        .returning();

      /**
       * PI-BE-025 — provenance for what the file claimed.
       *
       * The import wrote no provenance row at all before this, so a place
       * created from a sheet had columns with no recorded origin — and a field
       * missing from that map is one the console must describe as unknown
       * rather than default to "GoGo". A value an operator typed into a sheet
       * is their claim, exactly as a value typed into the editor is, so it is
       * recorded `editorial`.
       *
       * `name` is only claimed when the sheet supplied one: a row that let the
       * provider name the place did not author that name.
       */
      const claimed: string[] = [
        ...(normalized.name ? ['name'] : []),
        ...(normalized.highlight ? ['description'] : []),
        ...(normalized.phone !== null ? ['phone'] : []),
        ...(normalized.website !== null ? ['website'] : []),
      ];
      if (claimed.length > 0) {
        await tx.insert(schema.placeFieldProvenance).values(
          claimed.map((field) => ({
            placeId: place!.id,
            field,
            sourceType: 'editorial' as const,
            sourceReference: null,
            actorId: null,
          })),
        );
      }

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

      /**
       * ADM-017 — the mapping is written in the transaction that writes the
       * place, from the geometry that transaction just stored.
       *
       * Not from the preview: the preview classified the coordinate the resolve
       * step saw, and this classifies the one the catalogue actually holds. They
       * are the same coordinate in every ordinary case, which is exactly why
       * comparing them is worth something — a preview that agreed by
       * construction would prove nothing.
       *
       * Nothing about the import authorises publication. `settlePublication`
       * below still asks the shared invariant, and an `AUTO_MATCHED` row is
       * deferred there like any other unverified mapping.
       */
      if (await activeDataset(tx)) {
        const resolution = await this.administrative.resolvePlaceWithin(tx, place!.id);
        mappingWrite = await this.administrative.persistWithin(tx, resolution, {
          actor: { id: null, type: 'system' },
        });
        committedMapping = {
          provinceCode: resolution.provinceCode,
          communeCode: resolution.communeCode,
          status: resolution.status,
          datasetVersion: resolution.status === 'UNMAPPED' ? null : resolution.datasetVersion,
        };
      }
      return { placeId: place!.id, committedMapping, mappingWrite };
    });

    const { placeId, committedMapping } = stored;
    if (stored.mappingWrite) this.administrative.countPersist(stored.mappingWrite);

    await this.dedup.upsertProviderSource({
      placeId,
      details,
      derivedScore: score,
      fetchTier: details.fetchTier,
    });
    // ADM-009: the row records what happened to its publication request, so a
    // result can never call a deferred row published.
    const publication = wantsPublication ? await this.settlePublication(placeId) : null;
    await this.db
      .update(schema.placeIngestRows)
      .set({
        status: 'imported',
        matchedPlaceId: placeId,
        ...(publication ? { publicationOutcome: publication } : {}),
        // The row now reports what was actually stored, not what was predicted.
        // An operator comparing the two is the point; a row that kept showing
        // its prediction after the fact could never be checked against anything.
        ...(committedMapping
          ? {
              administrativeProvinceCode: committedMapping.provinceCode,
              administrativeCommuneCode: committedMapping.communeCode,
              administrativeMappingStatus: committedMapping.status,
              administrativeDatasetVersion: committedMapping.datasetVersion,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.placeIngestRows.id, row.id));
    if (publication === 'published') await this.dedup.emitReindex(placeId, 'published');
    return placeId;
  }

  /**
   * ADM-009 (#462) — publish this place if, and only if, the shared approval
   * invariant permits it.
   *
   * Re-read and decided inside the publishing transaction, against the dataset
   * that is active at that moment: a mapping can be rejected, a reviewer can
   * change their mind and a dataset can publish between a row being resolved
   * and this running. Nothing about the import authorises publication — not the
   * mode, not the operator, not codes supplied in the file.
   *
   * A refusal is not a row failure. The place is ingested and waiting in
   * moderation, which is a successful import of a place that is not yet live.
   */
  private async settlePublication(placeId: string): Promise<PublicationOutcome> {
    return this.db.transaction(async (tx) => {
      const [place] = await tx
        .select()
        .from(schema.places)
        .where(eq(schema.places.id, placeId))
        .limit(1)
        .for('update');
      if (!place) return 'deferred_mapping_unverified';

      const block = await evaluatePlaceApproval(tx, place, this.metrics);
      const outcome = publicationOutcomeFor(block);
      if (outcome !== 'published') {
        this.metrics.increment('place_publication_deferred_total', {
          source: 'cms_import',
          reason: outcome,
        });
      }
      if (outcome === 'published' && place.status !== 'published') {
        await tx
          .update(schema.places)
          .set({ status: 'published', updatedAt: sql`now()` })
          .where(eq(schema.places.id, placeId));
      }
      await writeAudit(tx, {
        actorType: 'system',
        actorId: null,
        action: outcome === 'published' ? 'place.status_changed' : 'place.publication_deferred',
        resourceType: 'place',
        resourceId: placeId,
        diff: {
          source: 'cms_import',
          outcome,
          ...(block ? { block } : {}),
          mapping: {
            status: place.administrativeMappingStatus,
            provinceCode: place.provinceCode,
            communeCode: place.communeCode,
            datasetVersion: place.administrativeDatasetVersion,
          },
        },
      });
      return outcome;
    });
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

  /**
   * ADM-017 — the administrative identity a row carries, for the review screen.
   *
   * Names are resolved in one batched query for the whole page: a job runs to
   * hundreds of rows over a handful of distinct communes, and a lookup per row
   * would turn one table render into hundreds of round trips.
   *
   * Two booleans, and they mean different things. `requiresReview` is about the
   * **mapping**: the resolver could not decide, and a person has to. `blocks`
   * is about **publication**: no import result is a verification, so a row that
   * matched perfectly still cannot go live on that basis — which is the claim
   * an import screen is most tempted to make and must not.
   */
  private async administrativeViews(
    rows: readonly AdministrativeRowColumns[],
  ): Promise<Map<string, AdministrativeRowView>> {
    const views = new Map<string, AdministrativeRowView>();
    const dataset = await activeDataset(this.db);

    /**
     * A row matched to an existing place is **about that place**, so it reports
     * that place's stored mapping rather than a preview of the coordinate.
     *
     * Without this the two halves disagree in the one case that matters: a
     * duplicate row pointing at a place a reviewer already verified would be
     * previewed as `AUTO_MATCHED` and reported as blocked, while
     * `settlePublication` — asking the same policy about the place — published
     * it. The screen would have been describing a row the server no longer was.
     */
    const matchedIds = rows
      .map((r) => r.matchedPlaceId)
      .filter((id): id is string => id !== null && id !== undefined);
    const matched = matchedIds.length
      ? new Map(
          (
            await this.db
              .select({
                id: schema.places.id,
                provinceCode: schema.places.provinceCode,
                communeCode: schema.places.communeCode,
                status: schema.places.administrativeMappingStatus,
                datasetVersion: schema.places.administrativeDatasetVersion,
              })
              .from(schema.places)
              .where(inArray(schema.places.id, [...new Set(matchedIds)]))
          ).map((p) => [p.id, p] as const),
        )
      : new Map<string, never>();

    const effective = (row: AdministrativeRowColumns): AdministrativeRowColumns => {
      const place = row.matchedPlaceId ? matched.get(row.matchedPlaceId) : undefined;
      return place
        ? {
            id: row.id,
            matchedPlaceId: row.matchedPlaceId,
            administrativeProvinceCode: place.provinceCode,
            administrativeCommuneCode: place.communeCode,
            administrativeMappingStatus: place.status,
            administrativeDatasetVersion: place.datasetVersion,
          }
        : row;
    };

    const resolved = rows.map(effective);
    const codes = [
      ...resolved.map((r) => r.administrativeProvinceCode ?? ''),
      ...resolved.map((r) => r.administrativeCommuneCode ?? ''),
    ];
    const names = dataset ? await unitNames(this.db, dataset.id, codes) : new Map<string, string>();
    // The commune as the **active** dataset holds it, which is what the policy
    // asks about: does it still exist, is it still current, is it still under
    // the mapped province. One query for the page, not one per row.
    const communes = dataset
      ? await currentCommunes(
          this.db,
          dataset.id,
          resolved.map((r) => r.administrativeCommuneCode).filter((c): c is string => c !== null),
        )
      : new Map<string, ActiveCommune>();

    for (const row of resolved) {
      const status = row.administrativeMappingStatus;
      views.set(row.id, {
        provinceCode: row.administrativeProvinceCode,
        provinceName: row.administrativeProvinceCode
          ? (names.get(`PROVINCE:${row.administrativeProvinceCode}`) ?? null)
          : null,
        communeCode: row.administrativeCommuneCode,
        communeName: row.administrativeCommuneCode
          ? (names.get(`COMMUNE:${row.administrativeCommuneCode}`) ?? null)
          : null,
        status,
        datasetVersion: row.administrativeDatasetVersion,
        requiresReview: status === 'NEEDS_REVIEW',
        ...blockOf(row, dataset, communes),
      });
    }
    return views;
  }

  private async rowView(rowId: string) {
    const [row] = await this.db
      .select()
      .from(schema.placeIngestRows)
      .where(eq(schema.placeIngestRows.id, rowId))
      .limit(1);
    const administrative = (await this.administrativeViews([row!])).get(row!.id) ?? null;
    return {
      id: row!.id,
      status: row!.status,
      resolvedGooglePlaceId: row!.resolvedGooglePlaceId,
      matchedPlaceId: row!.matchedPlaceId,
      matchConfidence: row!.matchConfidence !== null ? Number(row!.matchConfidence) : null,
      administrative,
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
  // #347 — `c.target` carries lat/lng for scoring; the persisted candidate
  // deliberately does not. See the note on `MatchCandidate`.
  return {
    googlePlaceId: c.target.googlePlaceId,
    name: c.target.name,
    address: c.target.address,
    confidence: c.confidence,
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
/**
 * PI-BE-026 — the import's price unit, in the vocabulary `place_prices` has.
 *
 * `null` still means "nothing to store", but it can no longer be reached with a
 * price beside it: `validateRow` fails a row whose unit is `per_group` or
 * `unknown` while a minimum or maximum is present, so by the time this runs the
 * only `null` left is a row that named no price at all.
 *
 * `free` maps to `per_person` because a free place is free per person; the
 * amount is what says it is free, and `min = max = 0` is what the parser
 * produces for "Miễn phí".
 */
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

/** The stored preview columns `administrativeViews` reads. */
type AdministrativeRowColumns = {
  id: string;
  /** Set when the row is about a place the catalogue already holds. */
  matchedPlaceId?: string | null | undefined;
  administrativeProvinceCode: string | null;
  administrativeCommuneCode: string | null;
  administrativeMappingStatus: MappingStatus | null;
  administrativeDatasetVersion: string | null;
};

/** ADM-017 — what a preview row and a result row both say about the mapping. */
type AdministrativeRowView = {
  provinceCode: string | null;
  provinceName: string | null;
  communeCode: string | null;
  communeName: string | null;
  status: MappingStatus | null;
  datasetVersion: string | null;
  /** The resolver could not decide; a person has to. */
  requiresReview: boolean;
  /**
   * Whether this mapping stops the place being published, **from the shared
   * approval policy** — the same `approvalBlock` the publish transaction runs.
   *
   * It was `status !== null`, which happened to give the right answer for every
   * state an import can currently produce and gave it for the wrong reason: it
   * asserted a property of the import rather than reading the policy. A row
   * matching a place a reviewer had already verified would have been reported
   * as blocked while the server went on to publish it.
   */
  blocksPublication: boolean;
  /** Why, in the policy's own closed vocabulary. Null when nothing blocks. */
  approvalBlock: ApprovalBlock | null;
};

/**
 * The policy, applied to one row's stored mapping.
 *
 * Preview and result run this over the same four columns, so they cannot
 * disagree — and neither can disagree with `settlePublication`, which asks the
 * same `approvalBlock` about the place those columns became.
 */
function blockOf(
  row: AdministrativeRowColumns,
  dataset: { combinedDatasetVersion: string } | null,
  communes: Map<string, ActiveCommune>,
): { blocksPublication: boolean; approvalBlock: ApprovalBlock | null } {
  if (row.administrativeMappingStatus === null) {
    // The row has not resolved yet. There is no mapping to judge, and calling
    // that "blocked" would be reporting a decision nobody has made.
    return { blocksPublication: false, approvalBlock: null };
  }
  if (!dataset) {
    return {
      blocksPublication: true,
      approvalBlock: {
        code: 'ADMINISTRATIVE_DATASET_UNAVAILABLE',
        message:
          'no administrative dataset is published, so no mapping can be validated against one',
      },
    };
  }
  const block = approvalBlock(
    {
      status: row.administrativeMappingStatus,
      provinceCode: row.administrativeProvinceCode,
      communeCode: row.administrativeCommuneCode,
      datasetVersion: row.administrativeDatasetVersion,
    },
    dataset.combinedDatasetVersion,
    row.administrativeCommuneCode ? (communes.get(row.administrativeCommuneCode) ?? null) : null,
  );
  return { blocksPublication: block !== null, approvalBlock: block };
}

import { Body, Controller, Get, Header, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../shared/app-error';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { RequireRole } from '../../cms/presentation/admin.guard';
import { PlaceImportJobService, type ImportMode } from '../application/place-import-job.service';

const Uuid = new ZodValidationPipe(z.string().uuid());

const MODES = ['dry_run', 'create_drafts', 'publish_approved'] as const;

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const rowsQuery = listQuery.extend({
  status: z
    .enum([
      'pending',
      'validation_failed',
      'resolving',
      'unresolved',
      'needs_confirmation',
      'duplicate',
      'ready',
      'imported',
      'failed',
    ])
    .optional(),
});

const sheetSchema = z.object({
  spreadsheetUrl: z.string().trim().min(10).max(2000),
  sheets: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  mode: z.enum(MODES).default('dry_run'),
  defaultCity: z.string().trim().max(80).optional(),
  tabCityMapping: z.record(z.string().max(120), z.string().max(80)).optional(),
  mapping: z.record(z.string().max(200), z.string().max(64)).optional(),
});

const confirmSchema = z.object({ googlePlaceId: z.string().trim().min(5).max(255) });
const mergeSchema = z.object({ placeId: z.string().uuid() });
const publishSchema = z.object({ rowIds: z.array(z.string().uuid()).max(500).optional() });

/** Multipart fields arrive as strings; the file itself is validated by content. */
type MultipartRequest = {
  file(): Promise<
    | {
        filename: string;
        toBuffer(): Promise<Buffer>;
        fields: Record<string, { value?: unknown } | undefined>;
      }
    | undefined
  >;
  isMultipart?: () => boolean;
};

/**
 * PI-BE-016 — CMS bulk import APIs (spec §10). Every route is RBAC-gated and
 * audited; publishing is separated from importing so an editor can prepare a
 * batch that only ops can push live (spec §9.3).
 */
@RequireRole('editor', 'ops_admin')
@Controller('cms/place-imports')
export class PlaceImportController {
  constructor(private readonly jobs: PlaceImportJobService) {}

  @RateLimit({ action: 'cms.place_import.create', limit: 10, windowSeconds: 300, keyBy: 'actor' })
  @Post()
  async createFromFile(@CurrentActor() actor: Actor, @Req() req: MultipartRequest) {
    const part = await req.file().catch(() => undefined);
    if (!part) throw AppError.badRequest('FILE_REQUIRED', 'Cần upload file CSV hoặc XLSX');

    const bytes = await part.toBuffer().catch(() => {
      throw AppError.badRequest('FILE_TOO_LARGE', 'File vượt quá 20 MB');
    });
    const field = (name: string): string | undefined => {
      const value = part.fields[name]?.value;
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    };

    const mode = (field('mode') ?? 'dry_run').toLowerCase();
    if (!(MODES as readonly string[]).includes(mode)) {
      throw AppError.badRequest('MODE_INVALID', `mode không hợp lệ: ${mode}`);
    }
    const mappingRaw = field('mapping');
    let mapping: Record<string, string> | undefined;
    if (mappingRaw) {
      try {
        const parsed: unknown = JSON.parse(mappingRaw);
        mapping = z.record(z.string().max(200), z.string().max(64)).parse(parsed);
      } catch {
        throw AppError.badRequest('MAPPING_INVALID', 'mapping phải là JSON object hợp lệ');
      }
    }

    return this.jobs.createFromFile({
      bytes,
      fileName: part.filename,
      mode: mode as ImportMode,
      defaultCity: field('defaultCity'),
      mapping,
      adminId: actor.id,
    });
  }

  @RateLimit({ action: 'cms.place_import.create', limit: 10, windowSeconds: 300, keyBy: 'actor' })
  @Post('google-sheet')
  createFromSheet(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(sheetSchema)) body: z.infer<typeof sheetSchema>,
  ) {
    return this.jobs.createFromSheet({
      spreadsheetUrl: body.spreadsheetUrl,
      tabs: body.sheets,
      tabCityMapping: body.tabCityMapping,
      mode: body.mode,
      defaultCity: body.defaultCity,
      mapping: body.mapping,
      adminId: actor.id,
    });
  }

  @Get()
  list(@Query(new ZodValidationPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return this.jobs.listJobs(query);
  }

  @Get(':jobId')
  get(@Param('jobId', Uuid) jobId: string) {
    return this.jobs.getJob(jobId);
  }

  @Get(':jobId/rows')
  rows(
    @Param('jobId', Uuid) jobId: string,
    @Query(new ZodValidationPipe(rowsQuery)) query: z.infer<typeof rowsQuery>,
  ) {
    return this.jobs.listRows(jobId, query);
  }

  @Get(':jobId/error-report')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="import-errors.csv"')
  // Never rendered inline: the CSV holds attacker-influenced cell text.
  @Header('x-content-type-options', 'nosniff')
  errorReport(@Param('jobId', Uuid) jobId: string) {
    return this.jobs.errorReportCsv(jobId);
  }

  @Post(':jobId/start')
  start(@CurrentActor() actor: Actor, @Param('jobId', Uuid) jobId: string) {
    return this.jobs.start(jobId, actor.id);
  }

  @Post(':jobId/cancel')
  cancel(@CurrentActor() actor: Actor, @Param('jobId', Uuid) jobId: string) {
    return this.jobs.cancel(jobId, actor.id);
  }

  @Post(':jobId/retry')
  retry(@CurrentActor() actor: Actor, @Param('jobId', Uuid) jobId: string) {
    return this.jobs.retry(jobId, actor.id);
  }

  @Post(':jobId/rows/:rowId/confirm-candidate')
  confirm(
    @CurrentActor() actor: Actor,
    @Param('jobId', Uuid) jobId: string,
    @Param('rowId', Uuid) rowId: string,
    @Body(new ZodValidationPipe(confirmSchema)) body: z.infer<typeof confirmSchema>,
  ) {
    return this.jobs.confirmCandidate(jobId, rowId, body.googlePlaceId, actor.id);
  }

  @Post(':jobId/rows/:rowId/merge')
  merge(
    @CurrentActor() actor: Actor,
    @Param('jobId', Uuid) jobId: string,
    @Param('rowId', Uuid) rowId: string,
    @Body(new ZodValidationPipe(mergeSchema)) body: z.infer<typeof mergeSchema>,
  ) {
    return this.jobs.mergeRow(jobId, rowId, body.placeId, actor.id);
  }

  @Post(':jobId/rows/:rowId/skip')
  skip(
    @CurrentActor() actor: Actor,
    @Param('jobId', Uuid) jobId: string,
    @Param('rowId', Uuid) rowId: string,
  ) {
    return this.jobs.skipRow(jobId, rowId, actor.id);
  }

  /**
   * Creating catalog rows is an ops decision — an editor prepares the batch,
   * ops publishes it (spec §9.3). super_admin passes via the guard.
   */
  @RequireRole('ops_admin')
  @Post(':jobId/publish')
  publish(
    @CurrentActor() actor: Actor,
    @Param('jobId', Uuid) jobId: string,
    @Body(new ZodValidationPipe(publishSchema)) body: z.infer<typeof publishSchema>,
  ) {
    return this.jobs.publish(jobId, actor.id, body.rowIds);
  }
}

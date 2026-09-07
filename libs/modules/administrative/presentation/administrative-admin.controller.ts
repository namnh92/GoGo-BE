import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../shared/app-error';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { RequireRole } from '../../cms/presentation/admin.guard';
import {
  AdministrativeImportService,
  DuplicateImportError,
} from '../application/administrative-import.service';
import { AdministrativeValidationService } from '../application/administrative-validation.service';
import { AdministrativePublicationService } from '../application/administrative-publication.service';
import { AdministrativeTelemetryService } from '../application/administrative-telemetry.service';

/**
 * ADM-005 (#458) / ADR-0019 §3 — the staff surface for administrative datasets.
 *
 * It sits under `/cms` with every other staff route rather than under a new
 * `/admin` prefix: `AdminGuard` is bound there, the console already speaks it,
 * and a second staff prefix would split the surface for no gain.
 *
 * `@RequireRole('ops_admin')` on the class gets both halves of the RBAC from
 * the guard's existing rule, which is why no new role or permission is invented
 * here. A **write** needs the exact role (or the audited super-admin bypass);
 * a **read** needs only rank ≥ ops_admin, so an on-call operator can look at a
 * dataset without being able to publish it, while `editor` and `moderator` —
 * whose work is the catalog, not the country's administrative geography — get
 * neither.
 *
 * Nothing here takes a decision from its caller. `publish` accepts a dataset id
 * and nothing else: no `publishable` flag, no checksum, no acknowledgement of
 * warnings. Every fact is re-read server-side inside the publishing
 * transaction.
 */

const ID = z.string().uuid('a dataset version id is a UUID');

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

/**
 * Entries are paged; the counts never are. A reviewer must be able to walk a
 * 14,000-entry diff without ever seeing a total that shrinks to the page.
 */
const diffQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const importBody = z
  .object({
    /**
     * Bumped by a reviewer decision, not by an upstream release: it is what
     * mints a new combined version when the pinned sources have not moved.
     */
    overrideRevision: z.number().int().min(0).max(10_000).optional().default(0),
  })
  .strict()
  .optional()
  .default({ overrideRevision: 0 });

@RequireRole('ops_admin')
@Controller('cms/administrative-datasets')
export class AdministrativeAdminController {
  constructor(
    private readonly imports: AdministrativeImportService,
    private readonly validation: AdministrativeValidationService,
    private readonly publication: AdministrativePublicationService,
    private readonly telemetry: AdministrativeTelemetryService,
  ) {}

  /**
   * What this environment can currently do, and since when.
   *
   * Deliberately separate from readiness. An environment with no administrative
   * dataset still serves rooms, search and plans; it simply cannot publish a
   * place, which the domain guard already refuses. Taking the whole API out of
   * the load balancer for that would turn a configuration gap into an outage.
   *
   * This is also where the exact dataset and boundary versions live. They are
   * not Prometheus labels: a label whose values grow with every publication is
   * a series set that never stops growing, so the number goes on a dashboard
   * and the identity goes here.
   */
  @RateLimit({ action: 'cms.administrative.read', limit: 120, windowSeconds: 60, keyBy: 'actor' })
  @Get('capability')
  async capability() {
    return this.telemetry.capability();
  }

  /**
   * Imports the pinned snapshot set into staging.
   *
   * Never touches the active dataset, and is one transaction: a failure leaves
   * nothing behind, so a retry is a clean import rather than a permanent
   * half-written version that the checksum guard would then call a duplicate.
   */
  @RateLimit({ action: 'cms.administrative.import', limit: 10, windowSeconds: 300, keyBy: 'actor' })
  @Post('import')
  async import(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(importBody)) body: z.infer<typeof importBody>,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    void idempotencyKey; // Replay is handled globally by IdempotencyInterceptor.
    try {
      const report = await this.imports.importPinnedSnapshot({
        overrideRevision: body.overrideRevision,
        actor: { id: actor.id, type: 'admin' },
      });
      return report;
    } catch (error) {
      if (error instanceof DuplicateImportError) {
        // The same bytes and the same override revision are the same dataset.
        // Refusing is not pedantry: a second copy would be a second row with
        // the same identity, and publication would have to choose between them.
        throw AppError.conflict('DATASET_ALREADY_IMPORTED', error.message);
      }
      throw error;
    }
  }

  @RateLimit({ action: 'cms.administrative.read', limit: 120, windowSeconds: 60, keyBy: 'actor' })
  @Get()
  async list(@Query(new ZodValidationPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return this.publication.list(query);
  }

  @RateLimit({ action: 'cms.administrative.read', limit: 120, windowSeconds: 60, keyBy: 'actor' })
  @Get('restorable')
  async restorable() {
    return { items: await this.publication.restorable() };
  }

  @RateLimit({ action: 'cms.administrative.read', limit: 120, windowSeconds: 60, keyBy: 'actor' })
  @Get(':id')
  async detail(@Param('id', new ZodValidationPipe(ID)) id: string) {
    return this.publication.detail(id);
  }

  /**
   * The diff against whatever is published right now, recomputed on read.
   *
   * A first publication compares against an explicitly empty baseline, which is
   * why `fromVersion` is `null` rather than the request being an error.
   */
  @RateLimit({ action: 'cms.administrative.read', limit: 120, windowSeconds: 60, keyBy: 'actor' })
  @Get(':id/diff')
  async diff(
    @Param('id', new ZodValidationPipe(ID)) id: string,
    @Query(new ZodValidationPipe(diffQuery)) query: z.infer<typeof diffQuery>,
  ) {
    const end = query.offset + query.limit;
    const diff = await this.validation.diffAgainstPublished(id, { entryLimit: end });
    const total = Object.values(diff.countsByCategory).reduce((a, b) => a + b, 0);
    return {
      ...diff,
      entries: diff.entries.slice(query.offset),
      pagination: {
        offset: query.offset,
        limit: query.limit,
        totalEntries: total,
        hasMore: total > end,
      },
    };
  }

  /**
   * Runs every gate against the exact staged snapshot and stores the result
   * bound to it. Re-running replaces the previous result rather than adding to
   * it, so "the validation" is never ambiguous.
   */
  @RateLimit({
    action: 'cms.administrative.validate',
    limit: 30,
    windowSeconds: 300,
    keyBy: 'actor',
  })
  @Post(':id/validate')
  async validate(@Param('id', new ZodValidationPipe(ID)) id: string) {
    const { report, diff } = await this.validation.validate(id);
    return { validation: report, diff };
  }

  /**
   * Publish and rollback share one budget, and it is deliberately not tight.
   * A refused attempt consumes it too, and refusal is the common case while a
   * reviewer works through gate failures — a limit that fires on someone doing
   * the job correctly teaches them to route around it.
   */
  @RateLimit({
    action: 'cms.administrative.publish',
    limit: 60,
    windowSeconds: 300,
    keyBy: 'actor',
  })
  @Post(':id/publish')
  async publish(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(ID)) id: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.publication.publish(
      id,
      { id: actor.id, type: 'admin' },
      { idempotencyKey: idempotencyKey ?? null },
    );
  }

  @RateLimit({
    action: 'cms.administrative.publish',
    limit: 60,
    windowSeconds: 300,
    keyBy: 'actor',
  })
  @Post(':id/rollback')
  async rollback(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(ID)) id: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.publication.rollback(
      id,
      { id: actor.id, type: 'admin' },
      { idempotencyKey: idempotencyKey ?? null },
    );
  }
}

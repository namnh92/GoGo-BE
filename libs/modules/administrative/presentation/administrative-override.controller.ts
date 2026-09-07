import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { RequireRole } from '../../cms/presentation/admin.guard';
import { AdministrativeOverrideService } from '../application/administrative-override.service';
import { DECISION_STATES, type DecisionState } from '../domain/override-sets';

/**
 * ADM-011 (#484) / ADR-0019 — the reviewer surface for the advisory mapping
 * source.
 *
 * It shares the dataset prefix and the dataset's RBAC deliberately. Adjudicating
 * the source that says which commune became which is not moderation of a place:
 * it is a decision about the country's administrative geography, taken by
 * whoever publishes the dataset, and giving it to the place moderator would put
 * one person on both halves of a separation the approval policy exists to keep.
 *
 * `@RequireRole('ops_admin')` gets both halves from the guard's existing rule —
 * a **read** needs rank ≥ ops_admin, a **write** needs the exact role or the
 * audited super-admin bypass. No new role, no new permission.
 */

const ID = z.string().uuid('a dataset version id is a UUID');
const ROW_ID = z.string().uuid('a quarantined row id is a UUID');

/** Neither of these is free text: both are closed sets the server owns. */
const CLASSIFICATIONS = [
  'VALID_UNIQUE',
  'VALID_MERGE',
  'VALID_DISTRICT_TO_SPECIAL_ZONE',
  'DIVIDED_REQUIRES_REVIEW',
  'TARGET_NOT_FOUND',
  'SOURCE_NOT_FOUND',
  'MULTIPLE_TARGETS',
  'HIERARCHY_CONFLICT',
  'DUPLICATE',
  'INVALID',
] as const;

const csv = <T extends string>(allowed: readonly T[]) =>
  z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').filter(Boolean) : undefined))
    .refine(
      (values) => !values || values.every((v) => (allowed as readonly string[]).includes(v)),
      {
        message: `expected a comma-separated subset of: ${allowed.join(', ')}`,
      },
    )
    .transform((values) => values as T[] | undefined);

const queueQuery = z.object({
  classification: csv(CLASSIFICATIONS),
  decisionState: csv(DECISION_STATES as readonly DecisionState[]),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().max(512).optional(),
});

/**
 * Every mutation carries the revision the reviewer was looking at. Two people
 * deciding the same row a second apart both succeed without it, and the second
 * silently wins — which is the one failure mode a review queue cannot have.
 */
const expectedRevision = z.number().int().min(0);
const reason = z
  .string()
  .trim()
  .min(1, 'a decision nobody explained cannot be reviewed later')
  .max(1000);

const acceptBody = z
  .object({
    /**
     * The target, named. A code alone is not an identity — 2,212 of the 3,321
     * current commune codes changed meaning on 2025-07-01 — so the effective
     * date is required beside it, and there is deliberately no way to accept
     * "the first candidate": the upstream's default successor for a divided
     * commune is exactly the guess ADR-0019 refuses.
     */
    targetCode: z.string().min(1).max(20),
    targetEffectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
    reason,
    expectedRevision,
  })
  .strict();

const rejectBody = z.object({ reason, expectedRevision }).strict();

const materializeBody = z
  .object({
    reason,
    expectedRevision,
  })
  .strict();

@RequireRole('ops_admin')
@Controller('cms/administrative-datasets')
export class AdministrativeOverrideController {
  constructor(private readonly overrides: AdministrativeOverrideService) {}

  /**
   * The review queue for one dataset.
   *
   * Counts come back in three separate groups because they answer three
   * different questions, and conflating them is the specific mistake available
   * here: `classification` counts every advisory row including the 9,569 the
   * importer promoted, so a backlog read from it is nine times too large.
   */
  @Get(':id/quarantine')
  async queue(
    @Param('id', new ZodValidationPipe(ID)) id: string,
    @Query(new ZodValidationPipe(queueQuery)) query: z.infer<typeof queueQuery>,
  ) {
    return this.overrides.listQuarantine(id, {
      classification: query.classification,
      decisionState: query.decisionState,
      limit: query.limit,
      cursor: query.cursor ?? null,
    });
  }

  /** One row: what the source said, what could be chosen, and who decided what. */
  @Get(':id/quarantine/:rowId')
  async row(
    @Param('id', new ZodValidationPipe(ID)) id: string,
    @Param('rowId', new ZodValidationPipe(ROW_ID)) rowId: string,
  ) {
    return this.overrides.quarantineDetail(id, rowId);
  }

  /** The draft set, its counts, and the datasets earlier rounds produced. */
  @Get(':id/override-set')
  async overrideSet(@Param('id', new ZodValidationPipe(ID)) id: string) {
    return this.overrides.overrideSetFor(id);
  }

  /**
   * Accept the advisory edge onto a target the reviewer names.
   *
   * The budget is deliberately wide: 1,033 rows is a session's work, and a limit
   * that fires on somebody doing the job properly teaches them to route around
   * it.
   */
  @RateLimit({
    action: 'cms.administrative.override',
    limit: 300,
    windowSeconds: 300,
    keyBy: 'actor',
  })
  @Post(':id/quarantine/:rowId/accept')
  async accept(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(ID)) id: string,
    @Param('rowId', new ZodValidationPipe(ROW_ID)) rowId: string,
    @Body(new ZodValidationPipe(acceptBody)) body: z.infer<typeof acceptBody>,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.overrides.accept(
      id,
      rowId,
      body,
      { id: actor.id, type: 'admin' },
      { idempotencyKey: idempotencyKey ?? null },
    );
  }

  /** Reject the advisory edge. It deletes no evidence and rejects no place. */
  @RateLimit({
    action: 'cms.administrative.override',
    limit: 300,
    windowSeconds: 300,
    keyBy: 'actor',
  })
  @Post(':id/quarantine/:rowId/reject')
  async reject(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(ID)) id: string,
    @Param('rowId', new ZodValidationPipe(ROW_ID)) rowId: string,
    @Body(new ZodValidationPipe(rejectBody)) body: z.infer<typeof rejectBody>,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.overrides.reject(
      id,
      rowId,
      body,
      { id: actor.id, type: 'admin' },
      { idempotencyKey: idempotencyKey ?? null },
    );
  }

  /**
   * Turn the effective decisions into one new STAGED dataset.
   *
   * It validates nothing and publishes nothing: the derived version goes through
   * the ordinary validate → diff → publish path, because a reviewer decision
   * that published itself would be a publication nobody reviewed.
   */
  @RateLimit({
    action: 'cms.administrative.publish',
    limit: 60,
    windowSeconds: 300,
    keyBy: 'actor',
  })
  @Post(':id/override-set/materialize')
  async materialize(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(ID)) id: string,
    @Body(new ZodValidationPipe(materializeBody)) body: z.infer<typeof materializeBody>,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.overrides.materialize(
      id,
      body,
      { id: actor.id, type: 'admin' },
      { idempotencyKey: idempotencyKey ?? null },
    );
  }

  /** Close a draft nobody is going to materialise. The decisions stay readable. */
  @RateLimit({
    action: 'cms.administrative.publish',
    limit: 60,
    windowSeconds: 300,
    keyBy: 'actor',
  })
  @Post(':id/override-set/abandon')
  async abandon(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(ID)) id: string,
    @Body(new ZodValidationPipe(materializeBody)) body: z.infer<typeof materializeBody>,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.overrides.abandon(
      id,
      body,
      { id: actor.id, type: 'admin' },
      { idempotencyKey: idempotencyKey ?? null },
    );
  }
}

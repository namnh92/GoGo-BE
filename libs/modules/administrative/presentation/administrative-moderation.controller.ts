import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { RequireRole, type AdminActor } from '../../cms/presentation/admin.guard';
import { AdministrativeModerationService } from '../application/administrative-moderation.service';

/**
 * ADM-009 (#462) / ADR-0019 §7 — the staff surface for mapping moderation.
 *
 * Under `/cms` with everything else staff-facing; no second prefix, no new
 * role. The split of duties falls out of the roles that already exist:
 * `moderator` owns the review queue and therefore owns verifying, rejecting,
 * correcting and rematching a mapping; `ops_admin` owns the datasets and
 * therefore owns reconciling a mapping against a newly published one; `editor`
 * owns the catalogue and therefore still owns approving the place itself — and
 * cannot verify the mapping that approval depends on.
 *
 * That last one is deliberate rather than incidental: the person who decides
 * a place belongs in the catalogue is not the person who certifies where it is.
 * `super_admin` bypasses both, audibly, which is the existing escape hatch.
 */

const ID = z.string().uuid('a place id is a UUID');
const CODE = z
  .string()
  .trim()
  .regex(/^[0-9]{2,5}$/, 'an administrative code is 2 to 5 digits');

const MAPPING_STATUS = z.enum([
  'UNMAPPED',
  'AUTO_MATCHED',
  'NEEDS_REVIEW',
  'VERIFIED',
  'REJECTED',
  'STALE',
]);

const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item))
    .optional();

const listQuery = z.object({
  status: csv(MAPPING_STATUS),
  placeStatus: csv(
    z.enum(['draft', 'community_submitted', 'review', 'published', 'suspended', 'archived']),
  ),
  /** Places whose approval is blocked by their mapping and are awaiting it. */
  blockedApprovalOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().uuid().optional(),
});

/** `expectedUpdatedAt` on every mutation: a reviewer decides about a row they saw. */
const concurrency = { expectedUpdatedAt: z.coerce.date() };

const verifyBody = z
  .object({
    provinceCode: CODE,
    communeCode: CODE,
    legacyDistrictCode: CODE.nullish(),
    note: z.string().trim().max(500).optional(),
    ...concurrency,
  })
  .strict();

const reasonBody = z.object({ reason: z.string().trim().min(1).max(500), ...concurrency }).strict();

const correctBody = verifyBody
  .omit({ note: true })
  .extend({ reason: z.string().trim().min(1).max(500) })
  .strict();

@RequireRole('moderator')
@Controller('cms/administrative-mappings')
export class AdministrativeMappingQueueController {
  constructor(private readonly moderation: AdministrativeModerationService) {}

  /**
   * The queue.
   *
   * `UNMAPPED` is not actionable — there is nothing for a person to decide
   * about a place the resolver could not place — but it is never hidden: it is
   * one filter away, it is in the counts, and `blockedApprovalOnly=true`
   * surfaces the ones that matter most, the places waiting for approval that
   * cannot get it.
   */
  @RateLimit({
    action: 'cms.administrative.moderation',
    limit: 120,
    windowSeconds: 60,
    keyBy: 'actor',
  })
  @Get()
  async list(@Query(new ZodValidationPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return this.moderation.list({
      ...(query.status ? { status: query.status } : {}),
      ...(query.placeStatus ? { placeStatus: query.placeStatus } : {}),
      blockedApprovalOnly: query.blockedApprovalOnly,
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  }

  /**
   * Approved places that would not pass today's policy.
   *
   * Reporting only. Nothing here un-approves anything: these were approved
   * before the policy existed, and taking a working catalogue off the air to
   * satisfy a rule written afterwards would do more harm than the gap it closes.
   */
  @RateLimit({
    action: 'cms.administrative.moderation',
    limit: 120,
    windowSeconds: 60,
    keyBy: 'actor',
  })
  @Get('remediation')
  async remediation() {
    return this.moderation.remediation();
  }
}

@RequireRole('moderator')
@Controller('cms/places')
export class AdministrativeMappingController {
  constructor(private readonly moderation: AdministrativeModerationService) {}

  @RateLimit({
    action: 'cms.administrative.moderation',
    limit: 120,
    windowSeconds: 60,
    keyBy: 'actor',
  })
  @Get(':id/administrative-mapping')
  async detail(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(ID)) id: string) {
    return this.moderation.detail(id, (actor as AdminActor).role);
  }

  @RateLimit({ action: 'cms.administrative.decide', limit: 120, windowSeconds: 60, keyBy: 'actor' })
  @Post(':id/administrative-mapping/verify')
  async verify(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(ID)) id: string,
    @Body(new ZodValidationPipe(verifyBody)) body: z.infer<typeof verifyBody>,
  ) {
    return this.moderation.verify(
      id,
      {
        provinceCode: body.provinceCode,
        communeCode: body.communeCode,
        legacyDistrictCode: body.legacyDistrictCode ?? null,
        expectedUpdatedAt: body.expectedUpdatedAt,
        ...(body.note ? { note: body.note } : {}),
      },
      { id: actor.id, role: (actor as AdminActor).role },
    );
  }

  /** Rejecting the mapping. The place itself is untouched. */
  @RateLimit({ action: 'cms.administrative.decide', limit: 120, windowSeconds: 60, keyBy: 'actor' })
  @Post(':id/administrative-mapping/reject')
  async reject(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(ID)) id: string,
    @Body(new ZodValidationPipe(reasonBody)) body: z.infer<typeof reasonBody>,
  ) {
    return this.moderation.rejectMapping(id, body, {
      id: actor.id,
      role: (actor as AdminActor).role,
    });
  }

  /**
   * The only route that reopens a rejected mapping — one place, a reason, and a
   * person to attribute it to. ADM-008's bulk job has no such option because it
   * has nobody to name.
   */
  @RateLimit({ action: 'cms.administrative.decide', limit: 60, windowSeconds: 300, keyBy: 'actor' })
  @Post(':id/administrative-mapping/rematch')
  async rematch(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(ID)) id: string,
    @Body(new ZodValidationPipe(reasonBody)) body: z.infer<typeof reasonBody>,
  ) {
    return this.moderation.rematch(id, body, { id: actor.id, role: (actor as AdminActor).role });
  }

  /** Changing a decision somebody already made. Names both people. */
  @RateLimit({ action: 'cms.administrative.decide', limit: 60, windowSeconds: 300, keyBy: 'actor' })
  @Post(':id/administrative-mapping/correct')
  async correct(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(ID)) id: string,
    @Body(new ZodValidationPipe(correctBody)) body: z.infer<typeof correctBody>,
  ) {
    return this.moderation.correctVerified(
      id,
      {
        provinceCode: body.provinceCode,
        communeCode: body.communeCode,
        legacyDistrictCode: body.legacyDistrictCode ?? null,
        reason: body.reason,
        expectedUpdatedAt: body.expectedUpdatedAt,
      },
      { id: actor.id, role: (actor as AdminActor).role },
    );
  }

  /**
   * System reconciliation against the active dataset. `ops_admin`, because it
   * belongs to whoever published the dataset that changed — and because it is
   * emphatically not a verification.
   */
  @RequireRole('ops_admin')
  @RateLimit({ action: 'cms.administrative.decide', limit: 120, windowSeconds: 60, keyBy: 'actor' })
  @Post(':id/administrative-mapping/reconcile')
  async reconcile(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(ID)) id: string,
  ) {
    return this.moderation.reconcile(id, { id: actor.id, role: (actor as AdminActor).role });
  }
}

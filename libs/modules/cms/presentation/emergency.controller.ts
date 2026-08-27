import { Body, Controller, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../shared/app-error';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { EmergencyTakedownService } from '../application/emergency-takedown.service';
import { RequireRole, type AdminActor } from './admin.guard';

const Uuid = new ZodValidationPipe(z.string().uuid());

const takedownSchema = z.object({
  // Long enough to be an actual reason. This record is the only explanation
  // anyone reviewing the incident afterwards will have.
  reason: z.string().trim().min(10).max(500),
});

/**
 * SEC-001 — break-glass surface, deliberately its own controller.
 *
 * Separate routes rather than a flag on the normal endpoints: it gives the
 * emergency path its own rate limit, its own audit actions and its own metric,
 * it cannot be reached by accident from routine work, and "one resource per
 * call" is enforced by the shape — there is no bulk form to abuse.
 *
 * Open to every active admin role (`super_admin` passes via the guard). Any
 * narrower list rebuilds the problem this exists to solve: the point is that
 * whoever is actually awake can act.
 */
@RequireRole('editor', 'moderator', 'ops_admin')
@Controller('cms/emergency')
export class EmergencyController {
  constructor(private readonly takedown: EmergencyTakedownService) {}

  @RateLimit({
    action: 'cms.emergency_takedown',
    limit: 20,
    windowSeconds: 3600,
    // An hourly cap alone still allows twenty takedowns in two seconds, which
    // is a script, not an incident response.
    burst: { limit: 5, windowSeconds: 60 },
    keyBy: 'actor',
  })
  @Post('places/:id/suspend')
  suspendPlace(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(takedownSchema)) body: z.infer<typeof takedownSchema>,
  ) {
    return this.takedown.suspendPlace(asAdmin(actor), id, body.reason);
  }

  @RateLimit({
    action: 'cms.emergency_takedown',
    limit: 20,
    windowSeconds: 3600,
    burst: { limit: 5, windowSeconds: 60 },
    keyBy: 'actor',
  })
  @Post('reviews/:id/hide')
  hideReview(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(takedownSchema)) body: z.infer<typeof takedownSchema>,
  ) {
    return this.takedown.hideReview(asAdmin(actor), id, body.reason);
  }

  @RateLimit({
    action: 'cms.emergency_takedown',
    limit: 20,
    windowSeconds: 3600,
    burst: { limit: 5, windowSeconds: 60 },
    keyBy: 'actor',
  })
  @Post('checkins/:id/hide')
  hideCheckin(
    @CurrentActor() actor: Actor,
    @Param('id', Uuid) id: string,
    @Body(new ZodValidationPipe(takedownSchema)) body: z.infer<typeof takedownSchema>,
  ) {
    return this.takedown.hideCheckin(asAdmin(actor), id, body.reason);
  }
}

/** AdminGuard resolved the role onto the actor before the handler ran. */
function asAdmin(actor: Actor): { id: string; role: AdminActor['role'] } {
  const role = (actor as AdminActor).role;
  if (!role) throw AppError.forbidden('ADMIN_ONLY', 'CMS access requires a staff account');
  return { id: actor.id, role };
}

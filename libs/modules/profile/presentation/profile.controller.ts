import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { IdentityRepository } from '../../identity/infrastructure/identity.repository';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { ProfileService } from '../application/profile.service';
import { profilePatchSchema, type ProfilePatchDto } from './dtos';

/**
 * PROF-BE-002 (#532) — `/me` lives here for both verbs. The guest branch is
 * the session facts identity used to answer with; it moved with the route so
 * one controller owns the path and no second handler can shadow it.
 */
@Controller()
export class ProfileController {
  constructor(
    private readonly profile: ProfileService,
    private readonly identity: IdentityRepository,
  ) {}

  @Get('me')
  async me(@CurrentActor() actor: Actor) {
    if (actor.type === 'guest') {
      const guest = await this.identity.findGuestSessionById(actor.id);
      return {
        actorType: 'guest',
        id: actor.id,
        roomId: actor.roomId,
        displayName: guest?.displayName,
        expiresAt: guest?.expiresAt?.toISOString(),
      };
    }
    return this.profile.getProfile(actor);
  }

  @RateLimit({ action: 'me.profile', limit: 30, windowSeconds: 60, keyBy: 'actor' })
  @Patch('me')
  updateProfile(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(profilePatchSchema)) body: ProfilePatchDto,
  ) {
    return this.profile.updateProfile(actor, body);
  }
}

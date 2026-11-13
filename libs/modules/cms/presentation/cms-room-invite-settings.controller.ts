import { Body, Controller, Get, Headers, Put, Req, Res } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentActor } from '../../identity/presentation/decorators';
import { AppError } from '../../shared/app-error';
import { idempotencyScope, ManualIdempotency } from '../../shared/idempotency.interceptor';
import { setStrongEtagHeaders } from '../../shared/strong-etag-headers';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { CmsRoomInviteSettingsService } from '../application/cms-room-invite-settings.service';
import { RequireAccessSso, RequireRole, type AdminActor } from './admin.guard';
import {
  updateRoomInviteSettingsSchema,
  type UpdateRoomInviteSettings,
} from './room-invite-settings.dto';

export function requireStrongIfMatch(value: unknown): string {
  if (value === undefined) throw new AppError('PRECONDITION_REQUIRED', 'If-Match is required', 428);
  const normalized = typeof value === 'string' ? value.replace(/^[ \t]+|[ \t]+$/g, '') : null;
  if (normalized === null || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(normalized))
    throw AppError.badRequest('INVALID_IF_MATCH', 'If-Match must contain one strong ETag');
  return normalized;
}

@RequireRole('super_admin')
@RequireAccessSso()
@Controller('cms/settings/room-invites')
export class CmsRoomInviteSettingsController {
  constructor(private readonly settings: CmsRoomInviteSettingsService) {}

  @Get()
  async read(@Res({ passthrough: true }) reply: FastifyReply) {
    const body = await this.settings.read();
    setStrongEtagHeaders(reply, body.etag);
    return body;
  }

  @Put()
  @ManualIdempotency()
  async update(
    @CurrentActor() actor: AdminActor,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('if-match') header: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body(new ZodValidationPipe(updateRoomInviteSettingsSchema)) input: UpdateRoomInviteSettings,
  ) {
    const ifMatch = requireStrongIfMatch(header);
    if (key === undefined)
      throw AppError.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
    if (typeof key !== 'string')
      throw AppError.badRequest('INVALID_IDEMPOTENCY_KEY', 'Invalid Idempotency-Key');
    const scope = idempotencyScope(Object.assign(req, { actor }), key);
    // Bind If-Match only for this route; preserve every existing route's scope.
    scope.requestHash = createHash('sha256')
      .update(JSON.stringify([scope.requestHash, ifMatch]))
      .digest('hex');
    const { body, replayed } = await this.settings.update(
      actor.id,
      input.ttlSeconds,
      ifMatch,
      scope,
    );
    setStrongEtagHeaders(reply, body.etag);
    if (replayed) reply.header('x-idempotent-replay', 'true');
    return body;
  }
}

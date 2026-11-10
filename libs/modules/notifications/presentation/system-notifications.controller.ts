import { setStrongEtagHeaders } from '../../shared/strong-etag-headers';
import { Controller, Get, Headers, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public, RateLimit } from '../../identity/presentation/decorators';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import {
  systemNotificationQuery,
  type SystemNotificationQuery,
} from '../domain/system-announcement';
import { SystemNotificationsService } from '../application/system-notifications.service';

@Controller('system-notifications')
export class SystemNotificationsController {
  constructor(private readonly announcements: SystemNotificationsService) {}

  @Public()
  @RateLimit({ action: 'system-notifications.list', keyBy: 'ip', limit: 60, windowSeconds: 60 })
  @Get()
  async list(
    @Query(new ZodValidationPipe(systemNotificationQuery)) query: SystemNotificationQuery,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.announcements.listPublic(query, ifNoneMatch);
    setStrongEtagHeaders(reply, result.etag, 'public, max-age=60');
    if (result.notModified) {
      reply.code(304);
      return;
    }
    return result.body;
  }
}

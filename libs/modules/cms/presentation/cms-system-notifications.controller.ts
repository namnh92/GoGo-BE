import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentActor } from '../../identity/presentation/decorators';
import type { Actor } from '../../identity/domain/actor';
import { ManualIdempotency, idempotencyScope } from '../../shared/idempotency.interceptor';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { SystemNotificationsService } from '../../notifications/application/system-notifications.service';
import {
  cmsSystemNotificationQuery,
  systemAnnouncementInput,
  systemAnnouncementPatch,
  type SystemAnnouncementInput,
  type SystemAnnouncementPatch,
  type SystemNotificationQuery,
} from '../../notifications/domain/system-announcement';
import { RequireRole } from './admin.guard';

@RequireRole('ops_admin', 'super_admin')
@Controller('cms/system-notifications')
export class CmsSystemNotificationsController {
  constructor(private readonly announcements: SystemNotificationsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(cmsSystemNotificationQuery)) query: SystemNotificationQuery,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    return this.announcements.listCms(query);
  }

  @ManualIdempotency()
  @Post()
  async create(
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(systemAnnouncementInput)) body: SystemAnnouncementInput,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.announcements.create(
      actor.id,
      body,
      idempotencyScope(Object.assign(req, { actor }), key ?? ''),
    );
    reply.code(result.status);
    return result.body;
  }

  @Patch(':id')
  patch(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(z.string().uuid())) id: string,
    @Body(new ZodValidationPipe(systemAnnouncementPatch)) body: SystemAnnouncementPatch,
  ) {
    return this.announcements.patch(actor.id, id, body);
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(z.string().uuid())) id: string,
  ) {
    return this.announcements.setStatus(actor.id, id, 'published');
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(z.string().uuid())) id: string,
  ) {
    return this.announcements.setStatus(actor.id, id, 'archived');
  }
}

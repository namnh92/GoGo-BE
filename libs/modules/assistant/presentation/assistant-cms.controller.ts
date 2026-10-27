import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { CurrentActor } from '../../identity/presentation/decorators';
import { ExactRoleRead, RequireRole, type AdminActor } from '../../cms/presentation/admin.guard';
import { GuideDocumentsService } from '../application/guide-documents.service';
import { AssistantFeedbackQueueService } from '../application/assistant-feedback-queue.service';
import {
  cmsCreateDocumentBody,
  cmsDocumentsQuery,
  cmsDraftPatchBody,
  cmsFeedbackQuery,
  cmsPublishBody,
  cmsUnpublishBody,
  cmsVersionsQuery,
  uuid,
} from './dtos';

const UuidPipe = new ZodValidationPipe(uuid);

/**
 * GoGo-BE#713, GoGo-CMS#249 — the "GoGo guide". Drafts: `editor`,
 * `ops_admin`; publish / unpublish: `ops_admin` only (a release decision);
 * reads follow the hierarchical rule (BE-IMP-008), so `moderator` reads the
 * set it reviews feedback against.
 */
@RequireRole('editor', 'ops_admin')
@Controller('cms/assistant/documents')
export class AssistantDocumentsCmsController {
  constructor(private readonly documents: GuideDocumentsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(cmsDocumentsQuery)) query: z.infer<typeof cmsDocumentsQuery>) {
    return this.documents.list(query);
  }

  @Post()
  create(
    @CurrentActor() actor: AdminActor,
    @Body(new ZodValidationPipe(cmsCreateDocumentBody)) body: z.infer<typeof cmsCreateDocumentBody>,
  ) {
    return this.documents.create(body, { id: actor.id, role: actor.role });
  }

  @Get(':id')
  get(@Param('id', UuidPipe) id: string) {
    return this.documents.detail(id);
  }

  @Patch(':id')
  updateDraft(
    @CurrentActor() actor: AdminActor,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(cmsDraftPatchBody)) body: z.infer<typeof cmsDraftPatchBody>,
  ) {
    return this.documents.updateDraft(id, body, { id: actor.id, role: actor.role });
  }

  @RequireRole('ops_admin')
  @Post(':id/publish')
  @HttpCode(200)
  publish(
    @CurrentActor() actor: AdminActor,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(cmsPublishBody)) body: z.infer<typeof cmsPublishBody>,
  ) {
    return this.documents.publish(id, body, { id: actor.id, role: actor.role });
  }

  @RequireRole('ops_admin')
  @Post(':id/unpublish')
  @HttpCode(200)
  unpublish(
    @CurrentActor() actor: AdminActor,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(cmsUnpublishBody)) body: z.infer<typeof cmsUnpublishBody>,
  ) {
    return this.documents.unpublish(id, body.reason, { id: actor.id, role: actor.role });
  }

  @Get(':id/versions')
  versions(
    @Param('id', UuidPipe) id: string,
    @Query(new ZodValidationPipe(cmsVersionsQuery)) query: z.infer<typeof cmsVersionsQuery>,
  ) {
    return this.documents.versions(id, query);
  }

  @Get(':id/versions/:versionId')
  version(@Param('id', UuidPipe) id: string, @Param('versionId', UuidPipe) versionId: string) {
    return this.documents.version(id, versionId);
  }
}

/**
 * The feedback queue: `moderator`, `ops_admin`, `super_admin` only — an
 * explicit exception to rank-read (Q8), so an `editor` gets `403 ROLE_DENIED`.
 */
@RequireRole('moderator', 'ops_admin', 'super_admin')
@ExactRoleRead()
@Controller('cms/assistant/feedback')
export class AssistantFeedbackCmsController {
  constructor(private readonly queue: AssistantFeedbackQueueService) {}

  @Get()
  list(@Query(new ZodValidationPipe(cmsFeedbackQuery)) query: z.infer<typeof cmsFeedbackQuery>) {
    return this.queue.list(query);
  }
}

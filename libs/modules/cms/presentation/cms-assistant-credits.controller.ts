import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor } from '../../identity/presentation/decorators';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { CmsAssistantCreditsService } from '../application/cms-assistant-credits.service';
import { ExactRoleRead, RequireRole, type AdminActor } from './admin.guard';

const creditsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

/** #778 — account facts only; no adjustment/grant endpoint. */
@RequireRole('ops_admin', 'super_admin')
@ExactRoleRead()
@Controller('cms/users/:id/assistant-credits')
export class CmsAssistantCreditsController {
  constructor(private readonly credits: CmsAssistantCreditsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  read(
    @CurrentActor() actor: AdminActor,
    @Param('id', new ZodValidationPipe(z.string().uuid())) id: string,
    @Query(new ZodValidationPipe(creditsQuery)) query: z.infer<typeof creditsQuery>,
  ) {
    return this.credits.read(id, query, actor.id);
  }
}

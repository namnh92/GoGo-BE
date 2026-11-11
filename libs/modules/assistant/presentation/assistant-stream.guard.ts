import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Actor } from '../../identity/domain/actor';
import { AssistantConversationsService } from '../application/assistant-conversations.service';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { uuid } from './dtos';

const UuidPipe = new ZodValidationPipe(uuid);

/** Authorize before Nest starts SSE: an async handler behind an interceptor
 * can still be awaiting the database when the transport commits its 200.
 * The stream service rechecks admission and live rows before buffer replay.
 */
@Injectable()
export class AssistantStreamGuard implements CanActivate {
  constructor(private readonly conversations: AssistantConversationsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      actor: Actor;
      params: { id: string; messageId: string };
    }>();
    // Guards run before parameter pipes; preserve the route's UUID errors.
    const id = UuidPipe.transform(request.params.id);
    const messageId = UuidPipe.transform(request.params.messageId);
    await this.conversations.requireAssistantMessage(request.actor, id, messageId);
    return true;
  }
}

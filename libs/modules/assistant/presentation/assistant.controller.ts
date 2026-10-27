import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  Sse,
  SseSignal,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import type { z } from 'zod';
import { AppError } from '../../shared/app-error';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { ManualIdempotency, idempotencyScope } from '../../shared/idempotency.interceptor';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, RateLimit } from '../../identity/presentation/decorators';
import { AssistantConversationsService } from '../application/assistant-conversations.service';
import { AssistantProposalsService } from '../application/assistant-proposals.service';
import { AssistantStreamService, type SseMessage } from '../application/assistant-stream.service';
import type { AssistantFeedbackReason } from '../domain/assistant.types';
import {
  confirmProposalBody,
  createConversationBody,
  feedbackBody,
  listConversationsQuery,
  listMessagesQuery,
  renameConversationBody,
  sendMessageBody,
  uuid,
} from './dtos';

const UuidPipe = new ZodValidationPipe(uuid);

function requireIdempotencyKey(key: string | undefined): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw AppError.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required', [
      { field: 'Idempotency-Key', code: 'required', message: 'expected [A-Za-z0-9_-]{8,128}' },
    ]);
  }
  return key;
}

/**
 * GoGo-BE#713 — GoGo AI, registered users only (the service refuses guests
 * with `403 USER_ONLY`). No business logic here: validation, then the use case.
 */
@Controller('assistant')
export class AssistantController {
  constructor(
    private readonly conversations: AssistantConversationsService,
    private readonly proposals: AssistantProposalsService,
    private readonly streams: AssistantStreamService,
  ) {}

  @Get('status')
  status(@CurrentActor() actor: Actor) {
    return this.conversations.status(actor);
  }

  @Get('conversations')
  list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listConversationsQuery))
    query: z.infer<typeof listConversationsQuery>,
  ) {
    return this.conversations.list(actor, query);
  }

  @RateLimit({
    action: 'assistant.conversations.create',
    limit: 20,
    windowSeconds: 60,
    keyBy: 'actor',
  })
  @Post('conversations')
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createConversationBody))
    body: z.infer<typeof createConversationBody>,
  ) {
    return this.conversations.create(actor, body);
  }

  @Get('conversations/:id')
  get(@CurrentActor() actor: Actor, @Param('id', UuidPipe) id: string) {
    return this.conversations.get(actor, id);
  }

  @Patch('conversations/:id')
  rename(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(renameConversationBody))
    body: z.infer<typeof renameConversationBody>,
  ) {
    return this.conversations.rename(actor, id, body.title);
  }

  @Delete('conversations/:id')
  @HttpCode(204)
  async remove(@CurrentActor() actor: Actor, @Param('id', UuidPipe) id: string): Promise<void> {
    await this.conversations.remove(actor, id);
  }

  @Get('conversations/:id/messages')
  messages(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Query(new ZodValidationPipe(listMessagesQuery)) query: z.infer<typeof listMessagesQuery>,
  ) {
    return this.conversations.messages(actor, id, query);
  }

  /**
   * 202 with both turns; the reply streams from the GET below. The replay
   * record completes inside the accepting transaction (`ManualIdempotency`),
   * so a replay neither repeats the turn nor spends allowance. This limiter
   * is only a flood net; the product limits (Q1) are counted in the service.
   */
  @ManualIdempotency()
  @RateLimit({ action: 'assistant.messages.send', limit: 30, windowSeconds: 60, keyBy: 'actor' })
  @Post('conversations/:id/messages')
  @HttpCode(202)
  async send(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Req() req: FastifyRequest & { actor?: Actor },
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(sendMessageBody)) body: z.infer<typeof sendMessageBody>,
  ) {
    const scope = idempotencyScope(req, requireIdempotencyKey(idempotencyKey));
    const result = await this.conversations.send(actor, id, body, scope);
    if (result.replay) {
      void reply.status(result.status);
      void reply.header('x-idempotent-replay', 'true');
    }
    return result.body;
  }

  @RateLimit({ action: 'assistant.stream', limit: 60, windowSeconds: 60, keyBy: 'actor' })
  @Sse('conversations/:id/messages/:messageId/stream')
  stream(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Param('messageId', UuidPipe) messageId: string,
    @Headers('last-event-id') headerId: string | undefined,
    @Query('lastEventId') queryId: string | undefined,
    @SseSignal() signal: AbortSignal,
  ): Promise<Observable<SseMessage>> {
    return this.streams.stream(actor, id, messageId, headerId ?? queryId ?? null, signal);
  }

  @Post('conversations/:id/messages/:messageId/stop')
  @HttpCode(200)
  stop(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Param('messageId', UuidPipe) messageId: string,
  ) {
    return this.conversations.stop(actor, id, messageId);
  }

  @Put('conversations/:id/messages/:messageId/feedback')
  setFeedback(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Param('messageId', UuidPipe) messageId: string,
    @Body(new ZodValidationPipe(feedbackBody)) body: z.infer<typeof feedbackBody>,
  ) {
    return this.conversations.setFeedback(actor, id, messageId, {
      rating: body.rating,
      reason: body.reason as AssistantFeedbackReason | undefined,
    });
  }

  @Delete('conversations/:id/messages/:messageId/feedback')
  @HttpCode(204)
  async clearFeedback(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Param('messageId', UuidPipe) messageId: string,
  ): Promise<void> {
    await this.conversations.clearFeedback(actor, id, messageId);
  }

  @Get('proposals/:proposalId')
  proposal(@CurrentActor() actor: Actor, @Param('proposalId', UuidPipe) proposalId: string) {
    return this.proposals.get(actor, proposalId);
  }

  /** The only assistant write; replay via the global idempotency interceptor. */
  @RateLimit({
    action: 'assistant.proposals.confirm',
    limit: 20,
    windowSeconds: 60,
    keyBy: 'actor',
  })
  @Post('proposals/:proposalId/confirm')
  @HttpCode(200)
  confirm(
    @CurrentActor() actor: Actor,
    @Param('proposalId', UuidPipe) proposalId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(confirmProposalBody)) body: z.infer<typeof confirmProposalBody>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    return this.proposals.confirm(actor, proposalId, body.values);
  }

  @Post('proposals/:proposalId/dismiss')
  @HttpCode(200)
  dismiss(@CurrentActor() actor: Actor, @Param('proposalId', UuidPipe) proposalId: string) {
    return this.proposals.dismiss(actor, proposalId);
  }
}

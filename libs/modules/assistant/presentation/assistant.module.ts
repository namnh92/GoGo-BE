import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import IORedis from 'ioredis';
import {
  ASSISTANT_LLM,
  OpenRouterAssistantLlmAdapter,
  OpenRouterDecisionProvider,
} from '@gogo/providers';
import { APP_CONFIG } from '../../shared/config';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { SearchModule } from '../../search/presentation/search.module';
import { PlansModule } from '../../plans/presentation/plans.module';
import { RoomsModule } from '../../rooms/presentation/rooms.module';
import { SuggestionsModule } from '../../suggestions/presentation/suggestions.module';
import { AdministrativeModule } from '../../administrative/presentation/administrative.module';
import {
  ASSISTANT_DECISION_PROVIDER,
  ASSISTANT_INSTANCE_ID,
  type AssistantConfig,
} from '../application/assistant.config';
import { AssistantAvailabilityService } from '../application/assistant-availability.service';
import { AssistantConversationsService } from '../application/assistant-conversations.service';
import { AssistantFeedbackQueueService } from '../application/assistant-feedback-queue.service';
import { AssistantOrchestrator } from '../application/assistant-orchestrator.service';
import { AssistantProposalsService } from '../application/assistant-proposals.service';
import { AssistantStreamService } from '../application/assistant-stream.service';
import { AssistantTurnRunner } from '../application/assistant-turn-runner.service';
import { AssistantAreaResolver } from '../application/area-resolver.service';
import { AssistantCardHydrator } from '../application/card-hydrator.service';
import { GuideDocumentsService } from '../application/guide-documents.service';
import { AssistantTaxonomyService } from '../application/taxonomy.service';
import { AssistantRepository } from '../infrastructure/assistant.repository';
import {
  ASSISTANT_FRAME_BUFFER,
  InMemoryFrameBuffer,
  RedisFrameBuffer,
  BUFFER_COMMAND_TIMEOUT_MS,
} from '../infrastructure/frame-buffer';
import { AssistantController } from './assistant.controller';
import {
  AssistantDocumentsCmsController,
  AssistantFeedbackCmsController,
  AssistantGuideCoverageCmsController,
} from './assistant-cms.controller';

type BufferConfig = { NODE_ENV: string; REDIS_URL?: string };

/**
 * GoGo-BE#713 — GoGo AI (ADR-0036). One OpenRouter key per model (GoGo-BE#731,
 * ADR-0036 §9): Jev on the Decisions API with `OPENROUTER_API_KEY` (OpenRouter
 * direct billing), Haiku on Chat Completions with `OPENROUTER_ASSISTANT_API_KEY`
 * (Anthropic BYOK). Without its key a model's binding is absent, readiness
 * needs both, and the assistant refuses sends; there is no fake.
 */
@Module({
  imports: [
    IdentityModule,
    SearchModule,
    PlansModule,
    RoomsModule,
    SuggestionsModule,
    AdministrativeModule,
  ],
  controllers: [
    AssistantController,
    AssistantDocumentsCmsController,
    AssistantFeedbackCmsController,
    AssistantGuideCoverageCmsController,
  ],
  providers: [
    AssistantRepository,
    AssistantTaxonomyService,
    AssistantAvailabilityService,
    AssistantAreaResolver,
    AssistantCardHydrator,
    GuideDocumentsService,
    AssistantOrchestrator,
    AssistantTurnRunner,
    AssistantConversationsService,
    AssistantStreamService,
    AssistantProposalsService,
    AssistantFeedbackQueueService,
    {
      provide: ASSISTANT_INSTANCE_ID,
      useFactory: () => `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    },
    {
      provide: ASSISTANT_FRAME_BUFFER,
      useFactory: (config: BufferConfig) => {
        if (!config.REDIS_URL || config.NODE_ENV === 'test') return new InMemoryFrameBuffer();
        // S-F-03: a buffer write must never land long after it was issued —
        // a purge's tombstone outlives it only for a bounded time. So no
        // offline queue (a command waiting for a reconnect could be sent hours
        // later) and a command timeout; a refused write is a hole the reader
        // fills from the row.
        const redis = new IORedis(config.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          commandTimeout: BUFFER_COMMAND_TIMEOUT_MS,
        });
        redis.on('error', () => undefined);
        void redis.connect().catch(() => undefined);
        return new RedisFrameBuffer(redis);
      },
      inject: [APP_CONFIG],
    },
    {
      provide: ASSISTANT_DECISION_PROVIDER,
      useFactory: (config: AssistantConfig) =>
        // GoGo-BE#731: Jev has its own key (gogo_be_<env>); the BYOK key is Haiku's.
        config.OPENROUTER_API_KEY
          ? new OpenRouterDecisionProvider({
              apiKey: config.OPENROUTER_API_KEY,
              model: config.ASSISTANT_JEV_MODEL,
              timeoutMs: config.ASSISTANT_JEV_TIMEOUT_MS,
            })
          : null,
      inject: [APP_CONFIG],
    },
    {
      provide: ASSISTANT_LLM,
      useFactory: (config: AssistantConfig) =>
        config.OPENROUTER_ASSISTANT_API_KEY
          ? new OpenRouterAssistantLlmAdapter({
              apiKey: config.OPENROUTER_ASSISTANT_API_KEY,
              model: config.ASSISTANT_HAIKU_MODEL,
            })
          : null,
      inject: [APP_CONFIG],
    },
  ],
  exports: [GuideDocumentsService],
})
export class AssistantModule {}

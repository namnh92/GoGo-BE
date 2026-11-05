import { Module } from '@nestjs/common';
import { NoopMetrics, RUNTIME_METRICS, type MetricsPort } from '@gogo/observability';
import { IdentityModule } from '../../identity/presentation/identity.module';
import {
  RATE_LIMIT_REDIS,
  type RateLimitRedis,
} from '../../identity/presentation/rate-limit-redis';
import { PlansModule } from '../../plans/presentation/plans.module';
import { RoomsModule } from '../../rooms/presentation/rooms.module';
import { ExperimentsService } from '../application/experiments.service';
import { SuggestionService } from '../application/suggestion.service';
import { ROUTING_RESERVATION } from '../application/routing-reservation';
import { RedisRoutingReservation } from '../infrastructure/redis-routing-reservation';
import { SuggestionsRepository } from '../infrastructure/suggestions.repository';
import { SuggestionsController } from './suggestions.controller';

@Module({
  imports: [IdentityModule, RoomsModule, PlansModule],
  controllers: [SuggestionsController],
  providers: [
    SuggestionsRepository,
    ExperimentsService,
    {
      provide: ROUTING_RESERVATION,
      useFactory: (redis: RateLimitRedis | null, metrics?: MetricsPort) =>
        new RedisRoutingReservation(redis, metrics ?? new NoopMetrics()),
      inject: [RATE_LIMIT_REDIS, { token: RUNTIME_METRICS, optional: true }],
    },
    SuggestionService,
  ],
  exports: [SuggestionService, ExperimentsService, SuggestionsRepository],
})
export class SuggestionsModule {}

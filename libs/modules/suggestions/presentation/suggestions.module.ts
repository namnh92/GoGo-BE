import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { PlansModule } from '../../plans/presentation/plans.module';
import { RoomsModule } from '../../rooms/presentation/rooms.module';
import { SuggestionService } from '../application/suggestion.service';
import { SuggestionsRepository } from '../infrastructure/suggestions.repository';
import { SuggestionsController } from './suggestions.controller';
import { ROUTES_ENABLED, TravelTimeService } from '../application/travel-time.service';
import { APP_CONFIG } from '../../shared/config';

/** ADR-0007: the flag lives in config; the service only needs the boolean. */
const ROUTES_ENABLED_PROVIDER = {
  provide: ROUTES_ENABLED,
  useFactory: (config: { FLAG_ROUTES_API?: boolean }) => config.FLAG_ROUTES_API ?? false,
  inject: [APP_CONFIG],
};

@Module({
  imports: [IdentityModule, RoomsModule, PlansModule],
  controllers: [SuggestionsController],
  providers: [SuggestionsRepository, SuggestionService, TravelTimeService, ROUTES_ENABLED_PROVIDER],
  exports: [SuggestionService, TravelTimeService],
})
export class SuggestionsModule {}

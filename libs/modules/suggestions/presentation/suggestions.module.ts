import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { PlansModule } from '../../plans/presentation/plans.module';
import { RoomsModule } from '../../rooms/presentation/rooms.module';
import { SuggestionService } from '../application/suggestion.service';
import { SuggestionsRepository } from '../infrastructure/suggestions.repository';
import { SuggestionsController } from './suggestions.controller';

@Module({
  imports: [IdentityModule, RoomsModule, PlansModule],
  controllers: [SuggestionsController],
  providers: [SuggestionsRepository, SuggestionService],
  exports: [SuggestionService],
})
export class SuggestionsModule {}

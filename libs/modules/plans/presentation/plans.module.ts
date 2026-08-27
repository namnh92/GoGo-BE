import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { RoomsModule } from '../../rooms/presentation/rooms.module';
import { SuggestionsRepository } from '../../suggestions/infrastructure/suggestions.repository';
import { PlanBuilderService } from '../application/plan-builder.service';
import { PlansService } from '../application/plans.service';
import { PlansRepository } from '../infrastructure/plans.repository';
import { PlansController } from './plans.controller';

@Module({
  imports: [IdentityModule, RoomsModule],
  controllers: [PlansController],
  providers: [PlansRepository, SuggestionsRepository, PlanBuilderService, PlansService],
  exports: [PlansRepository, PlanBuilderService, PlansService],
})
export class PlansModule {}

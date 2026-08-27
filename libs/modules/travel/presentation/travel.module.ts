import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../shared/config';
import { ROUTES_ENABLED, TravelTimeService } from '../application/travel-time.service';

/**
 * ADR-0007 — travel time is a shared capability, not a suggestion concern.
 *
 * It lives in its own module because both the plan builder and (later) any
 * routing-aware feature need it, while `SuggestionsModule` already imports
 * `PlansModule`: hanging it off suggestions would have closed a module cycle.
 */
@Global()
@Module({
  providers: [
    TravelTimeService,
    {
      provide: ROUTES_ENABLED,
      useFactory: (config: { FLAG_ROUTES_API?: boolean }) => config.FLAG_ROUTES_API ?? false,
      inject: [APP_CONFIG],
    },
  ],
  exports: [TravelTimeService],
})
export class TravelModule {}

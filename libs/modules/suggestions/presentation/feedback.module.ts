import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../shared/config';
import { AI_FEEDBACK_ENABLED, FeedbackService } from '../application/feedback.service';

type FeedbackConfig = { FLAG_AI_FEEDBACK?: boolean };

/**
 * Global, and separate from `SuggestionsModule`, because plans consume the
 * feedback parser while suggestions already imports plans — hanging this off
 * suggestions would close the module cycle that crashed the app at boot when
 * travel-time briefly lived there.
 */
@Global()
@Module({
  providers: [
    FeedbackService,
    {
      provide: AI_FEEDBACK_ENABLED,
      // Default off. The AI guardrails require a kill switch and a privacy
      // review before a real provider is enabled (SK-SEC gate, #48); until
      // then the deterministic parser does the work.
      useFactory: (config: FeedbackConfig) => config.FLAG_AI_FEEDBACK === true,
      inject: [APP_CONFIG],
    },
  ],
  exports: [FeedbackService],
})
export class FeedbackModule {}

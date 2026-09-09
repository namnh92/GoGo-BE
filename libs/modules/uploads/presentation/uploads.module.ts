import { Global, Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { APP_CONFIG } from '../../shared/config';
import { MEDIA_UPLOADS_CONFIGURED } from '../application/tokens';
import { UploadsService } from '../application/uploads.service';
import { UploadsController } from './uploads.controller';

type UploadsConfig = { R2_ACCESS_KEY_ID?: string; R2_BUCKET?: string; NODE_ENV: string };

/**
 * Global so the writes that consume upload keys (check-in today) can claim
 * them without importing the endpoint module.
 */
@Global()
@Module({
  imports: [IdentityModule],
  controllers: [UploadsController],
  providers: [
    UploadsService,
    {
      provide: MEDIA_UPLOADS_CONFIGURED,
      // In test the fake storage adapter stands in, so the flow is exercisable
      // end to end without credentials. In every other environment, no bucket
      // means the endpoint says so rather than handing out a dead URL.
      useFactory: (config: UploadsConfig) =>
        config.NODE_ENV === 'test' || Boolean(config.R2_ACCESS_KEY_ID && config.R2_BUCKET),
      inject: [APP_CONFIG],
    },
  ],
  exports: [UploadsService, MEDIA_UPLOADS_CONFIGURED],
})
export class UploadsModule {}

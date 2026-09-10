import { Global, Module } from '@nestjs/common';
import { resolveR2AccountId } from '@gogo/providers';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { APP_CONFIG } from '../../shared/config';
import { AVATAR_STORAGE_CONFIGURED, MEDIA_UPLOADS_CONFIGURED } from '../application/tokens';
import { UploadsService } from '../application/uploads.service';
import { UploadsController } from './uploads.controller';

type UploadsConfig = {
  R2_ACCESS_KEY_ID?: string;
  R2_BUCKET?: string;
  R2_ACCOUNT_ID?: string;
  R2_ENDPOINT?: string;
  R2_PUBLIC_BUCKET?: string;
  R2_PUBLIC_ACCESS_KEY_ID?: string;
  R2_PUBLIC_SECRET_ACCESS_KEY?: string;
  MEDIA_PUBLIC_BASE_URL?: string;
  NODE_ENV: string;
};

/**
 * GoGo-BE#548 — the account id counts as configuration. Without it the adapter
 * signs for `.r2.cloudflarestorage.com`, so `POST /uploads` would answer 200
 * with a URL that cannot resolve; saying "not configured" is the truth.
 */
const privateConfigured = (config: UploadsConfig) =>
  config.NODE_ENV === 'test' ||
  Boolean(
    config.R2_ACCESS_KEY_ID &&
    config.R2_BUCKET &&
    resolveR2AccountId({ accountId: config.R2_ACCOUNT_ID, endpoint: config.R2_ENDPOINT }),
  );

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
      useFactory: privateConfigured,
      inject: [APP_CONFIG],
    },
    {
      // An avatar needs both buckets and somewhere to serve from; the fakes
      // stand in under test so the pipeline runs end to end without either.
      provide: AVATAR_STORAGE_CONFIGURED,
      useFactory: (config: UploadsConfig) =>
        config.NODE_ENV === 'test' ||
        (privateConfigured(config) &&
          Boolean(
            config.R2_PUBLIC_BUCKET &&
            config.R2_PUBLIC_ACCESS_KEY_ID &&
            config.R2_PUBLIC_SECRET_ACCESS_KEY &&
            config.MEDIA_PUBLIC_BASE_URL,
          )),
      inject: [APP_CONFIG],
    },
  ],
  exports: [UploadsService, MEDIA_UPLOADS_CONFIGURED, AVATAR_STORAGE_CONFIGURED],
})
export class UploadsModule {}

import { Module } from '@nestjs/common';
import type { Db } from '@gogo/database';
import {
  CACHE_PURGE,
  PUBLIC_STORAGE_PROVIDER,
  STORAGE_PROVIDER,
  type CachePurgePort,
  type StoragePort,
} from '@gogo/providers';
import { METRICS, type MetricsPort } from '@gogo/observability';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { APP_CONFIG, type MediaConfig } from '../../shared/config';
import { DB } from '../../shared/tokens';
import { AvatarService } from '../application/avatar.service';
import { MediaCleanupService } from '../application/media-cleanup.service';
import { ProfileService } from '../application/profile.service';
import { ProfileController } from './profile.controller';

/**
 * ADR-0022 — one module owns the profile: its columns, its interests, `/me`,
 * the avatar pipeline and the cleanup queue that pipeline writes to.
 */
@Module({
  imports: [IdentityModule],
  controllers: [ProfileController],
  providers: [
    ProfileService,
    AvatarService,
    {
      // Plain class, built here for the API and by hand in the worker, so
      // both processes retry the same queue with the same rules.
      provide: MediaCleanupService,
      useFactory: (
        db: Db,
        privateStorage: StoragePort,
        publicStorage: StoragePort,
        purge: CachePurgePort,
        config: MediaConfig,
        metrics?: MetricsPort,
      ) =>
        new MediaCleanupService(
          db,
          { private: privateStorage, public: publicStorage },
          purge,
          config.MEDIA_PUBLIC_BASE_URL,
          metrics,
        ),
      inject: [
        DB,
        STORAGE_PROVIDER,
        PUBLIC_STORAGE_PROVIDER,
        CACHE_PURGE,
        APP_CONFIG,
        { token: METRICS, optional: true },
      ],
    },
  ],
  exports: [ProfileService, AvatarService, MediaCleanupService],
})
export class ProfileModule {}

import { Module } from '@nestjs/common';
import type { Db } from '@gogo/database';
import { PRIVACY_EXPORT_STORAGE, type StoragePort } from '@gogo/providers';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { APP_CONFIG, type PrivacyExportConfig } from '../../shared/config';
import { slaConfigFrom } from '../../shared/privacy-ledger';
import { DB } from '../../shared/tokens';
import { parseExportKeyring } from '../domain/export-envelope';
import {
  PRIVACY_EXPORT_OPTIONS,
  PrivacyExportService,
  type PrivacyExportOptions,
} from '../application/privacy-export.service';
import { PrivacyExportsController } from './privacy-exports.controller';

/**
 * GoGo-BE#256, ADR-0032 — secure export delivery. Exported so the CMS can
 * issue an export for a ledger request without a second implementation.
 */
@Module({
  imports: [IdentityModule],
  controllers: [PrivacyExportsController],
  providers: [
    {
      provide: PRIVACY_EXPORT_OPTIONS,
      useFactory: (config: PrivacyExportConfig): PrivacyExportOptions => ({
        keyring: parseExportKeyring(config.EXPORT_WRAPPING_KEYS),
        sla: slaConfigFrom(config.PRIVACY_SLA_JSON),
        retentionMonths: config.PRIVACY_RETENTION_MONTHS,
      }),
      inject: [APP_CONFIG],
    },
    {
      // Plain class, like the processor the worker builds by hand. The storage
      // is the fail-closed private bucket (PR #677 S-F-13): null means 503.
      provide: PrivacyExportService,
      useFactory: (db: Db, storage: StoragePort | null, options: PrivacyExportOptions) =>
        new PrivacyExportService(db, storage, options),
      inject: [DB, PRIVACY_EXPORT_STORAGE, PRIVACY_EXPORT_OPTIONS],
    },
  ],
  exports: [PrivacyExportService],
})
export class PrivacyExportsModule {}

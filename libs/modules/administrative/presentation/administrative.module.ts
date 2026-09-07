import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { AdministrativeImportService } from '../application/administrative-import.service';
import { AdministrativePublicationService } from '../application/administrative-publication.service';
import { AdministrativeResolverService } from '../application/administrative-resolver.service';
import { AdministrativeQueryService } from '../application/administrative-query.service';
import { AdministrativeValidationService } from '../application/administrative-validation.service';
import { ADMINISTRATIVE_DATASET } from '../application/administrative-dataset.port';
import {
  ADMINISTRATIVE_REPOSITORY,
  DrizzleAdministrativeRepository,
} from '../infrastructure/administrative.repository';
import { AdministrativeResolverRepository } from '../infrastructure/administrative-resolver.repository';
import { InProcessAdministrativeDatasetCache } from '../infrastructure/in-process-dataset.cache';
import { PinnedSnapshotReader } from '../application/pinned-snapshot.reader';
import { AdministrativeController } from './administrative.controller';
import { AdministrativeAdminController } from './administrative-admin.controller';

/**
 * ADM-003 (#456). The cache is bound to the port here and nowhere else, so
 * swapping the implementation later — which ADR-0019 §8 leaves open — touches
 * one file. `IdentityModule` is imported for the rate-limit guard, exactly as
 * the other public read modules do.
 *
 * ADM-005 (#458) added the staff controller. It carries `@RequireRole`, which
 * the globally registered `AdminGuard` reads — the guard lives in `CmsModule`
 * and needs no import here, exactly as the ingestion controllers rely on it.
 */
@Module({
  imports: [IdentityModule],
  controllers: [AdministrativeController, AdministrativeAdminController],
  providers: [
    // Registered rather than left to the service's default parameter: a TS
    // default is invisible to Nest, which sees a required token and refuses to
    // construct the module. The API failed to boot until this line existed.
    PinnedSnapshotReader,
    { provide: ADMINISTRATIVE_REPOSITORY, useClass: DrizzleAdministrativeRepository },
    { provide: ADMINISTRATIVE_DATASET, useClass: InProcessAdministrativeDatasetCache },
    AdministrativeQueryService,
    AdministrativeValidationService,
    AdministrativeImportService,
    AdministrativePublicationService,
    AdministrativeResolverRepository,
    AdministrativeResolverService,
  ],
  exports: [
    ADMINISTRATIVE_DATASET,
    AdministrativeQueryService,
    AdministrativeValidationService,
    AdministrativeImportService,
    AdministrativePublicationService,
    AdministrativeResolverRepository,
    AdministrativeResolverService,
  ],
})
export class AdministrativeModule {}

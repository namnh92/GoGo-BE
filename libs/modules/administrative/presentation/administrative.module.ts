import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { AdministrativeQueryService } from '../application/administrative-query.service';
import { AdministrativeValidationService } from '../application/administrative-validation.service';
import { ADMINISTRATIVE_DATASET } from '../application/administrative-dataset.port';
import {
  ADMINISTRATIVE_REPOSITORY,
  DrizzleAdministrativeRepository,
} from '../infrastructure/administrative.repository';
import { InProcessAdministrativeDatasetCache } from '../infrastructure/in-process-dataset.cache';
import { PinnedSnapshotReader } from '../application/pinned-snapshot.reader';
import { AdministrativeController } from './administrative.controller';

/**
 * ADM-003 (#456). The cache is bound to the port here and nowhere else, so
 * swapping the implementation later — which ADR-0019 §8 leaves open — touches
 * one file. `IdentityModule` is imported for the rate-limit guard, exactly as
 * the other public read modules do.
 */
@Module({
  imports: [IdentityModule],
  controllers: [AdministrativeController],
  providers: [
    // Registered rather than left to the service's default parameter: a TS
    // default is invisible to Nest, which sees a required token and refuses to
    // construct the module. The API failed to boot until this line existed.
    PinnedSnapshotReader,
    { provide: ADMINISTRATIVE_REPOSITORY, useClass: DrizzleAdministrativeRepository },
    { provide: ADMINISTRATIVE_DATASET, useClass: InProcessAdministrativeDatasetCache },
    AdministrativeQueryService,
    AdministrativeValidationService,
  ],
  exports: [ADMINISTRATIVE_DATASET, AdministrativeQueryService, AdministrativeValidationService],
})
export class AdministrativeModule {}

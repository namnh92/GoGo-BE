import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { AdministrativeQueryService } from '../application/administrative-query.service';
import { ADMINISTRATIVE_DATASET } from '../application/administrative-dataset.port';
import {
  ADMINISTRATIVE_REPOSITORY,
  DrizzleAdministrativeRepository,
} from '../infrastructure/administrative.repository';
import { InProcessAdministrativeDatasetCache } from '../infrastructure/in-process-dataset.cache';
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
    { provide: ADMINISTRATIVE_REPOSITORY, useClass: DrizzleAdministrativeRepository },
    { provide: ADMINISTRATIVE_DATASET, useClass: InProcessAdministrativeDatasetCache },
    AdministrativeQueryService,
  ],
  exports: [ADMINISTRATIVE_DATASET, AdministrativeQueryService],
})
export class AdministrativeModule {}

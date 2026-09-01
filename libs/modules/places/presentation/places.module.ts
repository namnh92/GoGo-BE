import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { IngestionModule } from '../../ingestion/presentation/ingestion.module';
import { PlaceImportService } from '../application/place-import.service';
import { AreasController } from './areas.controller';
import { PlaceImportController } from './place-import.controller';
import { TaxonomyController } from './taxonomy.controller';

@Module({
  // #334 — the legacy import path resolves and writes Google identity through
  // `PlaceDedupService`, so both doors read the same table.
  imports: [IdentityModule, IngestionModule],
  controllers: [TaxonomyController, PlaceImportController, AreasController],
  providers: [PlaceImportService],
  exports: [PlaceImportService],
})
export class PlacesModule {}

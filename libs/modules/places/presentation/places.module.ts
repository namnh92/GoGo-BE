import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { PlaceImportService } from '../application/place-import.service';
import { AreasController } from './areas.controller';
import { PlaceImportController } from './place-import.controller';
import { TaxonomyController } from './taxonomy.controller';

@Module({
  imports: [IdentityModule],
  controllers: [TaxonomyController, PlaceImportController, AreasController],
  providers: [PlaceImportService],
  exports: [PlaceImportService],
})
export class PlacesModule {}

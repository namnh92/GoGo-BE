import { Module } from '@nestjs/common';
import { PLACE_FACTS_READER } from '../../assistant/domain/place-qa/place-facts';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { ProviderPhotosService } from '../application/provider-photos.service';
import { SearchService } from '../application/search.service';
import { SearchRepository } from '../infrastructure/search.repository';
import { ProviderPhotosController } from './provider-photos.controller';
import { SearchController } from './search.controller';

@Module({
  imports: [IdentityModule],
  controllers: [SearchController, ProviderPhotosController],
  providers: [
    SearchRepository,
    SearchService,
    ProviderPhotosService,
    // #857/S2: the SQL projection behind S1's reader port. One instance, no second seam.
    { provide: PLACE_FACTS_READER, useExisting: SearchService },
  ],
  exports: [SearchRepository, SearchService, ProviderPhotosService, PLACE_FACTS_READER],
})
export class SearchModule {}

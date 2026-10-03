import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { ProviderPhotosService } from '../application/provider-photos.service';
import { SearchService } from '../application/search.service';
import { SearchRepository } from '../infrastructure/search.repository';
import { ProviderPhotosController } from './provider-photos.controller';
import { SearchController } from './search.controller';

@Module({
  imports: [IdentityModule],
  controllers: [SearchController, ProviderPhotosController],
  providers: [SearchRepository, SearchService, ProviderPhotosService],
  exports: [SearchRepository, SearchService],
})
export class SearchModule {}

import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { SearchService } from '../application/search.service';
import { SearchRepository } from '../infrastructure/search.repository';
import { SearchController } from './search.controller';

@Module({
  imports: [IdentityModule],
  controllers: [SearchController],
  providers: [SearchRepository, SearchService],
  exports: [SearchRepository, SearchService],
})
export class SearchModule {}

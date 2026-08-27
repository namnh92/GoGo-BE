import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { TaxonomyController } from './taxonomy.controller';

@Module({
  imports: [IdentityModule],
  controllers: [TaxonomyController],
})
export class PlacesModule {}

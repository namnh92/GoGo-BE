import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { ProfileService } from '../application/profile.service';
import { ProfileController } from './profile.controller';

/** ADR-0022 — one module owns the profile: its columns, its interests, `/me`. */
@Module({
  imports: [IdentityModule],
  controllers: [ProfileController],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}

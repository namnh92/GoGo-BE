import { Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/presentation/identity.module';
import { RoomsModule } from '../../rooms/presentation/rooms.module';
import { PreferencesService } from '../application/preferences.service';
import { PreferencesController } from './preferences.controller';

@Module({
  imports: [IdentityModule, RoomsModule],
  controllers: [PreferencesController],
  providers: [PreferencesService],
})
export class PreferencesModule {}

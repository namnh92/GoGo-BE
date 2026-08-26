import { Controller, Get } from '@nestjs/common';
import { Public } from '@gogo/modules';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

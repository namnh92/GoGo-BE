import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

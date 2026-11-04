import { Body, Controller, Delete, Headers, HttpCode, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Public, RateLimit } from '../../identity/presentation/decorators';
import { PushDeviceIdentityService } from '../application/push-device-identity.service';

const deviceSubscriptionSchema = z.object({
  platform: z.enum(['ios', 'android', 'web']),
  subscriptionId: z.string().min(1).max(64),
  promotionsEnabled: z.boolean(),
  preferenceVersion: z.number().int().min(0).max(2_147_483_647),
});

/**
 * NTF-BE-017 (#747), ADR-0038 — a device with no session. Public at the session
 * level; every call but creation carries `Authorization: Device <id>.<secret>`,
 * which the service checks. Creation is limited like a login, plus a global
 * ceiling in the service.
 */
@Public()
@Controller('notifications')
export class PushDeviceController {
  constructor(private readonly devices: PushDeviceIdentityService) {}

  @RateLimit({ action: 'notifications.device.create', limit: 5, windowSeconds: 60, keyBy: 'ip' })
  @Post('identity/device')
  create() {
    return this.devices.create();
  }

  @RateLimit({ action: 'notifications.device', limit: 30, windowSeconds: 60, keyBy: 'ip' })
  @HttpCode(200)
  @Post('identity/device/token')
  token(@Headers('authorization') authorization: string | undefined) {
    return this.devices.token(authorization);
  }

  @RateLimit({ action: 'notifications.device', limit: 30, windowSeconds: 60, keyBy: 'ip' })
  @HttpCode(204)
  @Delete('identity/device')
  retire(@Headers('authorization') authorization: string | undefined) {
    return this.devices.retire(authorization);
  }

  @RateLimit({ action: 'notifications.device', limit: 30, windowSeconds: 60, keyBy: 'ip' })
  @Put('device-subscriptions')
  report(
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodValidationPipe(deviceSubscriptionSchema))
    body: z.infer<typeof deviceSubscriptionSchema>,
  ) {
    return this.devices.report(authorization, body);
  }
}

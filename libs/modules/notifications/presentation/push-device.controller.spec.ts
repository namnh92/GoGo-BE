import { describe, expect, it } from 'vitest';
import {
  IS_PUBLIC_KEY,
  RATE_LIMIT_KEY,
  type RateLimitSpec,
} from '../../identity/presentation/decorators';
import { PushDeviceController } from './push-device.controller';

const spec = (handler: keyof PushDeviceController) =>
  Reflect.getMetadata(RATE_LIMIT_KEY, PushDeviceController.prototype[handler]) as RateLimitSpec;

describe('PushDeviceController (NTF-BE-017)', () => {
  it('is public at the session level, so the device credential is the only bearer', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, PushDeviceController)).toBe(true);
  });

  it('limits creation per IP exactly as a login', () => {
    expect(spec('create')).toMatchObject({ limit: 5, windowSeconds: 60, keyBy: 'ip' });
  });

  it('limits every other route per IP', () => {
    for (const handler of ['token', 'retire', 'report'] as const) {
      expect(spec(handler).keyBy, handler).toBe('ip');
    }
  });
});

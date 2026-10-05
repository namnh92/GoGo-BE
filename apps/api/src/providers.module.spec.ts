import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { UserContentService } from '@gogo/modules';
import { FakeStorage, PRIVACY_EXPORT_STORAGE, STORAGE_PROVIDER } from '@gogo/providers';
import { ProvidersModule } from './providers.module';
import type { AppConfig } from './config/env';

type FactoryProvider = {
  provide: unknown;
  useFactory?: (...args: unknown[]) => unknown;
  inject?: unknown[];
};

function provider(token: symbol): FactoryProvider {
  const providers = Reflect.getMetadata('providers', ProvidersModule) as FactoryProvider[];
  const found = providers.find((p) => p.provide === token);
  if (!found) throw new Error(`${String(token)} is not provided by ProvidersModule`);
  return found;
}

/**
 * PR #677 S-F-13 — the wiring, not just the helper: the API binds a fail-closed
 * private bucket for the privacy module, and account deletion reads that
 * token. Without it an instance booted without R2 credentials would confirm
 * export deletions against the in-memory fake and strand the real objects.
 */
describe('PRIVACY_EXPORT_STORAGE (GoGo-BE#256, PR #677 S-F-13)', () => {
  it('is null in a non-test environment without the private bucket', () => {
    const bound = provider(PRIVACY_EXPORT_STORAGE);
    expect(bound.inject).toContain(STORAGE_PROVIDER);
    const config = {
      NODE_ENV: 'production',
      R2_ACCESS_KEY_ID: '',
      R2_SECRET_ACCESS_KEY: '',
      R2_BUCKET: '',
    } as AppConfig;
    expect(bound.useFactory!(config, new FakeStorage())).toBeNull();
  });

  it('is the shared general storage under test and when R2 is configured', () => {
    const bound = provider(PRIVACY_EXPORT_STORAGE);
    const general = new FakeStorage();
    expect(bound.useFactory!({ NODE_ENV: 'test' } as AppConfig, general)).toBe(general);
    expect(
      bound.useFactory!(
        {
          NODE_ENV: 'production',
          R2_ACCESS_KEY_ID: 'k',
          R2_SECRET_ACCESS_KEY: 's',
          R2_BUCKET: 'b',
        } as AppConfig,
        general,
      ),
    ).toBe(general);
  });

  it('is exported, and is what account deletion injects for export cleanup', () => {
    const exported = Reflect.getMetadata('exports', ProvidersModule) as unknown[];
    expect(exported).toContain(PRIVACY_EXPORT_STORAGE);
    const injected = Reflect.getMetadata('self:paramtypes', UserContentService) as {
      index: number;
      param: unknown;
    }[];
    expect(injected.map((p) => p.param)).toContain(PRIVACY_EXPORT_STORAGE);
    expect(injected.map((p) => p.param)).not.toContain(STORAGE_PROVIDER);
  });
});

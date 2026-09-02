import { describe, expect, it } from 'vitest';
import { COST_REGISTRY } from '../domain/registry';
import { AdapterRegistryError, CostAdapterRegistry } from './adapter-registry';
import type { UsageCollector, UsageSample } from './collectors.port';

function collector(providerId: string, serviceId: string): UsageCollector {
  return {
    providerId,
    serviceId,
    collectUsage: async (): Promise<UsageSample[]> => [],
  };
}

describe('cost adapter registry (epic §7)', () => {
  it('accepts a usage collector for a provider that declares USAGE_COLLECTOR', () => {
    const registry = new CostAdapterRegistry(COST_REGISTRY);
    registry.registerUsageCollector(collector('google', 'google.places'));
    expect(registry.usageCollectors().map((c) => c.serviceId)).toEqual(['google.places']);
  });

  it('refuses a collector for a capability the provider does not declare', () => {
    const registry = new CostAdapterRegistry(COST_REGISTRY);
    expect(() =>
      registry.registerActualCostCollector({
        providerId: 'google',
        collectActualCost: async () => [],
      }),
    ).toThrow(AdapterRegistryError);
    // A planned provider declares nothing yet.
    expect(() => registry.registerUsageCollector(collector('upstash', 'upstash.redis'))).toThrow(
      /does not declare USAGE_COLLECTOR/,
    );
  });

  it('refuses an unknown provider, and a service filed under another provider', () => {
    const registry = new CostAdapterRegistry(COST_REGISTRY);
    expect(() => registry.registerUsageCollector(collector('vietmap', 'vietmap.search'))).toThrow(
      /unknown provider/,
    );
    expect(() => registry.registerUsageCollector(collector('google', 'upstash.redis'))).toThrow(
      /does not belong to google/,
    );
  });

  it('exposes nothing for capabilities nobody wired', () => {
    const registry = new CostAdapterRegistry(COST_REGISTRY);
    expect(registry.actualCostCollectors()).toEqual([]);
    expect(registry.quotaCollectors()).toEqual([]);
    expect(registry.fixedCostProviders()).toEqual([]);
    expect(registry.costEstimator()).toBeNull();
  });
});

import type { Capability } from '../domain/capabilities';
import type { CostRegistry } from '../domain/registry';
import type {
  ActualCostCollector,
  CostEstimator,
  FixedCostProvider,
  QuotaCollector,
  UsageCollector,
} from './collectors.port';

/**
 * COST-BE-015 (#367) — epic §7 "preferred" shape:
 *
 *     registry.registerUsageCollector(...)
 *     registry.registerActualCostCollector(...)
 *
 * Where the definitions registry says what a provider *is*, this one holds
 * what is *wired* for it in the running process. Registering an adapter for
 * a provider the definitions do not know, or for a capability the provider
 * does not declare, is refused at registration — the two registries cannot
 * disagree silently, and a generic scheduler (COST-BE-017) can trust
 * `usageCollectors()` to be exactly the providers that declared
 * `USAGE_COLLECTOR`.
 */
export class AdapterRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterRegistryError';
  }
}

export class CostAdapterRegistry {
  private readonly usage: UsageCollector[] = [];
  private readonly actual: ActualCostCollector[] = [];
  private readonly quota: QuotaCollector[] = [];
  private readonly fixed: FixedCostProvider[] = [];
  private estimator: CostEstimator | null = null;

  constructor(private readonly definitions: CostRegistry) {}

  private require(providerId: string, capability: Capability): void {
    if (this.definitions.provider(providerId) === null) {
      throw new AdapterRegistryError(`unknown provider ${providerId}`);
    }
    if (!this.definitions.hasCapability(providerId, capability)) {
      throw new AdapterRegistryError(`${providerId} does not declare ${capability}`);
    }
  }

  registerUsageCollector(collector: UsageCollector): this {
    this.require(collector.providerId, 'USAGE_COLLECTOR');
    if (this.definitions.service(collector.serviceId)?.providerId !== collector.providerId) {
      throw new AdapterRegistryError(
        `service ${collector.serviceId} does not belong to ${collector.providerId}`,
      );
    }
    this.usage.push(collector);
    return this;
  }

  registerActualCostCollector(collector: ActualCostCollector): this {
    this.require(collector.providerId, 'ACTUAL_COST_COLLECTOR');
    this.actual.push(collector);
    return this;
  }

  registerQuotaCollector(collector: QuotaCollector): this {
    this.require(collector.providerId, 'QUOTA');
    this.quota.push(collector);
    return this;
  }

  registerFixedCostProvider(provider: FixedCostProvider): this {
    this.require(provider.providerId, 'FIXED_COST');
    this.fixed.push(provider);
    return this;
  }

  /** One estimator for everyone: it is generic by construction (epic §13). */
  registerCostEstimator(estimator: CostEstimator): this {
    this.estimator = estimator;
    return this;
  }

  usageCollectors(): readonly UsageCollector[] {
    return this.usage;
  }

  actualCostCollectors(): readonly ActualCostCollector[] {
    return this.actual;
  }

  quotaCollectors(): readonly QuotaCollector[] {
    return this.quota;
  }

  fixedCostProviders(): readonly FixedCostProvider[] {
    return this.fixed;
  }

  costEstimator(): CostEstimator | null {
    return this.estimator;
  }
}

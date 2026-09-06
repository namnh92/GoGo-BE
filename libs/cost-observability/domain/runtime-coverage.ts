import type { RuntimeStateReader } from '@gogo/observability';
import type { RuntimeSurface, ServiceDefinition } from './registry';

/**
 * ADR-0014 — runtime coverage, the one of the four `/monitoring` dimensions
 * that says whether GoGo *measures* a provider's runtime: calls, latency,
 * errors. It is computed from two registry facts and nothing else — each
 * service's declared `runtime` surface and each operation's `instrumented`
 * flag — so it never changes because a collector ran, a fee was typed in, or
 * a provider's registry status moved. Those are the other three dimensions.
 *
 * - `FULL`: every operation on every service with a runtime surface emits a
 *   metric.
 * - `PARTIAL`: some do. Google today: Places, Routes and Sheets are measured,
 *   the two Maps SDKs are not — so Google is PARTIAL, not "instrumented".
 * - `NOT_INSTRUMENTED`: a runtime surface exists and nothing on it emits a
 *   metric — the one state worth an operator's attention. Redis, Postgres and
 *   R2 until #414.
 * - `N/A`: no runtime surface at all. A bill, a CI runner, a fee, a provider
 *   nothing is wired to yet. Not a gap and not a zero.
 *
 * A provider is never binary: the counts say how much of it is covered and
 * the service rows say which parts, so a console can drill down instead of
 * reading one word for five services.
 */
export const RUNTIME_COVERAGES = ['FULL', 'PARTIAL', 'NOT_INSTRUMENTED', 'N/A'] as const;
export type RuntimeCoverage = (typeof RUNTIME_COVERAGES)[number];

export type OperationCount = { instrumented: number; total: number };

export type ServiceRuntime = {
  surface: RuntimeSurface;
  coverage: RuntimeCoverage;
  /** `total: 0` with a surface is NOT_INSTRUMENTED: nothing registered to measure yet. */
  operations: OperationCount;
  /**
   * #427 — how this process's one boot-time connect for the service ended,
   * when the service declares a `bootstrap` operation and this process ran
   * it. `null` otherwise. A failure here is fail-open, not an outage: it
   * moves neither `coverage` nor the provider's status.
   */
  connection?: RuntimeConnection | null;
};

export type RuntimeConnectionStatus = 'ok' | 'unavailable' | 'timeout';

export type RuntimeConnection = {
  operation: string;
  status: RuntimeConnectionStatus;
  observedAt: string;
};

/**
 * The service's bootstrap operation read from the process's runtime state.
 * `error` is not something a connect records, but a reader that only knows
 * the closed set folds it to `unavailable` rather than dropping the row.
 */
export function bootstrapConnection(
  service: Pick<ServiceDefinition, 'operations'>,
  state: RuntimeStateReader | null | undefined,
): RuntimeConnection | null {
  const op = service.operations.find((o) => o.bootstrap);
  if (!op || !state) return null;
  const recorded = state.get(op.id);
  if (!recorded) return null;
  const status: RuntimeConnectionStatus =
    recorded.status === 'ok' || recorded.status === 'timeout' ? recorded.status : 'unavailable';
  return { operation: op.id, status, observedAt: recorded.observedAt };
}

export type ProviderRuntime = {
  coverage: RuntimeCoverage;
  /** Services with a runtime surface, by their own coverage. N/A services are not counted. */
  services: { full: number; partial: number; notInstrumented: number };
  /** Over the same services. */
  operations: OperationCount;
};

export function serviceRuntime(
  service: Pick<ServiceDefinition, 'runtime' | 'operations'>,
): ServiceRuntime {
  const operations = {
    instrumented: service.operations.filter((o) => o.instrumented).length,
    total: service.operations.length,
  };
  return {
    surface: service.runtime,
    coverage: serviceCoverage(service.runtime, operations),
    operations,
  };
}

function serviceCoverage(surface: RuntimeSurface, ops: OperationCount): RuntimeCoverage {
  if (surface === 'none') return 'N/A';
  if (ops.instrumented === 0) return 'NOT_INSTRUMENTED';
  return ops.instrumented === ops.total ? 'FULL' : 'PARTIAL';
}

export function providerRuntime(provider: {
  services: readonly Pick<ServiceDefinition, 'runtime' | 'operations'>[];
}): ProviderRuntime {
  const surfaced = provider.services.map(serviceRuntime).filter((s) => s.coverage !== 'N/A');
  const services = {
    full: surfaced.filter((s) => s.coverage === 'FULL').length,
    partial: surfaced.filter((s) => s.coverage === 'PARTIAL').length,
    notInstrumented: surfaced.filter((s) => s.coverage === 'NOT_INSTRUMENTED').length,
  };
  const operations = surfaced.reduce<OperationCount>(
    (sum, s) => ({
      instrumented: sum.instrumented + s.operations.instrumented,
      total: sum.total + s.operations.total,
    }),
    { instrumented: 0, total: 0 },
  );
  return { coverage: providerCoverage(services, surfaced.length), services, operations };
}

function providerCoverage(
  services: ProviderRuntime['services'],
  surfaced: number,
): RuntimeCoverage {
  if (surfaced === 0) return 'N/A';
  if (services.full === surfaced) return 'FULL';
  if (services.notInstrumented === surfaced) return 'NOT_INSTRUMENTED';
  return 'PARTIAL';
}

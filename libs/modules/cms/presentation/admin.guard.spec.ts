import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { MetricLabels, MetricsPort } from '@gogo/observability';
import { AdminGuard, RequireRole } from './admin.guard';
import type { AdminRole } from '../application/admin-auth.service';

type Emitted = { name: string; labels: MetricLabels };

class RecordingMetrics implements MetricsPort {
  readonly emitted: Emitted[] = [];
  increment(name: string, labels: MetricLabels = {}): void {
    this.emitted.push({ name, labels });
  }
  observe(): void {}
  time<T>(_n: string, _l: MetricLabels, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

/** Minimal stand-in for the one query the guard makes. */
function dbReturning(role: AdminRole, status = 'active') {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: 'admin-1', role, status }],
        }),
      }),
    }),
  };
}

function contextFor(method: string, url: string) {
  const request = {
    actor: { type: 'admin' as const, id: 'admin-1', sessionId: 's', role: 'editor' as AdminRole },
    method,
    routeOptions: { url },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => Holder,
  };
}

class Holder {}
const handler = () => undefined;

function guardFor(role: AdminRole, required: AdminRole[]) {
  const reflector = new Reflector();
  RequireRole(...required)(Holder);
  const metrics = new RecordingMetrics();
  const guard = new AdminGuard(
    reflector,
    dbReturning(role) as never,
    metrics as unknown as MetricsPort,
  );
  return { guard, metrics };
}

/**
 * SEC-002 — `super_admin` bypassing the role gate is the escape hatch, and an
 * escape hatch nobody can see becomes the main road. These assert the metric
 * carries the signal and only the signal: a counter that also counted ordinary
 * work would answer the wrong question.
 */
describe('super_admin bypass metric (SEC-002, #146)', () => {
  it('counts a write that only super_admin could have made', async () => {
    const { guard, metrics } = guardFor('super_admin', ['editor']);
    await guard.canActivate(contextFor('PATCH', '/v1/cms/places/:id') as never);

    expect(metrics.emitted).toHaveLength(1);
    expect(metrics.emitted[0]).toEqual({
      name: 'cms_super_admin_bypass_total',
      labels: { action: 'PATCH /v1/cms/places/:id', resource_type: 'places' },
    });
  });

  it('does not count a write the role was entitled to make', async () => {
    const { guard, metrics } = guardFor('ops_admin', ['ops_admin']);
    await guard.canActivate(contextFor('PUT', '/v1/cms/feature-flags/:key') as never);
    expect(metrics.emitted).toEqual([]);
  });

  it('does not count reads, super_admin included', async () => {
    const { guard, metrics } = guardFor('super_admin', ['editor']);
    await guard.canActivate(contextFor('GET', '/v1/cms/places') as never);
    // Rank-based read is the designed path for a higher role, not an override.
    expect(metrics.emitted).toEqual([]);
  });

  it('labels by route pattern, never by id', async () => {
    const { guard, metrics } = guardFor('super_admin', ['moderator']);
    await guard.canActivate(contextFor('POST', '/v1/cms/moderation/reviews/:id') as never);

    const labels = metrics.emitted[0]!.labels;
    expect(labels['resource_type']).toBe('moderation');
    // One label per reviewed id would make the counter unusable, not more
    // precise: the audit log is where a specific resource is looked up.
    expect(String(labels['action'])).toContain(':id');
  });

  it('does not block the bypass it is counting', async () => {
    const { guard } = guardFor('super_admin', ['editor']);
    await expect(
      guard.canActivate(contextFor('DELETE', '/v1/cms/places/:id') as never),
    ).resolves.toBe(true);
  });
});

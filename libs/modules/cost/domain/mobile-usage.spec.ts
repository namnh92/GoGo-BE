import { describe, expect, it } from 'vitest';
import {
  MOBILE_USAGE_MAX_BACKDATE_DAYS,
  MOBILE_USAGE_MAX_BATCH,
  foldMobileUsage,
  foldQuantity,
  type ClientUsageEvent,
} from './mobile-usage';
import { COST_REGISTRY } from './registry';

const NOW = new Date('2026-09-03T10:00:00.000Z');

const event = (over: Partial<ClientUsageEvent> = {}): ClientUsageEvent => ({
  providerId: 'google',
  serviceId: 'google.maps_sdk_ios',
  usageMetricId: 'map_loads',
  quantity: 1,
  occurredAt: '2026-09-03T09:59:00.000Z',
  platform: 'ios',
  appVersion: '1.4.2',
  ...over,
});

describe('foldMobileUsage (#387, epic §18)', () => {
  it('resolves the operation, meter, SKU and unit from the registry', () => {
    const { rows, rejected } = foldMobileUsage([event()], NOW);
    expect(rejected).toEqual([]);
    expect(rows).toEqual([
      {
        day: '2026-09-03',
        providerId: 'google',
        serviceId: 'google.maps_sdk_ios',
        operationId: 'google.maps_sdk_ios',
        usageMetricId: 'map_loads',
        billingSkuId: 'maps.dynamic.ios',
        unit: 'map_load',
        quantity: 1,
        metadata: { platform: 'ios', appVersion: '1.4.2' },
      },
    ]);
  });

  it('sums a batch into one row per day and meter, and keeps the days apart', () => {
    const { rows } = foldMobileUsage(
      [
        event({ quantity: 3 }),
        event({ quantity: 2 }),
        event({ quantity: 5, occurredAt: '2026-09-02T23:00:00.000Z' }),
        event({ quantity: 7, serviceId: 'google.maps_sdk_android', platform: 'android' }),
      ],
      NOW,
    );
    const byKey = Object.fromEntries(rows.map((r) => [`${r.day}|${r.serviceId}`, r.quantity]));
    expect(byKey).toEqual({
      '2026-09-03|google.maps_sdk_ios': 5,
      '2026-09-02|google.maps_sdk_ios': 5,
      '2026-09-03|google.maps_sdk_android': 7,
    });
    expect(foldQuantity({ rows, rejected: [] })).toBe(17);
  });

  it('keeps the last reported build on the row rather than one row per build', () => {
    const { rows } = foldMobileUsage(
      [event({ appVersion: '1.4.2' }), event({ appVersion: '1.5.0' })],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.appVersion).toBe('1.5.0');
  });

  it('refuses a service the registry does not know, or one nobody reports for', () => {
    const { rows, rejected } = foldMobileUsage(
      [
        event({ serviceId: 'google.not_a_service' }),
        // Registered, and counted here rather than on a handset.
        event({ serviceId: 'google.places' }),
        // Registered service, wrong provider.
        event({ providerId: 'cloudflare' }),
      ],
      NOW,
    );
    expect(rows).toEqual([]);
    expect(rejected).toEqual([
      { index: 0, reason: 'unknown_service' },
      { index: 1, reason: 'not_client_reported' },
      { index: 2, reason: 'unknown_service' },
    ]);
  });

  it('refuses a metric the operation does not carry', () => {
    const { rows, rejected } = foldMobileUsage([event({ usageMetricId: 'calls' })], NOW);
    expect(rows).toEqual([]);
    expect(rejected).toEqual([{ index: 0, reason: 'unknown_metric' }]);
  });

  /**
   * A row written on a day that has not happened, or on a day an operator has
   * already read and closed, is worse than a lost event: one is a number that
   * moved after it was reported, the other is a number that cannot be true.
   */
  it('discards events outside the accepted window, one by one', () => {
    const stale = new Date(
      NOW.getTime() - (MOBILE_USAGE_MAX_BACKDATE_DAYS + 1) * 86_400_000,
    ).toISOString();
    const { rows, rejected } = foldMobileUsage(
      [
        event({ occurredAt: stale }),
        event({ occurredAt: '2026-09-04T23:00:00.000Z' }),
        event({ quantity: 4 }),
      ],
      NOW,
    );
    expect(rejected).toEqual([
      { index: 0, reason: 'stale_occurred_at' },
      { index: 1, reason: 'future_occurred_at' },
    ]);
    // The good event still lands: one bad clock does not lose the batch.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(4);
  });

  it('tolerates a handset clock a few hours ahead', () => {
    const { rejected } = foldMobileUsage([event({ occurredAt: '2026-09-03T13:00:00.000Z' })], NOW);
    expect(rejected).toEqual([]);
  });

  it('folds a full batch without allocating a row per event', () => {
    const events = Array.from({ length: MOBILE_USAGE_MAX_BATCH }, () => event());
    const { rows } = foldMobileUsage(events, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(MOBILE_USAGE_MAX_BATCH);
  });
});

describe('registry support for client-reported operations', () => {
  it('names both Maps SDK operations and nothing else', () => {
    expect([...COST_REGISTRY.clientReportedOperations()].sort()).toEqual([
      'google.maps_sdk_android',
      'google.maps_sdk_ios',
    ]);
  });

  /**
   * `foldMobileUsage` refuses an event whose metric matches more than one
   * client-reported operation of a service, because there would be no honest
   * way to say which operation it paid for. That is a registry invariant, not
   * a runtime hazard — so it is pinned here rather than defended at runtime.
   */
  it('gives every client-reported service exactly one operation per metric', () => {
    for (const serviceId of new Set(
      [...COST_REGISTRY.clientReportedOperations()].map(
        (id) => COST_REGISTRY.operation(id)!.serviceId,
      ),
    )) {
      const operations = COST_REGISTRY.service(serviceId)!.operations.filter(
        (o) => o.clientReported === true,
      );
      const metrics = operations.flatMap((o) => o.usageMeters.map((m) => m.metric));
      expect(new Set(metrics).size, serviceId).toBe(metrics.length);
    }
  });

  it('flips only the client-reported operations when telemetry is on', () => {
    const on = COST_REGISTRY.withClientTelemetry(true);
    expect(on.operation('google.maps_sdk_ios')!.instrumented).toBe(true);
    expect(on.operation('google.maps_sdk_android')!.instrumented).toBe(true);
    // Everything else keeps the answer it had.
    for (const op of COST_REGISTRY.operations()) {
      if (op.clientReported === true) continue;
      expect(on.operation(op.id)!.instrumented, op.id).toBe(op.instrumented);
    }
    // …and the static definition is untouched: a reader that knows nothing
    // about the flag keeps reporting the measurement gap.
    expect(COST_REGISTRY.operation('google.maps_sdk_ios')!.instrumented).toBe(false);
  });

  it('returns itself, not a copy, when telemetry is off', () => {
    expect(COST_REGISTRY.withClientTelemetry(false)).toBe(COST_REGISTRY);
  });
});

import { COST_REGISTRY, type CostRegistry, type MeterUnit } from './registry';

/**
 * COST-BE-028 (#387) — epic §18, client-reported provider usage.
 *
 * A Maps SDK draws the map on the handset. No request reaches this process,
 * so no adapter can count one, and every reader so far has correctly reported
 * a MEASUREMENT GAP rather than a zero. The only way the number can exist is
 * for the handset to send it, which is what `POST /v1/telemetry/provider-usage`
 * accepts and what this module folds.
 *
 * Everything about that origin is load-bearing, and shows up in three places:
 *
 * 1. **`source` is `mobile_sdk`, not `ledger`.** Two sources never share a row
 *    and never sum (epic §9). A Prometheus backfill and a phone are different
 *    views, and the cost screen must be able to say which it is looking at.
 * 2. **`confidence` is `LOW`.** The count is as honest as the app build that
 *    produced it: an event can be lost to a crash, a kill, or an airplane
 *    mode, and none of that is visible from here. It is a good estimate and a
 *    bad invoice.
 * 3. **The payload carries no identity.** Provider, service, meter, a count, a
 *    timestamp, a platform and an app version — nothing that says *which* map
 *    of *whose*. Epic §18 lists what must never appear (user id, place id,
 *    lat/lng, URL, tracking id, session id), and the request schema refuses
 *    unknown keys rather than ignoring them, so a field added by a future
 *    client is a 422 here instead of a silent leak into the cost tables.
 *
 * The fold below is pure: events in, one row per (day, meter) out, plus the
 * events it refused and why. Persistence, the flag and the metric live in the
 * service.
 */

/** `provider_usage_meter_daily.source` for every row this path writes. */
export const MOBILE_USAGE_SOURCE = 'mobile_sdk';

/** Client-reported, therefore never HIGH (epic §9). */
export const MOBILE_USAGE_CONFIDENCE = 'LOW';

/** Epic §18 batching. One request is one uploader flush, not one map load. */
export const MOBILE_USAGE_MAX_BATCH = 100;

/**
 * How far back a batch may reach. An uploader that could not reach the network
 * holds events until it can, and dropping those would under-count exactly the
 * days a phone was offline. Three days covers a weekend; past that the day is
 * closed and a late arrival would silently move a number an operator has
 * already read.
 */
export const MOBILE_USAGE_MAX_BACKDATE_DAYS = 3;

/**
 * Tolerated clock skew into the future. A handset clock is not ours to trust,
 * and a wrong one would otherwise write a row on a day that has not happened.
 */
export const MOBILE_USAGE_MAX_FUTURE_SKEW_MS = 6 * 60 * 60 * 1000;

/**
 * How long the last accepted batch keeps the source FRESH. A day with no map
 * loads is ordinary; a day with no *report at all* means the phones stopped
 * talking to us, and that is a different fact from a measured zero (epic §23).
 */
export const MOBILE_USAGE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export const MOBILE_USAGE_PLATFORMS = ['ios', 'android'] as const;
export type MobileUsagePlatform = (typeof MOBILE_USAGE_PLATFORMS)[number];

/** One reported measurement. Bounded dimensions only (epic §18). */
export type ClientUsageEvent = {
  providerId: string;
  serviceId: string;
  /** The meter's short metric — `map_loads`. Never a meter id. */
  usageMetricId: string;
  quantity: number;
  /** ISO-8601 instant the measurement was taken on the device. */
  occurredAt: string;
  platform: MobileUsagePlatform;
  appVersion: string;
};

/** Why one event of a batch was not recorded. A closed set; also a metric-safe label. */
export const MOBILE_USAGE_REJECTIONS = [
  'unknown_service',
  'not_client_reported',
  'unknown_metric',
  'stale_occurred_at',
  'future_occurred_at',
] as const;
export type MobileUsageRejection = (typeof MOBILE_USAGE_REJECTIONS)[number];

/** One `provider_usage_meter_daily` row, before persistence. */
export type MobileUsageRow = {
  day: string;
  providerId: string;
  serviceId: string;
  operationId: string;
  usageMetricId: string;
  billingSkuId: string | null;
  unit: MeterUnit;
  quantity: number;
  /**
   * Last writer wins, deliberately. The row is a daily total across every
   * handset that reported; there is no build it belongs to, and keying the row
   * by app version would make one series per release forever. What an operator
   * actually asks is "which build is producing these right now", and the most
   * recent report answers it.
   */
  metadata: { platform: MobileUsagePlatform; appVersion: string };
};

export type MobileUsageFold = {
  rows: MobileUsageRow[];
  /** Per-event refusals, in request order. `index` points into the input batch. */
  rejected: { index: number; reason: MobileUsageRejection }[];
};

/** UTC calendar day of an instant, as `YYYY-MM-DD`. */
function utcDayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The meter an event names, or why it names none.
 *
 * Nothing here compares an id to a literal: the registry says which operations
 * are client-reported and which meters they carry, so a second client-reported
 * service is accepted the day it is registered, with no change to this file,
 * the controller or the contract's validation.
 */
function resolveTarget(
  event: ClientUsageEvent,
  registry: CostRegistry,
):
  | { row: Omit<MobileUsageRow, 'day' | 'quantity' | 'metadata'> }
  | { reason: MobileUsageRejection } {
  const service = registry.service(event.serviceId);
  if (service === null || service.providerId !== event.providerId) {
    return { reason: 'unknown_service' };
  }
  const operations = service.operations.filter((o) => o.clientReported === true);
  if (operations.length === 0) return { reason: 'not_client_reported' };

  const matches = operations.flatMap((operation) =>
    operation.usageMeters
      .filter((meter) => meter.metric === event.usageMetricId)
      .map((meter) => ({ operation, meter })),
  );
  // Exactly one, or the event is ambiguous and we would be guessing which
  // operation it paid for. A registry that makes this ambiguous is a registry
  // bug; `mobile-usage.spec.ts` pins that it is not.
  if (matches.length !== 1) return { reason: 'unknown_metric' };
  const { operation, meter } = matches[0]!;

  return {
    row: {
      providerId: service.providerId,
      serviceId: service.id,
      operationId: operation.id,
      usageMetricId: meter.metric,
      billingSkuId: meter.billingSkuId,
      unit: meter.unit,
    },
  };
}

/**
 * Events in, one row per (day, meter) out.
 *
 * `platform` is recorded, never cross-checked against the service: which
 * service a build reports under is the client's declaration, and a check here
 * would have to hard-code a platform→service table that the registry
 * deliberately does not have. A wrong pairing lands under the service the
 * client named, where it is visible, rather than being dropped where it is not.
 */
export function foldMobileUsage(
  events: readonly ClientUsageEvent[],
  now: Date,
  registry: CostRegistry = COST_REGISTRY,
): MobileUsageFold {
  const oldestDay = utcDayOf(new Date(now.getTime() - MOBILE_USAGE_MAX_BACKDATE_DAYS * 86_400_000));
  const latestMs = now.getTime() + MOBILE_USAGE_MAX_FUTURE_SKEW_MS;

  const byKey = new Map<string, MobileUsageRow>();
  const rejected: MobileUsageFold['rejected'] = [];

  events.forEach((event, index) => {
    const at = new Date(event.occurredAt);
    if (at.getTime() > latestMs) {
      rejected.push({ index, reason: 'future_occurred_at' });
      return;
    }
    const day = utcDayOf(at);
    if (day < oldestDay) {
      rejected.push({ index, reason: 'stale_occurred_at' });
      return;
    }
    const target = resolveTarget(event, registry);
    if ('reason' in target) {
      rejected.push({ index, reason: target.reason });
      return;
    }
    const key = `${day}|${target.row.serviceId}|${target.row.operationId}|${target.row.usageMetricId}|${target.row.billingSkuId ?? ''}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += event.quantity;
      existing.metadata = { platform: event.platform, appVersion: event.appVersion };
      return;
    }
    byKey.set(key, {
      day,
      ...target.row,
      quantity: event.quantity,
      metadata: { platform: event.platform, appVersion: event.appVersion },
    });
  });

  return { rows: [...byKey.values()], rejected };
}

/** Total units in a fold — what the response reports as recorded. */
export function foldQuantity(fold: MobileUsageFold): number {
  return fold.rows.reduce((n, r) => n + r.quantity, 0);
}

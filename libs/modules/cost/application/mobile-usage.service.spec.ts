import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { MOBILE_USAGE_SOURCE, type ClientUsageEvent } from '../domain/mobile-usage';
import { MobileProviderUsageService } from './mobile-usage.service';

/**
 * #387 — the ingest's guarantees, without a database.
 *
 * The three that matter: nothing is written while the flag is off, the write
 * *adds* rather than replaces (a batch reports loads nobody else will ever
 * see), and every row carries the source and confidence that say where the
 * number came from.
 */

type Executed = { sql: string; params: unknown[] };

const dialect = new PgDialect();

/**
 * `execute` only, no `transaction` — the two statements then run in sequence,
 * which is enough to pin what they contain. The transaction itself is an
 * integration concern (`cost-mobile-usage.int.spec.ts`).
 *
 * `flagRows` is what `feature_flags` answers with; every other query returns
 * nothing, which is what the two upserts expect.
 */
function fakeDb(flagRows: Record<string, unknown>[] = []) {
  const executed: Executed[] = [];
  const db = {
    execute: vi.fn(async (query: SQL) => {
      const rendered = dialect.sqlToQuery(query);
      executed.push({ sql: rendered.sql, params: rendered.params });
      if (rendered.sql.includes('from feature_flags')) return { rows: flagRows };
      return { rows: [] };
    }),
  } as unknown as Db;
  return { db, executed };
}

const enabledFor = (platform: 'all' | 'ios' | 'android') => [
  { environment: 'all', platform, enabled: true, payload: null },
];

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

const OPTIONS = { environment: 'dev', now: () => new Date('2026-09-03T10:00:00.000Z') };

const usageUpsert = (executed: Executed[]) =>
  executed.find((e) => e.sql.includes('into provider_usage_meter_daily'));
const freshnessUpsert = (executed: Executed[]) =>
  executed.find((e) => e.sql.includes('into cost_source_freshness'));

function recorder() {
  const counts: { name: string; labels: Record<string, unknown>; by: number }[] = [];
  return {
    counts,
    increment: (name: string, labels: Record<string, unknown> = {}, by = 1) =>
      void counts.push({ name, labels, by }),
    observe: () => {},
    time: <T>(_n: string, _l: unknown, fn: () => Promise<T>) => fn(),
  };
}

describe('MobileProviderUsageService', () => {
  it('writes nothing while the flag is off, and says so', async () => {
    const { db, executed } = fakeDb();
    const result = await new MobileProviderUsageService(db, undefined, OPTIONS).ingest([
      event(),
      event(),
    ]);
    expect(result).toEqual({
      enabled: false,
      accepted: 0,
      discarded: 2,
      rejected: [],
      quantity: 0,
    });
    expect(usageUpsert(executed)).toBeUndefined();
    expect(freshnessUpsert(executed)).toBeUndefined();
  });

  it('records the batch with source mobile_sdk and confidence LOW', async () => {
    const { db, executed } = fakeDb(enabledFor('ios'));
    const metrics = recorder();
    const result = await new MobileProviderUsageService(db, undefined, OPTIONS, metrics).ingest([
      event({ quantity: 4 }),
      event({ quantity: 6 }),
    ]);

    expect(result).toMatchObject({ enabled: true, accepted: 2, discarded: 0, quantity: 10 });
    const upsert = usageUpsert(executed)!;
    expect(upsert.params).toContain(MOBILE_USAGE_SOURCE);
    expect(upsert.params).toContain('LOW');
    expect(upsert.params).toContain('google.maps_sdk_ios');
    expect(upsert.params).toContain('maps.dynamic.ios');
    expect(upsert.params).toContain('map_load');
    expect(upsert.params).toContain(10);
  });

  /**
   * A collector re-reads a provider's own running total, so it replaces the
   * day's row. A phone reports loads that happened since the last flush and
   * that nobody will ever see again, so its rows add. Getting this backwards
   * would report only the last batch of the day.
   */
  it('adds to the day rather than replacing it', async () => {
    const { db, executed } = fakeDb(enabledFor('ios'));
    await new MobileProviderUsageService(db, undefined, OPTIONS).ingest([event()]);
    const upsert = usageUpsert(executed)!;
    expect(upsert.sql).toContain(
      'quantity     = provider_usage_meter_daily.quantity + excluded.quantity',
    );
  });

  /**
   * Epic §23 — without a source row, a quiet day and a broken uploader look
   * identical, and MEASURED_ZERO can never be reached.
   */
  it('marks the reporting source fresh, one per service', async () => {
    const { db, executed } = fakeDb(enabledFor('all'));
    // A single request never mixes platforms — the request schema refuses that
    // — but the fan-out is per service, so this is the shape worth pinning:
    // iOS going quiet must not make Android look stale.
    await new MobileProviderUsageService(db, undefined, OPTIONS).ingest([
      event(),
      event({ serviceId: 'google.maps_sdk_android', platform: 'android' }),
      event(),
    ]);
    const freshness = freshnessUpsert(executed)!;
    expect(freshness.params).toContain(`${MOBILE_USAGE_SOURCE}:google.maps_sdk_ios`);
    expect(freshness.params).toContain(`${MOBILE_USAGE_SOURCE}:google.maps_sdk_android`);
    expect(freshness.sql.split("'FRESH'").length - 1).toBe(2);
  });

  it('counts map loads under a bounded service label', async () => {
    const { db } = fakeDb(enabledFor('ios'));
    const metrics = recorder();
    await new MobileProviderUsageService(db, undefined, OPTIONS, metrics).ingest([
      event({ quantity: 3 }),
    ]);
    expect(metrics.counts).toEqual([
      { name: 'mobile_provider_usage_total', labels: { service: 'google.maps_sdk_ios' }, by: 3 },
    ]);
  });

  it('reports per-event refusals without losing the rest of the batch', async () => {
    const { db, executed } = fakeDb(enabledFor('ios'));
    const result = await new MobileProviderUsageService(db, undefined, OPTIONS).ingest([
      event({ occurredAt: '2026-08-01T00:00:00.000Z' }),
      event({ quantity: 2 }),
    ]);
    expect(result).toMatchObject({
      enabled: true,
      accepted: 1,
      discarded: 1,
      rejected: [{ index: 0, reason: 'stale_occurred_at' }],
      quantity: 2,
    });
    expect(usageUpsert(executed)).toBeDefined();
  });

  it('skips the write entirely when every event was refused', async () => {
    const { db, executed } = fakeDb(enabledFor('ios'));
    const result = await new MobileProviderUsageService(db, undefined, OPTIONS).ingest([
      event({ usageMetricId: 'calls' }),
    ]);
    expect(result).toMatchObject({ enabled: true, accepted: 0, quantity: 0 });
    expect(usageUpsert(executed)).toBeUndefined();
    expect(freshnessUpsert(executed)).toBeUndefined();
  });

  /**
   * The two platforms do not become ready together — Android is still waiting
   * on its own Maps key (Mobile#127 / Infra#102) — so enabling iOS must not
   * start accepting Android.
   */
  it('answers per platform', async () => {
    const { db, executed } = fakeDb(enabledFor('ios'));
    const service = new MobileProviderUsageService(db, undefined, OPTIONS);
    const android = await service.ingest([
      event({ serviceId: 'google.maps_sdk_android', platform: 'android' }),
    ]);
    expect(android.enabled).toBe(false);
    expect(usageUpsert(executed)).toBeUndefined();
    expect(await service.ingest([event()])).toMatchObject({ enabled: true });
  });
});

import { describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CmsOpsService } from './cms-ops.service';

const dialect = new PgDialect();
function fixture(epoch: number | null, active = true, failOutbox = false) {
  let row: Record<string, unknown> = {
    id: 'r',
    userId: 'u',
    placeId: 'p',
    planId: null,
    status: 'pending',
    creditEpoch: epoch,
    firstPublishedAt: null,
  };
  const writes: { table: unknown; value: Record<string, unknown> }[] = [];
  const trace: string[] = [];
  let transactions = 0;
  const db = {
    execute: async (q: Parameters<PgDialect['sqlToQuery']>[0]) => {
      const text = dialect.sqlToQuery(q).sql;
      trace.push(text);
      if (text.includes('credit_cutover'))
        return { rows: [{ mode: 'evaluator', epoch: 1, first_activated_at: new Date() }] };
      if (text.includes('from users')) return { rows: active ? [{ id: 'u' }] : [] };
      return { rows: [] };
    },
    select: () => {
      const query = {
        from: () => query,
        where: () => query,
        for: (lock: string) => {
          trace.push(`review:${lock}`);
          return query;
        },
        limit: async () => [row],
      };
      return query;
    },
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            row = { ...row, ...value };
            return [row];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (value: Record<string, unknown>) => {
        if (failOutbox && table === schema.outboxEvents) throw new Error('outbox unavailable');
        writes.push({ table, value });
      },
    }),
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      transactions++;
      const before = { ...row };
      const size = writes.length;
      try {
        return await work(db);
      } catch (e) {
        row = before;
        writes.splice(size);
        throw e;
      }
    },
  };
  return {
    service: new CmsOpsService(db as never),
    row: () => row,
    trace,
    writes,
    transactions: () => transactions,
    event: () => writes.find((w) => w.table === schema.outboxEvents)?.value,
  };
}

describe('review publication prerequisites (#829 Astra-CE-01/02)', () => {
  it.each([null, 1])(
    'creation epoch %s controls firstPublication; republish never restamps',
    async (epoch) => {
      const f = fixture(epoch);
      await f.service.decideReview('admin', 'r', 'published', 'ok');
      expect(f.transactions()).toBe(1);
      expect(f.event()).toMatchObject({
        eventType: 'review.published',
        payloadSchemaVersion: 2,
        payload: {
          reviewId: 'r',
          userId: 'u',
          target: 'place',
          placeId: 'p',
          firstPublication: epoch !== null,
          grantOwner: 'evaluator',
        },
      });
      const stamp = f.row().firstPublishedAt;
      expect(stamp).toBeTruthy();
      await f.service.decideReview('admin', 'r', 'rejected', 'no');
      await f.service.decideReview('admin', 'r', 'published', 'ok');
      expect(f.row().firstPublishedAt).toBe(stamp);
      const events = f.writes.filter((w) => w.table === schema.outboxEvents);
      expect(events).toHaveLength(2);
      expect(events[1]!.value.payload).toMatchObject({ firstPublication: false });
      expect(f.trace.findIndex((s) => s.includes('credit_cutover'))).toBeLessThan(
        f.trace.findIndex((s) => s.includes('pg_advisory_xact_lock')),
      );
      expect(f.trace.findIndex((s) => s.includes('pg_advisory_xact_lock'))).toBeLessThan(
        f.trace.indexOf('review:update'),
      );
    },
  );
  it('moderates retained content without resurrecting a deleted recipient', async () => {
    const f = fixture(1, false);
    await f.service.decideReview('admin', 'r', 'published', 'ok');
    expect(f.event()?.payload).toMatchObject({ userId: null });
  });
  it('rolls status, stamp and audit back when event insertion fails', async () => {
    const f = fixture(1, true, true);
    await expect(f.service.decideReview('admin', 'r', 'published', 'ok')).rejects.toThrow(
      'outbox unavailable',
    );
    expect(f.row()).toMatchObject({ status: 'pending', firstPublishedAt: null });
    expect(f.writes).toEqual([]);
  });
});

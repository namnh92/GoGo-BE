import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import { ReminderWorker } from './reminder-worker';

vi.mock('../../shared/reminder-schedule', () => ({
  REMINDER_LEAD_SECONDS: 7200,
  syncReminderSchedule: vi.fn(),
}));

const job = {
  id: '00000000-0000-4000-8000-000000000001',
  room_id: '00000000-0000-4000-8000-000000000002',
  starts_at: '2026-11-10T02:00:00Z',
  scheduled_for: '2026-11-10T00:00:00Z',
};

describe('reminder producer fence (F-01)', () => {
  it.each(['already frozen', 'freeze racing due selection', 'open'])(
    'allows delivery draining with %s',
    async (state) => {
      let frozen = state === 'already frozen';
      const statements: string[] = [];
      const execute = vi.fn(async (query: SQL) => {
        const { sql } = new PgDialect().sqlToQuery(query);
        statements.push(sql);
        if (sql.includes('select producers_frozen'))
          return { rows: [{ producers_frozen: frozen }] };
        if (sql.includes('select id, room_id')) {
          if (state === 'freeze racing due selection') frozen = true;
          return { rows: [job] };
        }
        if (sql.includes('select id, starts_at')) return { rows: [job] };
        if (sql.includes('insert into outbox_events') && frozen)
          throw Object.assign(
            new Error('Outbox producers frozen for notification worker transition'),
            { code: '55000' },
          );
        return { rows: [] };
      });
      const db = {
        execute,
        transaction: async (run: (tx: unknown) => unknown) => run({ execute }),
      } as unknown as Db;
      const drain = vi.fn();
      await expect(new ReminderWorker(db).runTick().then(drain)).resolves.toBeUndefined();
      expect(drain).toHaveBeenCalledWith(state === 'open' ? 1 : 0);
      const insert = statements.findIndex((s) => s.includes('insert into outbox_events'));
      if (state === 'open') {
        const fence = statements.findIndex(
          (s) => s.includes('select producers_frozen') && s.includes('for share'),
        );
        expect(fence).toBeGreaterThanOrEqual(0);
        expect(fence).toBeLessThan(insert);
      } else expect(insert).toBe(-1);
    },
  );
});

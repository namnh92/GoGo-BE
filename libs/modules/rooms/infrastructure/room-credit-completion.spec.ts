import { describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import { RoomsRepository } from './rooms.repository';

const dialect = new PgDialect();
function fixture(gainAccount = false, failOutbox = false) {
  const trace: string[] = [];
  const writes: Record<string, unknown>[] = [];
  let attempt = 0;
  let status = 'active';
  const members = [
    { user_id: 'b', member_id: 'mb', role: 'host' },
    { user_id: 'a', member_id: 'ma', role: 'member' },
    { user_id: 'deleted', member_id: 'md', role: 'member' },
    { user_id: null, member_id: 'mg', role: 'guest' },
  ];
  const db = {
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      attempt++;
      const old = status;
      const size = writes.length;
      try {
        return await work(db);
      } catch (e) {
        status = old;
        writes.splice(size);
        throw e;
      }
    },
    execute: async (q: Parameters<PgDialect['sqlToQuery']>[0]) => {
      const { sql, params } = dialect.sqlToQuery(q);
      trace.push(`${attempt}:${sql}:${params.join(',')}`);
      if (sql.includes('credit_cutover'))
        return { rows: [{ mode: 'sync', epoch: 0, first_activated_at: null }] };
      if (sql.includes('select distinct user_id'))
        return {
          rows: members.filter((m) => m.user_id !== null).map((m) => ({ user_id: m.user_id })),
        };
      if (sql.includes('from users'))
        return { rows: params[0] === 'deleted' ? [] : [{ id: params[0] }] };
      if (sql.includes('as stops_completed')) {
        if (gainAccount && attempt === 1)
          members.push({ user_id: 'c', member_id: 'mc', role: 'member' });
        return {
          rows: [
            { triggered_at: '2026-11-10T00:00:00Z', members: [...members], stops_completed: 2 },
          ],
        };
      }
      return { rows: [] };
    },
    select: () => {
      let table: unknown;
      const query = {
        from: (t: unknown) => {
          table = t;
          return query;
        },
        where: () => query,
        for: (mode: string) => {
          trace.push(`${attempt}:room:${mode}`);
          return query;
        },
        then: (resolve: (v: unknown) => void) =>
          resolve(
            table === schema.roomMembers
              ? [{ id: 'mb', userId: 'b', guestSessionId: null, role: 'host' }]
              : [{ id: 'r', type: 'group', status, hostUserId: 'b', hostVersion: 1 }],
          ),
      };
      return query;
    },
    update: () => ({
      set: (value: { status: string }) => ({
        where: async () => {
          status = value.status;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (row: Record<string, unknown>) => {
        if (table === schema.outboxEvents) {
          if (failOutbox && row.eventType === 'room.completed')
            throw new Error('outbox unavailable');
          writes.push(row);
        }
      },
    }),
  };
  return {
    repo: new RoomsRepository(db as never),
    trace,
    writes,
    status: () => status,
    attempts: () => attempt,
  };
}
const event = {
  eventType: 'room.status_completed',
  resourceType: 'room',
  resourceId: 'r',
  payload: {},
};

describe('room completion cohort (#829 CE-F-05/08/13)', () => {
  it('emits one v2 snapshot of active registered members and DB facts, after ordered account locks', async () => {
    const f = fixture();
    await f.repo.updateStatus('r', 'completed', event, false, {
      kind: 'host',
      actor: { type: 'user', id: 'b', sessionId: 's' },
      memberId: 'mb',
      hostVersion: 1,
    });
    expect(f.writes.find((w) => w.eventType === 'room.completed')).toMatchObject({
      payloadSchemaVersion: 2,
      payload: {
        roomId: 'r',
        grantOwner: 'none',
        triggeredAt: '2026-11-10T00:00:00.000Z',
        room: { type: 'group', participantCount: 4 },
        plan: { stopsCompleted: 2 },
        subjects: [
          { userId: 'b', memberId: 'mb', role: 'host' },
          { userId: 'a', memberId: 'ma', role: 'member' },
        ],
      },
    });
    const locks = f.trace.filter((s) => s.includes('pg_advisory_xact_lock'));
    expect(locks.map((s) => s.split(':').at(-1))).toEqual(['a', 'b', 'deleted']);
    expect(f.trace.indexOf(locks.at(-1)!)).toBeLessThan(f.trace.indexOf('1:room:update'));
    expect(f.trace.findIndex((s) => s.includes('as stops_completed'))).toBeGreaterThan(
      f.trace.indexOf('1:room:update'),
    );
    expect(f.status()).toBe('completed');
  });
  it('rolls back and discovers again when a new account joins before the room lock', async () => {
    const f = fixture(true);
    await f.repo.updateStatus('r', 'completed', event, false, {
      kind: 'host',
      actor: { type: 'user', id: 'b', sessionId: 's' },
      memberId: 'mb',
      hostVersion: 1,
    });
    expect(f.attempts()).toBe(2);
    expect(f.writes.filter((w) => w.eventType === 'room.completed')).toHaveLength(1);
    expect(
      (f.writes.find((w) => w.eventType === 'room.completed')?.payload as { subjects: unknown[] })
        .subjects,
    ).toContainEqual({ userId: 'c', memberId: 'mc', role: 'member' });
    expect(f.trace.filter((s) => s.startsWith('1:') && s.includes('assistant:c'))).toEqual([]);
  });
  it('rolls completion and both events back on event failure', async () => {
    const f = fixture(false, true);
    await expect(
      f.repo.updateStatus('r', 'completed', event, false, {
        kind: 'host',
        actor: { type: 'user', id: 'b', sessionId: 's' },
        memberId: 'mb',
        hostVersion: 1,
      }),
    ).rejects.toThrow('outbox unavailable');
    expect(f.status()).toBe('active');
    expect(f.writes).toEqual([]);
  });
});

import { NoopMetrics } from '@gogo/observability';
import type { Db } from '@gogo/database';
import { describe, expect, it, vi } from 'vitest';
import { lockHostRoom, type HostAuthority } from '../domain/host-authority';
import { RoomsRepository } from './rooms.repository';

vi.mock('../domain/host-authority', () => ({ lockHostRoom: vi.fn(), requireHostWithin: vi.fn() }));

describe('#906 token issuance transaction', () => {
  it.each([1, 300, 86400, 172800, 172801, 2147483647])(
    'stores exactly %i seconds from the post-lock DB clock',
    async (ttl) => {
      const issuedAt = new Date('2026-11-13T00:00:00.123Z');
      const order: string[] = [];
      vi.mocked(lockHostRoom).mockImplementation(async () => {
        order.push('room');
        return { status: 'collecting', expiresAt: new Date(0) } as never;
      });
      const execute = vi
        .fn()
        .mockImplementationOnce(async () => {
          order.push('setting');
          return { rows: [{ ttl_seconds: ttl }] };
        })
        .mockImplementationOnce(async () => {
          order.push('clock');
          return { rows: [{ now: issuedAt.toISOString() }] };
        });
      const values = vi.fn((row: Record<string, unknown>) => ({
        returning: async () => {
          order.push('insert');
          return [{ id: 'invite', ...row }];
        },
      }));
      const tx = { execute, insert: () => ({ values }) };
      const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
        const row = await work(tx);
        order.push('commit');
        return row;
      });
      const metrics = new NoopMetrics();
      const emit = vi.spyOn(metrics, 'increment');
      const repo = new RoomsRepository({ transaction } as unknown as Db, metrics);
      const input = { roomId: 'room', createdByMemberId: 'host', codeHash: 'opaque-hash' };
      const row = await repo.createInvite(input, {} as HostAuthority);
      expect(order).toEqual(['room', 'setting', 'clock', 'insert', 'commit']);
      expect(row.createdAt).toEqual(issuedAt);
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(ttl * 1000);
      expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
        isolationLevel: 'read committed',
      });
      expect(emit).toHaveBeenLastCalledWith('room_invite_issue_total', {
        kind: 'token',
        result: 'committed',
      });
      expect(values).toHaveBeenCalledExactlyOnceWith({
        ...input,
        createdAt: issuedAt,
        expiresAt: row.expiresAt,
      });
    },
  );
});

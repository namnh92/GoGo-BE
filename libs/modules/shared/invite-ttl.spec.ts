import { NoopMetrics } from '@gogo/observability';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Tx } from './outbox';
import {
  InviteTtlSettingUnavailable,
  isInviteTtlSeconds,
  observeInviteIssuance,
  readInviteTtlWithin,
} from './invite-ttl';

describe('#906 setting reader', () => {
  it.each([1, 300, 86400, 172800, 172801, 2147483647])('accepts integer seconds %i', (value) => {
    expect(isInviteTtlSeconds(value)).toBe(true);
  });
  it.each([0, -1, 1.1, '300', null, undefined, NaN, Infinity, 2147483648, {}])(
    'rejects %s without coercion',
    (value) => {
      expect(isInviteTtlSeconds(value)).toBe(false);
    },
  );
  it('takes the clock only after SHARE resolves, decodes PostgreSQL time, and rereads on every issuance', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const statements: string[] = [];
    let ttl = 86400;
    const execute = vi.fn(async (query: SQL) => {
      const text = new PgDialect().sqlToQuery(query).sql;
      statements.push(text);
      if (text.includes('for share')) {
        await barrier;
        return { rows: [{ ttl_seconds: ttl }] };
      }
      return { rows: [{ now: '2026-11-13 07:00:00.123456+07' }] };
    });
    const tx = { execute } as unknown as Tx;
    const metrics = new NoopMetrics();
    const emit = vi.spyOn(metrics, 'increment');
    const pending = readInviteTtlWithin(tx, 'token', metrics);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(statements[0]).toMatch(/where id=1 for share$/);
    release();
    expect(await pending).toEqual({
      ttlSeconds: 86400,
      issuedAt: new Date('2026-11-13T00:00:00.123Z'),
    });
    ttl = 300;
    expect((await readInviteTtlWithin(tx, 'token', metrics)).ttlSeconds).toBe(300);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(emit).toHaveBeenCalledWith('room_invite_ttl_read_total', {
      consumer: 'token',
      result: 'ok',
    });
  });
  it.each([
    [[], 'missing', false],
    [[{ ttl_seconds: 0 }], 'invalid', false],
    [[{ ttl_seconds: '300' }], 'invalid', false],
    [[{ ttl_seconds: 2147483648 }], 'invalid', false],
  ])('fails closed on rows %j', async (rows, reason, retryable) => {
    const metrics = new NoopMetrics();
    const emit = vi.spyOn(metrics, 'increment');
    const execute = vi.fn().mockResolvedValue({ rows });
    await expect(
      readInviteTtlWithin({ execute } as unknown as Tx, 'code6', metrics),
    ).rejects.toMatchObject({
      code: 'INVITE_TTL_SETTING_UNAVAILABLE',
      reason,
      httpStatus: 503,
      options: { retryable },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledExactlyOnceWith('room_invite_ttl_read_total', {
      consumer: 'code6',
      result: reason,
    });
  });
  it('discards SQL/parameters from driver failures and reports a retryable 503', async () => {
    const execute = vi.fn().mockRejectedValue({ code: '55P03', query: 'secret marker' });
    const error = await readInviteTtlWithin(
      { execute } as unknown as Tx,
      'token',
      new NoopMetrics(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(InviteTtlSettingUnavailable);
    expect(error.options.retryable).toBe(true);
    expect(JSON.stringify(error)).not.toContain('secret marker');
  });
  it('counts only the OUTER transaction outcome, including failures after a successful insert', async () => {
    const metrics = new NoopMetrics();
    const emit = vi.spyOn(metrics, 'increment');
    let commit!: () => void;
    const pending = observeInviteIssuance(
      metrics,
      'token',
      () =>
        new Promise<void>((r) => {
          commit = r;
        }),
    );
    expect(emit).not.toHaveBeenCalled();
    commit();
    await pending;
    expect(emit).toHaveBeenCalledExactlyOnceWith('room_invite_issue_total', {
      kind: 'token',
      result: 'committed',
    });
    emit.mockClear();
    await expect(
      observeInviteIssuance(metrics, 'code6', async () => {
        throw new Error('completion failed');
      }),
    ).rejects.toThrow('completion failed');
    expect(emit).toHaveBeenCalledExactlyOnceWith('room_invite_issue_total', {
      kind: 'code6',
      result: 'rolled_back',
    });
  });
  it.each([
    { code: '08006' },
    { cause: { code: '55P03', query: 'private SQL' } },
    new Error('timeout exceeded when trying to connect'),
    new Error('Connection terminated unexpectedly'),
  ])(
    'maps connection/lock failure at the transaction boundary to a safe retryable 503',
    async (error) => {
      await expect(
        observeInviteIssuance(new NoopMetrics(), 'token', async () => {
          throw error;
        }),
      ).rejects.toMatchObject({
        code: 'INVITE_TTL_SETTING_UNAVAILABLE',
        httpStatus: 503,
        reason: 'db_error',
        options: { retryable: true },
      });
    },
  );
});

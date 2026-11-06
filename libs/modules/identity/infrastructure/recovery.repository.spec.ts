import { describe, expect, it, vi } from 'vitest';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema, type Db } from '@gogo/database';
import { RecoveryRepository } from './recovery.repository';

describe('recovery transaction protocol (no database)', () => {
  function setup() {
    const events: string[] = [];
    const user = {
      id: 'original-user',
      email: 'person@example.com',
      passwordHash: 'old',
      status: 'active',
    };
    const challenge = { id: 'challenge', userId: user.id, emailDigest: 'digest' };
    const dialect = new PgDialect();
    const predicates: { table: string; sql: string; params: unknown[] }[] = [];
    const conflicts: { table: string; target: unknown; set: unknown }[] = [];
    const changes: { table: string; value: any }[] = [];
    const tx = {
      execute: vi.fn(async (query) => {
        events.push(dialect.sqlToQuery(query).sql);
      }),
      select: () => ({
        from: (table: any) => {
          const name = getTableName(table);
          const rows =
            name === 'users' ? [user] : name === 'password_recovery_challenges' ? [challenge] : [];
          return {
            where: (predicate: any) => {
              const { sql, params } = dialect.sqlToQuery(predicate);
              predicates.push({ table: name, sql, params });
              return {
                then: (resolve: any) => Promise.resolve(rows).then(resolve),
                for: async (kind: string) => {
                  events.push(`lock ${name} ${kind}`);
                  return rows;
                },
              };
            },
          };
        },
      }),
      update: (table: any) => ({
        set: (value: any) => {
          const name = getTableName(table);
          changes.push({ table: name, value });
          return {
            where: (predicate: any) => {
              const { sql, params } = dialect.sqlToQuery(predicate);
              predicates.push({ table: name, sql, params });
              const done = Promise.resolve(undefined);
              return Object.assign(done, {
                returning: async () => [{ id: 'family-one' }, { id: 'family-two' }],
              });
            },
          };
        },
      }),
      delete: (table: any) => ({
        where: async () => {
          events.push(`delete ${getTableName(table)}`);
        },
      }),
      insert: (table: any) => ({
        values: (value: any) => {
          const name = getTableName(table);
          changes.push({ table: name, value });
          const done = Promise.resolve(undefined);
          return Object.assign(done, {
            onConflictDoUpdate: async (config: { target: unknown; set: unknown }) => {
              conflicts.push({ table: name, ...config });
            },
          });
        },
      }),
    };
    const db = {
      transaction: vi.fn(async (work) => {
        try {
          const result = await work(tx);
          events.push('commit');
          return result;
        } catch (error) {
          events.push('rollback');
          throw error;
        }
      }),
    };
    return {
      repo: new RecoveryRepository(db as unknown as Db),
      events,
      changes,
      predicates,
      tx,
      conflicts,
      compile: (value: SQL) => dialect.sqlToQuery(value),
    };
  }

  it('locks the original identity before challenge, and writes every reset effect through one transaction', async () => {
    const { repo, events, changes, predicates, compile } = setup();
    const ids = await repo.transaction(
      'digest',
      'person@example.com',
      'complete',
      'replay-key',
      async (tx) => {
        const ids = await tx.reset('new-hash');
        await tx.saveReplay('replay-key', {
          fingerprint: 'hmac',
          body: null,
          expiresAt: new Date(),
        });
        return ids;
      },
    );
    expect(ids).toEqual(['family-one', 'family-two']);
    expect(events.findIndex((event) => event === 'lock users update')).toBeLessThan(
      events.findIndex((event) => event === 'lock password_recovery_challenges update'),
    );
    expect(events.slice(0, 2).every((event) => event.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(predicates.find((entry) => entry.table === 'users')?.params).toEqual(['original-user']);
    expect(predicates.find((entry) => entry.table === 'auth_sessions')).toEqual({
      table: 'auth_sessions',
      sql: '"auth_sessions"."user_id" = $1',
      params: ['original-user'],
    }); // All this user's families, no session/family restriction, no other user.
    const consume = changes.find((entry) => entry.table === 'password_recovery_challenges')!.value;
    expect(Object.keys(consume)).toEqual(['consumedAt']);
    expect(consume.consumedAt).toBeTruthy();
    expect(compile(consume.consumedAt)).toMatchObject({ sql: 'now()', params: [] });
    const revoked = changes.find((entry) => entry.table === 'auth_sessions')!.value;
    expect(Object.keys(revoked).sort()).toEqual(['revokeReason', 'revokedAt']);
    expect(revoked.revokeReason).toBe('password_recovery');
    expect(compile(revoked.revokedAt)).toMatchObject({ sql: 'now()', params: [] });
    expect(changes.map((entry) => entry.table)).toEqual([
      'password_recovery_challenges',
      'users',
      'auth_sessions',
      'audit_logs',
      'password_recovery_replays',
    ]);
    expect(events).toContain('delete login_attempts');
    expect(events.at(-1)).toBe('commit');
  });

  it('commits a failed-attempt outcome without throwing inside the transaction', async () => {
    const { repo, changes, events, predicates, compile } = setup();
    const result = await repo.transaction(
      'digest',
      'person@example.com',
      'complete',
      'replay-key',
      async (tx) => {
        await tx.failAttempt();
        return { valid: false };
      },
    );
    expect(result).toEqual({ valid: false });
    expect(changes.map((entry) => entry.table)).toEqual(['password_recovery_challenges']);
    expect(Object.keys(changes[0]!.value)).toEqual(['attempts']);
    expect(compile(changes[0]!.value.attempts)).toMatchObject({
      sql: 'least(5, attempts + 1)',
      params: [],
    });
    expect(predicates.at(-1)).toMatchObject({
      table: 'password_recovery_challenges',
      sql: '"password_recovery_challenges"."email_digest" = $1',
      params: ['digest'],
    });
    expect(events.at(-1)).toBe('commit');
  });

  it('replaces the entire previous proof on the email-digest conflict target', async () => {
    const { repo, conflicts, changes } = setup();
    const replacement = {
      id: 'fresh-challenge',
      userId: 'original-user',
      emailDigest: 'digest',
      codeDigest: 'fresh-hmac',
      attempts: 0,
      consumedAt: null,
      expiresAt: new Date('2026-11-06T00:05:00Z'),
      resendAvailableAt: new Date('2026-11-06T00:01:00Z'),
    };
    await repo.transaction('digest', 'person@example.com', 'request', 'replay-key', (tx) =>
      tx.replaceChallenge(replacement),
    );
    expect(changes).toEqual([{ table: 'password_recovery_challenges', value: replacement }]);
    expect(conflicts).toEqual([
      {
        table: 'password_recovery_challenges',
        target: schema.passwordRecoveryChallenges.emailDigest,
        set: replacement,
      },
    ]);
  });

  it('rolls back if replay persistence fails after reset effects', async () => {
    const { repo, tx, events } = setup();
    const insert = tx.insert;
    vi.spyOn(tx, 'insert').mockImplementation((table) => {
      if (getTableName(table) === 'password_recovery_replays')
        throw new Error('replay unavailable');
      return insert(table);
    });
    await expect(
      repo.transaction('digest', 'person@example.com', 'complete', 'replay-key', async (work) => {
        await work.reset('new-hash');
        await work.saveReplay('replay-key', {
          fingerprint: 'hmac',
          body: null,
          expiresAt: new Date(),
        });
      }),
    ).rejects.toThrow('replay unavailable');
    expect(events.at(-1)).toBe('rollback');
    expect(events).not.toContain('commit');
  });
});

import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';
import { AppError } from '../../shared/app-error';
import type { InviteTransport } from '../application/invite-attempt-crypto';

export type InviteContext = {
  id: string;
  proofHash: string;
  purpose: string;
  transport: InviteTransport;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};
export type InviteReplay = {
  key: string;
  fingerprint: string;
  contextId: string;
  ciphertext: string;
  expiresAt: Date;
};
export type InviteAttemptTx = {
  now: Date;
  findProof(hash: string): Promise<InviteContext | undefined>;
  findId(id: string): Promise<InviteContext | undefined>;
  replay(): Promise<InviteReplay | undefined>;
  create(context: InviteContext, replay: InviteReplay): Promise<void>;
};

/** pg raw results use strings for timestamps. Never cast them to Date. */
export function inviteTimestamp(value: unknown): Date {
  const result = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(result.getTime())) throw new Error('Invalid invite security timestamp');
  return result;
}

@Injectable()
export class InviteAttemptRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findProof(hash: string): Promise<{ context: InviteContext | undefined; now: Date }> {
    const result = await this.db.execute(
      sql`select id, proof_hash, purpose, transport, created_at, expires_at, revoked_at, clock_timestamp() as now from invite_attempt_contexts where proof_hash = ${hash}`,
    );
    const row = result.rows[0];
    if (!row) return { context: undefined, now: new Date() };
    return {
      context: {
        id: String(row.id),
        proofHash: String(row.proof_hash),
        purpose: String(row.purpose),
        transport: row.transport as InviteTransport,
        createdAt: inviteTimestamp(row.created_at),
        expiresAt: inviteTimestamp(row.expires_at),
        revokedAt: row.revoked_at === null ? null : inviteTimestamp(row.revoked_at),
      },
      now: inviteTimestamp(row.now),
    };
  }

  /** Durable, independent fixed-window flood limits; not the rolling CODE6 budget. */
  async limit(buckets: { key: string; limit: number }[]): Promise<void> {
    const retryAfter = await this.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('invite-bootstrap-flood-v1', 0))`,
      );
      const result = await tx.execute(sql`select clock_timestamp() as now`);
      const now = inviteTimestamp(result.rows[0]?.now);
      let wait = 0;
      for (const bucket of buckets) {
        const [row] = await tx
          .insert(schema.inviteBootstrapBuckets)
          .values({
            key: bucket.key,
            count: 1,
            expiresAt: new Date(now.getTime() + 60_000),
          })
          .onConflictDoUpdate({
            target: schema.inviteBootstrapBuckets.key,
            set: {
              count: sql`case when ${schema.inviteBootstrapBuckets.expiresAt} <= ${now} then 1 else least(${schema.inviteBootstrapBuckets.count} + 1, 1000000) end`,
              expiresAt: sql`case when ${schema.inviteBootstrapBuckets.expiresAt} <= ${now} then ${new Date(now.getTime() + 60_000)} else ${schema.inviteBootstrapBuckets.expiresAt} end`,
            },
          })
          .returning();
        if (row && row.count > bucket.limit)
          wait = Math.max(wait, Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000));
      }
      return wait;
    });
    if (retryAfter)
      throw AppError.tooManyRequests('Invite bootstrap rate limit exceeded', retryAfter);
  }

  transaction<T>(key: string, work: (tx: InviteAttemptTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '2s'`);
      const lock = await tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`invite-bootstrap-replay:${key}`}, 0)) as acquired`,
      );
      if (!lock.rows[0]?.acquired)
        throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'Bootstrap in progress', 409, {
          retryable: true,
          retryAfterSeconds: 1,
        });
      const time = await tx.execute(sql`select clock_timestamp() as now`);
      let now = inviteTimestamp(time.rows[0]?.now);
      const refreshTime = async () => {
        const clock = await tx.execute(sql`select clock_timestamp() as now`);
        now = inviteTimestamp(clock.rows[0]?.now);
      };
      return work({
        get now() {
          return now;
        },
        findProof: async (hash) => {
          const [row] = await tx
            .select()
            .from(schema.inviteAttemptContexts)
            .where(eq(schema.inviteAttemptContexts.proofHash, hash))
            .for('update');
          await refreshTime();
          return row as InviteContext | undefined;
        },
        findId: async (id) => {
          const [row] = await tx
            .select()
            .from(schema.inviteAttemptContexts)
            .where(eq(schema.inviteAttemptContexts.id, id))
            .for('update');
          await refreshTime();
          return row as InviteContext | undefined;
        },
        replay: async () => {
          const [row] = await tx
            .select()
            .from(schema.inviteAttemptReplays)
            .where(eq(schema.inviteAttemptReplays.key, key));
          return row;
        },
        create: async (context, replay) => {
          await tx.insert(schema.inviteAttemptContexts).values(context);
          await tx.insert(schema.inviteAttemptReplays).values(replay);
          await writeAudit(tx, {
            actorType: 'system',
            action: 'invite_context.created',
            resourceType: 'invite_attempt_context',
            resourceId: context.id,
            diff: { transport: context.transport },
          });
        },
      });
    });
  }
}

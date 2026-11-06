import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';
import type { Tx } from '../../shared/outbox';
import type { RecoveryChallenge, RecoveryReplay } from '../application/password-recovery.service';
import type { UserRow } from './identity.repository';

export type RecoveryTransaction = {
  user: UserRow | undefined;
  getChallenge(): Promise<RecoveryChallenge | undefined>;
  replaceChallenge(value: RecoveryChallenge): Promise<void>;
  getReplay(key: string): Promise<RecoveryReplay | undefined>;
  saveReplay(key: string, value: RecoveryReplay): Promise<void>;
  failAttempt(): Promise<void>;
  reset(hash: string): Promise<string[]>;
};

/** Shared by login and recovery; never persists the email in a lock table. */
export async function lockAuthEmail(tx: Tx, email: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`auth-email:${email.trim().toLowerCase()}`}, 0))`);
}

@Injectable()
export class RecoveryRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  transaction<T>(
    digest: string,
    email: string,
    mode: 'request' | 'complete',
    replayKey: string,
    work: (tx: RecoveryTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      // Replay first, email second, original user third, challenge last.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`recovery-replay:${replayKey}`}, 0))`);
      await lockAuthEmail(tx, email);
      const challengeWhere = eq(schema.passwordRecoveryChallenges.emailDigest, digest);
      const [initial] = await tx.select().from(schema.passwordRecoveryChallenges)
        .where(challengeWhere);
      const [user] = await tx.select().from(schema.users)
        .where(mode === 'complete'
          ? sql`${schema.users.id} = ${initial?.userId ?? null}::uuid`
          : and(sql`lower(${schema.users.email}) = ${email}`, sql`${schema.users.status} <> 'deleted'`))
        .for('update');
      const [challenge] = await tx.select().from(schema.passwordRecoveryChallenges)
        .where(challengeWhere).for('update');
      const result = await work({
        user,
        getChallenge: async () => challenge,
        replaceChallenge: async (value) => {
          await tx.insert(schema.passwordRecoveryChallenges).values(value).onConflictDoUpdate({
            target: schema.passwordRecoveryChallenges.emailDigest,
            set: value,
          });
        },
        getReplay: async (key) => {
          const [row] = await tx.select().from(schema.passwordRecoveryReplays).where(and(
            eq(schema.passwordRecoveryReplays.key, key),
            gt(schema.passwordRecoveryReplays.expiresAt, sql`now()`),
          ));
          return row;
        },
        saveReplay: async (key, value) => {
          await tx.insert(schema.passwordRecoveryReplays).values({ key, ...value }).onConflictDoUpdate({
            target: schema.passwordRecoveryReplays.key,
            set: value,
          });
        },
        failAttempt: async () => {
          await tx.update(schema.passwordRecoveryChallenges)
            .set({ attempts: sql`least(5, attempts + 1)` }).where(challengeWhere);
        },
        reset: async (passwordHash) => {
          if (!user || !challenge) throw new Error('Recovery transaction has no bound identity');
          await tx.update(schema.passwordRecoveryChallenges)
            .set({ consumedAt: sql`now()` }).where(challengeWhere);
          await tx.update(schema.users).set({
            passwordHash,
            emailVerifiedAt: sql`coalesce(email_verified_at, now())`,
            updatedAt: sql`now()`,
          }).where(eq(schema.users.id, user.id));
          const revoked = await tx.update(schema.authSessions)
            .set({ revokedAt: sql`now()`, revokeReason: 'password_recovery' })
            .where(eq(schema.authSessions.userId, user.id))
            .returning({ id: schema.authSessions.id });
          const identifierHash = createHash('sha256').update(email).digest('hex');
          await tx.delete(schema.loginAttempts).where(eq(schema.loginAttempts.identifierHash, identifierHash));
          await writeAudit(tx, {
            actorType: 'user', actorId: user.id, action: 'password.recovered',
            resourceType: 'user', resourceId: user.id,
          });
          return revoked.map((row) => row.id);
        },
      });
      // Bounded opportunistic retention. No global locks or unbounded deletes.
      await tx.execute(sql`delete from password_recovery_challenges where email_digest in
        (select email_digest from password_recovery_challenges where expires_at < now() - interval '24 hours' order by expires_at limit 100 for update skip locked)`);
      await tx.execute(sql`delete from password_recovery_replays where key in
        (select key from password_recovery_replays where expires_at < now() order by expires_at limit 100 for update skip locked)`);
      return result;
    });
  }

  async invalidate(digest: string, id: string): Promise<void> {
    await this.db.update(schema.passwordRecoveryChallenges).set({ consumedAt: sql`now()` }).where(and(
      eq(schema.passwordRecoveryChallenges.emailDigest, digest),
      eq(schema.passwordRecoveryChallenges.id, id),
    ));
  }
}

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { lockSyncCreditRules, CREDIT_SEEDS } from '../../../libs/modules/shared/credit-catalogue';
import { grantSubmissionCredits } from '../../../libs/modules/shared/assistant-credits';
import {
  attributeLegacyCreditBatch,
  discoverLegacyCredits,
} from '../../../libs/modules/shared/credit-grants';
import {
  lockCreditCutover,
  lockCreditRecipients,
  retryCreditDiscovery,
} from '../../../libs/modules/shared/credit-event-protocol';
import { CreditEvaluator } from '../../../libs/modules/shared/credit-evaluator';
import { UserContentService } from '../../../libs/modules/reviews/application/user-content.service';
import { creditDatabase, creditOutbox, creditUser } from './support/credit-events';
import type { Tx } from '../../../libs/modules/shared/outbox';
import type { Db } from '@gogo/database';
let f: Awaited<ReturnType<typeof creditDatabase>>;
const secret = 's'.repeat(32);
const evaluator = (db = f.db) =>
  new CreditEvaluator(db, { environment: 'dev', subjectKeySecret: secret });
function erase(userId: string, db = f.db) {
  return new UserContentService(
    db,
    {} as never,
    { enqueue: async () => [], attemptNow: async () => undefined } as never,
    null,
  ).deleteForUser(userId, { actorType: 'user', actorId: userId });
}
async function sync(
  userId: string,
  submissionId: string,
  venue: string,
  evidence = 1,
  base = true,
) {
  await retryCreditDiscovery(() =>
    f.db.transaction(async (tx) => {
      await lockCreditCutover(tx);
      await lockSyncCreditRules(tx);
      const legacy = await discoverLegacyCredits(tx, submissionId, venue);
      const accounts = [userId, ...legacy.flatMap((r) => (r.user_id ? [r.user_id] : []))];
      const active = await lockCreditRecipients(tx, accounts);
      if (active.has(userId))
        await grantSubmissionCredits(
          tx,
          userId,
          submissionId,
          venue,
          evidence,
          base,
          new Set(accounts),
        );
    }),
  );
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
/** Pause immediately after account lock acquisition, observing actual DB waits. */
function accountGate(db: Db) {
  const held = deferred(),
    release = deferred();
  let paused = false;
  const dialect = new PgDialect();
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key !== 'transaction') return Reflect.get(target, key);
      return (work: (tx: Tx) => Promise<unknown>) =>
        target.transaction((tx) =>
          work(
            new Proxy(tx, {
              get(transaction, property) {
                if (property !== 'execute') return Reflect.get(transaction, property);
                return async (q: SQL) => {
                  const result = await transaction.execute(q);
                  if (!paused && dialect.sqlToQuery(q).sql.includes('pg_advisory_xact_lock')) {
                    paused = true;
                    held.resolve();
                    await release.promise;
                  }
                  return result;
                };
              },
            }),
          ),
        );
    },
  });
  return { db: wrapped, held: held.promise, release: release.resolve };
}
beforeAll(async () => {
  f = await creditDatabase();
});
afterAll(async () => {
  await f?.close();
});
describe('#829 sync components, legacy reconciliation and erasure serialization', () => {
  it('grants 50+10 immediately after deploy before backfill and never repeats across retries', async () => {
    const user = await creditUser(f.pool),
      submission = randomUUID(),
      venue = `google:${randomUUID()}`;
    await sync(user, submission, venue);
    await sync(user, submission, venue);
    expect(
      (
        await f.pool.query(
          'select delta,reason,entitlement_key from assistant_credit_ledger where user_id=$1 order by delta desc',
          [user],
        )
      ).rows,
    ).toEqual([
      { delta: 50, reason: 'submission_approved', entitlement_key: `venue:${venue}` },
      { delta: 10, reason: 'submission_evidence', entitlement_key: `submission:${submission}` },
    ]);
    expect(
      (await f.pool.query('select balance from assistant_credit_accounts where user_id=$1', [user]))
        .rows,
    ).toEqual([{ balance: 60 }]);
  });
  it.each([20, 50, 70])(
    'reconciles a legacy %i conflict before paying anything and preserves deltas',
    async (delta) => {
      const user = await creditUser(f.pool),
        submission = randomUUID(),
        venue = `google:${randomUUID()}`;
      const old = String(
        (
          await f.pool.query(
            "insert into assistant_credit_ledger(user_id,delta,reason,submission_id,venue_identity) values($1,$2,'submission_approved',$3,$4) returning id",
            [user, delta, submission, venue],
          )
        ).rows[0].id,
      );
      await f.pool.query('insert into assistant_credit_accounts(user_id,balance) values($1,$2)', [
        user,
        delta,
      ]);
      await Promise.all([sync(user, submission, venue), attributeLegacyCreditBatch(f.db, 1)]);
      expect(
        (
          await f.pool.query('select balance from assistant_credit_accounts where user_id=$1', [
            user,
          ])
        ).rows[0].balance,
      ).toBe(delta === 50 ? 60 : delta);
      expect(
        (await f.pool.query('select delta from assistant_credit_ledger where id=$1', [old])).rows[0]
          .delta,
      ).toBe(delta);
      expect(
        (
          await f.pool.query('select event_id,key from credit_entitlements where ledger_id=$1', [
            old,
          ])
        ).rows,
      ).toHaveLength(delta === 50 ? 1 : 2);
      // A new source at the same venue cannot reopen base credit (place deletion/recreation).
      await sync(user, randomUUID(), venue, 0, true);
      expect(
        (
          await f.pool.query('select balance from assistant_credit_accounts where user_id=$1', [
            user,
          ])
        ).rows[0].balance,
      ).toBe(delta === 50 ? 60 : delta);
    },
  );
  it('serializes sync grant/evaluator/backfill on one account without an inverted tier', async () => {
    const user = await creditUser(f.pool),
      submission = randomUUID(),
      venue = `google:${randomUUID()}`;
    const event = await creditOutbox(f.pool, 'review.published', {
      reviewId: randomUUID(),
      userId: user,
      target: 'place',
      placeId: randomUUID(),
      firstPublication: true,
      grantOwner: 'evaluator',
    });
    await Promise.all([
      sync(user, submission, venue),
      evaluator().evaluate(event),
      attributeLegacyCreditBatch(f.db),
    ]);
    expect(
      (await f.pool.query('select balance from assistant_credit_accounts where user_id=$1', [user]))
        .rows[0].balance,
    ).toBe(65);
  });
  it.each(['grant-first', 'erase-first'] as const)(
    '%s: erasure removes all subject linkage and prevents resurrection',
    async (order) => {
      const user = await creditUser(f.pool),
        review = randomUUID(),
        place = randomUUID();
      const event = await creditOutbox(f.pool, 'review.published', {
        reviewId: review,
        userId: user,
        target: 'place',
        placeId: place,
        firstPublication: true,
        grantOwner: 'evaluator',
      });
      const gated = accountGate(f.db);
      const first =
        order === 'grant-first' ? evaluator(gated.db).evaluate(event) : erase(user, gated.db);
      await gated.held;
      const second = order === 'grant-first' ? erase(user) : evaluator().evaluate(event);
      try {
        // Poll actual lock wait; no timing-only claim that the operations overlapped.
        await expect
          .poll(
            async () =>
              Number(
                (
                  await f.pool.query(
                    "select count(*)::int as n from pg_stat_activity where wait_event_type='Lock' and query like '%pg_advisory_xact_lock%'",
                  )
                ).rows[0].n,
              ),
            { timeout: 5000 },
          )
          .toBeGreaterThan(0);
      } finally {
        gated.release();
      }
      await Promise.all([first, second]);
      const rows = (
        await f.pool.query(
          'select user_id,entitlement_key,id from assistant_credit_ledger where credit_event_id=$1 and entitlement_key like $2',
          [CREDIT_SEEDS[2].id, 'erased:%'],
        )
      ).rows;
      if (order === 'grant-first') {
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.user_id).toBeNull();
          expect(
            (await f.pool.query('select key from credit_entitlements where ledger_id=$1', [row.id]))
              .rows,
          ).toEqual([{ key: row.entitlement_key }]);
        }
      }
      expect(
        (await f.pool.query('select payload from outbox_events where id=$1', [event])).rows[0]
          .payload,
      ).not.toHaveProperty('userId');
      await evaluator().evaluate(event);
      expect(
        (await f.pool.query('select * from assistant_credit_accounts where user_id=$1', [user]))
          .rows,
      ).toEqual([]);
      expect(
        (
          await f.pool.query("select diff from audit_logs where action='credit.granted'")
        ).rows.every((r) => !JSON.stringify(r.diff).includes(user)),
      ).toBe(true);
    },
  );
  it('erases quarantined recipients before a future decoder can pay them', async () => {
    const user = await creditUser(f.pool),
      event = await creditOutbox(
        f.pool,
        'review.published',
        {
          reviewId: randomUUID(),
          userId: user,
          target: 'place',
          placeId: randomUUID(),
          firstPublication: true,
          grantOwner: 'evaluator',
        },
        999,
      );
    await evaluator().evaluate(event);
    await erase(user);
    expect(
      (await f.pool.query('select payload from outbox_events where id=$1', [event])).rows[0]
        .payload,
    ).not.toHaveProperty('userId');
    expect(
      (await f.pool.query('select status from credit_evaluations where event_id=$1', [event]))
        .rows[0].status,
    ).toBe('quarantined');
  });
  it('retains non-subject venue/source keys on erasure', async () => {
    const user = await creditUser(f.pool),
      submission = randomUUID(),
      venue = `google:${randomUUID()}`;
    await sync(user, submission, venue);
    await erase(user);
    expect(
      (
        await f.pool.query('select key from credit_entitlements where key=any($1::text[])', [
          [`venue:${venue}`, `submission:${submission}`],
        ])
      ).rows,
    ).toHaveLength(2);
  });
});

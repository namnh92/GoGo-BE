import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { lockAssistantAccount } from './assistant-credits';
import { AppError } from './app-error';

type Exec = Pick<Db, 'execute'>;
export type CreditCutover = {
  mode: 'sync' | 'evaluator';
  epoch: number;
  first_activated_at: Date | string | null;
};

/** First tier: held through commit; activation must wait for every producer. */
export async function lockCreditCutover(tx: Exec): Promise<CreditCutover> {
  const result = await tx.execute(sql`
    select mode, epoch, first_activated_at from credit_cutover where singleton = true for share`);
  const row = result.rows[0] as CreditCutover | undefined;
  if (!row)
    throw AppError.serviceUnavailable(
      'CREDIT_CUTOVER_NOT_READY',
      'Credit cutover is missing',
      false,
    );
  return row;
}

/** S1 preserves the legacy grant path; S2 installs the ownership-aware writer. */
export function requireSyncCreditWriter(cutover: CreditCutover): void {
  if (cutover.mode !== 'sync')
    throw AppError.serviceUnavailable(
      'CREDIT_WRITER_NOT_READY',
      'This writer requires sync ownership',
      false,
    );
}

/** Before domain rows, after cutover/rules. Never add a lock after a domain lock. */
export async function lockCreditRecipients(
  tx: Exec,
  candidates: readonly string[],
): Promise<Set<string>> {
  const active = new Set<string>();
  for (const id of [...new Set(candidates)].sort()) {
    await lockAssistantAccount(tx, id);
    const result = await tx.execute(
      sql`select id from users where id = ${id} and status = 'active'`,
    );
    if (result.rows.length) active.add(id);
  }
  return active;
}

/** Roll back before re-discovering: acquiring an account under a domain lock inverts erasure. */
export class CreditCandidateChanged extends Error {}

export async function retryCreditDiscovery<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof CreditCandidateChanged)) throw error;
      if (attempt >= 4)
        throw AppError.serviceUnavailable('CREDIT_SNAPSHOT_BUSY', 'Credit snapshot changed; retry');
    }
  }
}

/** Same erasure transaction and account lock as all recipient producers. */
export async function scrubCreditEventRecipients(tx: Exec, userId: string): Promise<void> {
  await tx.execute(sql`
    update outbox_events e set payload =
      case when e.payload->>'userId' = ${userId}
        then (case when e.payload->>'recipientUserId' = ${userId} then e.payload - 'recipientUserId' else e.payload end) - 'userId'
        else e.payload - 'recipientUserId' end
    where e.event_type in ('place.submission_decided', 'place.submission_evidence_approved', 'review.published')
      and (e.payload->>'recipientUserId' = ${userId} or e.payload->>'userId' = ${userId})`);
  await tx.execute(sql`
    update outbox_events e set payload = jsonb_set(e.payload, '{subjects}',
      coalesce((select jsonb_agg(s.value order by s.ordinality)
        from jsonb_array_elements(e.payload->'subjects') with ordinality s(value, ordinality)
        where s.value->>'userId' is distinct from ${userId}), '[]'::jsonb))
    where e.event_type = 'room.completed'
      and e.payload->'subjects' @> jsonb_build_array(jsonb_build_object('userId', ${userId}::text))`);
}

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@gogo/database';
import { NoopMetrics, type MetricsPort } from '@gogo/observability';
import { assertCreditWriterReady, type CreditExec, type CreditRule } from './credit-catalogue';
import {
  CREDIT_EVENT_TYPES,
  CREDIT_TRIGGERS,
  creditEntitlementKey,
  creditSubjectKey,
  matchesCreditCondition,
  validateCreditRule,
  type CanonicalCreditEvent,
} from './credit-triggers';
import {
  CreditCandidateChanged,
  lockCreditRecipients,
  retryCreditDiscovery,
} from './credit-event-protocol';
import { reserveCreditBudget, writeCatalogueGrant } from './credit-grants';
import { flagEnvironmentOf, resolveBooleanFlag } from './feature-flags';

type EventRow = {
  id: string;
  event_type: string;
  payload_schema_version: number;
  payload: Record<string, unknown>;
  occurred_at: Date | string;
};
function discoveredRecipients(payload: Record<string, unknown>): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const candidates = [
    payload.recipientUserId,
    payload.userId,
    ...(Array.isArray(payload.subjects)
      ? payload.subjects.map((s) => (s && typeof s === 'object' ? s.userId : undefined))
      : []),
  ];
  return [
    ...new Set(candidates.filter((v): v is string => z.string().uuid().safeParse(v).success)),
  ].sort();
}
async function acknowledge(
  tx: CreditExec,
  eventId: string,
  grants: number,
  reason: string,
): Promise<void> {
  await tx.execute(sql`insert into credit_evaluations(event_id,status,reason,grants) values(${eventId}::uuid,'evaluated',${reason},${grants})
    on conflict(event_id) do update set status='evaluated',reason=excluded.reason,grants=excluded.grants,evaluated_at=clock_timestamp()`);
}
export class CreditEvaluator {
  constructor(
    private readonly db: Pick<Db, 'execute' | 'transaction'>,
    private readonly options: {
      environment: string;
      subjectKeySecret: string;
      metrics?: MetricsPort;
      quarantine?: (eventId: string, reason: string) => void;
    },
  ) {}
  /** The flag pauses consumption only. Ownership comes exclusively from the payload. */
  async tick(limit = 200): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Evaluator limit must be 1..200');
    if (
      !(await resolveBooleanFlag(this.db, 'credit_events.enabled', {
        environment: flagEnvironmentOf(this.options.environment),
      }))
    )
      return 0;
    await assertCreditWriterReady(this.db);
    creditSubjectKey(this.options.subjectKeySecret, 'readiness');
    const result = await this.db
      .execute(sql`select e.id from outbox_events e left join credit_evaluations c on c.event_id=e.id
      where e.event_type in (${sql.join(
        CREDIT_EVENT_TYPES.map((t) => sql`${t}`),
        sql`, `,
      )})
      and (c.event_id is null or c.status='quarantined') order by e.occurred_at,e.id limit ${limit}`);
    for (const row of result.rows as { id: string }[]) await this.evaluate(row.id);
    return result.rows.length;
  }
  /** Public for deterministic integration replay; worker calls only through tick's pause gate. */
  async evaluate(eventId: string): Promise<void> {
    const outcome = await retryCreditDiscovery(() =>
      this.db.transaction(async (tx) => {
        const discovery = await tx.execute(
          sql`select id,event_type,payload,payload_schema_version,occurred_at from outbox_events where id=${eventId}::uuid`,
        );
        const candidate = discovery.rows[0] as EventRow | undefined;
        if (!candidate || !CREDIT_EVENT_TYPES.includes(candidate.event_type)) return;
        const rulesResult = await tx.execute(
          sql`select * from credit_events where trigger_event_type=${candidate.event_type} and status='active' order by id for update`,
        );
        const lockedIds = discoveredRecipients(candidate.payload);
        const active = await lockCreditRecipients(tx, lockedIds);
        // Outbox/ack locks are deliberately AFTER the accounts erasure needs.
        const current = await tx.execute(
          sql`select id,event_type,payload,payload_schema_version,occurred_at from outbox_events where id=${eventId}::uuid for update`,
        );
        const event = current.rows[0] as EventRow | undefined;
        if (!event) return;
        if (
          event.event_type !== candidate.event_type ||
          discoveredRecipients(event.payload).some((id) => !lockedIds.includes(id))
        )
          throw new CreditCandidateChanged();
        const ack = await tx.execute(
          sql`select status from credit_evaluations where event_id=${eventId}::uuid`,
        );
        if ((ack.rows[0] as { status: string } | undefined)?.status === 'evaluated') return;
        const owner = event.payload?.grantOwner;
        const payloadObject =
          event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload);
        if (
          payloadObject &&
          (owner === 'sync' || owner === 'none' || owner === undefined || owner === null)
        ) {
          await acknowledge(tx, eventId, 0, 'not_evaluator_owned');
          return;
        }
        let canonical: CanonicalCreditEvent;
        const rules = (rulesResult.rows as CreditRule[]).filter(
          (rule) => event.payload_schema_version >= rule.trigger_schema_version,
        );
        try {
          if (owner !== 'evaluator') throw new Error('Invalid grant owner');
          const trigger = CREDIT_TRIGGERS[event.event_type]!;
          const decoder = trigger.decoders[event.payload_schema_version];
          if (typeof decoder !== 'function') throw new Error('Decoder unavailable');
          canonical = decoder(event.payload);
          for (const rule of rules) {
            if (
              rule.condition_version !== 1 ||
              event.payload_schema_version < rule.trigger_schema_version
            )
              throw new Error('Rule version unsupported');
            validateCreditRule(event.event_type, rule.audience, rule.dedup_scope, rule.condition);
          }
        } catch {
          // A recoverable diagnostic, never an ack. Do not persist payload/subject ids in reason.
          await tx.execute(sql`insert into credit_evaluations(event_id,status,reason,grants) values(${eventId}::uuid,'quarantined','decoder_or_rule_unsupported',0)
          on conflict(event_id) do update set status='quarantined',reason=excluded.reason,evaluated_at=clock_timestamp()`);
          return 'quarantined';
        }
        if (!canonical.userIds.length) {
          await acknowledge(tx, eventId, 0, 'no_subject');
          return;
        }
        let grants = 0;
        for (const rule of rules) {
          const occurred = new Date(event.occurred_at).getTime();
          const start =
            String(rule.starts_at).toLowerCase() === '-infinity'
              ? -Infinity
              : new Date(rule.starts_at).getTime();
          if (occurred < start || (rule.ends_at && occurred >= new Date(rule.ends_at).getTime()))
            continue;
          const eligible: { userId: string; key: string }[] = [];
          for (const userId of canonical.userIds) {
            if (!active.has(userId)) continue;
            const subject = creditSubjectKey(this.options.subjectKeySecret, userId);
            if (
              !matchesCreditCondition(rule.condition, {
                ...canonical.facts,
                subject: { key: subject },
              })
            )
              continue;
            const key = creditEntitlementKey(
              rule.dedup_scope,
              canonical,
              eventId,
              subject,
              rule.audience,
            );
            const existing = await tx.execute(
              sql`select ledger_id from credit_entitlements where event_id=${rule.id}::uuid and key=${key}`,
            );
            if (existing.rows.length) continue;
            const count = await tx.execute(
              sql`select count(distinct e.ledger_id)::int as n from credit_entitlements e join assistant_credit_ledger l on l.id=e.ledger_id where e.event_id=${rule.id}::uuid and l.user_id=${userId}::uuid`,
            );
            if (
              rule.max_per_user !== null &&
              Number((count.rows[0] as { n: number }).n) >= rule.max_per_user
            )
              continue;
            eligible.push({ userId, key });
          }
          if (!eligible.length) continue;
          if (rule.audience === 'group' && rule.max_per_group !== null) {
            const count =
              await tx.execute(sql`select count(distinct group_grant_id)::int as n from assistant_credit_ledger
            where credit_event_id=${rule.id}::uuid and group_source_key=${`room:${canonical.sourceId}`}`);
            if (Number((count.rows[0] as { n: number }).n) >= rule.max_per_group) continue;
          }
          if (!(await reserveCreditBudget(tx, rule, rule.amount * eligible.length))) {
            (this.options.metrics ?? new NoopMetrics()).increment(
              'credit_events.budget_insufficient',
              { rule: rule.key },
            );
            continue;
          }
          const groupGrantId = rule.audience === 'group' ? randomUUID() : undefined;
          for (const subject of eligible) {
            await writeCatalogueGrant(tx, rule, subject.userId, subject.key, {
              ...(groupGrantId
                ? { groupGrantId, groupSourceKey: `room:${canonical.sourceId}` }
                : {}),
              ...(canonical.sourceType === 'submission'
                ? {
                    submissionId: canonical.sourceId,
                    venueIdentity: String(canonical.facts.venueIdentity),
                  }
                : {}),
            });
            grants++;
          }
        }
        await acknowledge(tx, eventId, grants, grants ? 'granted' : 'ineligible');
        return 'evaluated';
      }),
    );
    if (outcome === 'quarantined') {
      (this.options.metrics ?? new NoopMetrics()).increment('credit_events.quarantined');
      this.options.quarantine?.(eventId, 'decoder_or_rule_unsupported');
    }
  }
}

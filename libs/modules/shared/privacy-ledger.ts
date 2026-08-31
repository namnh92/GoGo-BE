import { sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';

/**
 * BE-CMS-G12 (#255) — shared pieces of the privacy-request ledger.
 *
 * Lives in `shared` because two modules write the ledger and neither may
 * import the other: the consumer privacy flows (`reviews` module) record
 * self-service requests, and the CMS module runs the support workflow. A
 * ledger with two entry points and two implementations would disagree about
 * SLA arithmetic within a sprint.
 */

export type PrivacyRequestKind = 'export' | 'delete' | 'correction';

export type SlaWindow = { ackHours: number; fulfillHours: number };

/**
 * PROVISIONAL numbers — engineering defaults, not legal policy.
 *
 * The decision on #246 is explicit: production values must be confirmed by
 * Legal against the law in force (Luật 91/2025/QH15, Nghị định 356/2025/NĐ-CP)
 * before they are locked. Until then these are deliberately conservative, and
 * per-type so the eventual table can differ by request type — the one thing
 * the schema must already support, because "one global 72 hours" was ruled
 * out.
 *
 * Override per environment with PRIVACY_SLA_JSON.
 */
export const SLA_DEFAULTS: Record<PrivacyRequestKind, SlaWindow> = {
  export: { ackHours: 72, fulfillHours: 720 },
  delete: { ackHours: 72, fulfillHours: 720 },
  correction: { ackHours: 72, fulfillHours: 720 },
};

export type SlaConfig = Record<PrivacyRequestKind, SlaWindow>;

/** Merges the environment override (already zod-validated) over the defaults. */
export function slaConfigFrom(overrideJson: string): SlaConfig {
  if (!overrideJson) return SLA_DEFAULTS;
  const parsed = JSON.parse(overrideJson) as Partial<Record<PrivacyRequestKind, SlaWindow>>;
  return {
    export: parsed.export ?? SLA_DEFAULTS.export,
    delete: parsed.delete ?? SLA_DEFAULTS.delete,
    correction: parsed.correction ?? SLA_DEFAULTS.correction,
  };
}

export function dueDates(
  config: SlaConfig,
  type: PrivacyRequestKind,
  receivedAt: Date,
): { ackDueAt: Date; fulfillmentDueAt: Date } {
  const window = config[type];
  return {
    ackDueAt: new Date(receivedAt.getTime() + window.ackHours * 3_600_000),
    fulfillmentDueAt: new Date(receivedAt.getTime() + window.fulfillHours * 3_600_000),
  };
}

export function retentionDate(closedAt: Date, months: number): Date {
  const d = new Date(closedAt);
  d.setMonth(d.getMonth() + months);
  return d;
}

/** `2026-08` — the aggregate key. */
export const monthKey = (d: Date): string => d.toISOString().slice(0, 7);

type MetricColumn =
  | 'delete_received'
  | 'delete_completed'
  | 'delete_failed'
  | 'export_received'
  | 'export_completed'
  | 'export_failed'
  | 'correction_received'
  | 'sla_breached'
  | 'no_account_found';

const METRIC_COLUMNS: readonly MetricColumn[] = [
  'delete_received',
  'delete_completed',
  'delete_failed',
  'export_received',
  'export_completed',
  'export_failed',
  'correction_received',
  'sla_breached',
  'no_account_found',
];

/**
 * Bumps monthly counters. Written at the moment of the event, not derived
 * from the requests table later — the requests are hard-deleted after the
 * retention period, and these aggregates are exactly what is meant to survive
 * them (integer counts, nothing joinable back to a person).
 */
export async function bumpPrivacyMetrics(
  db: Pick<Db, 'execute'>,
  month: string,
  columns: MetricColumn[],
): Promise<void> {
  const valid = columns.filter((c) => METRIC_COLUMNS.includes(c));
  if (valid.length === 0) return;
  const sets = valid.map((c) => `${c} = privacy_metrics_monthly.${c} + 1`).join(', ');
  const insertValues = METRIC_COLUMNS.map((c) => (valid.includes(c) ? '1' : '0')).join(', ');
  await db.execute(
    sql.raw(`
      insert into privacy_metrics_monthly (month, ${METRIC_COLUMNS.join(', ')})
      values ('${month.replace(/[^0-9-]/g, '')}', ${insertValues})
      on conflict (month) do update set ${sets}
    `),
  );
}

/**
 * Records a self-service export/delete as a born-completed ledger entry.
 *
 * The operation it describes ran synchronously, so the request is created
 * already closed — no PENDING is faked for something that never pended. It is
 * still recorded, because the ledger is the single source of truth for
 * compliance counts, and a report that silently omits self-service undercounts
 * the majority of real requests.
 *
 * Called inside the same transaction as the operation where one exists, so a
 * rolled-back delete does not leave a ledger row claiming it happened.
 */
export async function recordSelfServiceRequest(
  db: Pick<Db, 'insert' | 'execute'>,
  input: { type: 'export' | 'delete'; userId: string; sla: SlaConfig; retentionMonths: number },
): Promise<void> {
  const now = new Date();
  const { ackDueAt, fulfillmentDueAt } = dueDates(input.sla, input.type, now);
  await db.insert(schema.privacyRequests).values({
    type: input.type,
    source: 'self_service',
    status: 'closed',
    outcome: 'completed',
    subjectType: 'user',
    userId: input.userId,
    identityStatus: 'matched',
    receivedAt: now,
    ackDueAt,
    acknowledgedAt: now,
    fulfillmentDueAt,
    executedAt: now,
    completedAt: now,
    closedAt: now,
    retentionAt: retentionDate(now, input.retentionMonths),
    // Self-service export is handed to the requester in the same response.
    ...(input.type === 'export' ? { deliveryMethod: 'in_app' as const, deliveredAt: now } : {}),
  });
  await bumpPrivacyMetrics(db, monthKey(now), [
    input.type === 'export' ? 'export_received' : 'delete_received',
    input.type === 'export' ? 'export_completed' : 'delete_completed',
  ]);
}

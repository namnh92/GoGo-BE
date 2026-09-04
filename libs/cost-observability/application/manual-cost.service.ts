import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { CostAuditWriter } from '../ports/audit.port';
import {
  MANUAL_COST_PERIODS,
  MANUAL_COST_SOURCE_PREFIX,
  isCalendarDay,
  planManualCosts,
  type ManualCostItem,
  type ManualCostPeriod,
} from '../domain/manual-cost';
import { utcDay } from '../pricing/provider-pricing';
import type { CostRegistry } from '../domain/registry';

/**
 * COST-BE-023 (#382) — epic §27 over two tables: `manual_cost_items` (the
 * record an operator edits, audited) and `provider_cost_daily` (the MANUAL
 * rows derived from it, rebuilt on every change and once a day by the
 * worker so today's share appears without anyone touching the item).
 *
 * The registry decides what may carry a manual cost — a service that has
 * `MANUAL_COST`, own or inherited — and this class asks it; no provider id
 * is compared to a literal here (epic §44.3). A cost row's money is the
 * item's currency: nothing is converted.
 */

export type ManualCostItemInput = {
  providerId: string;
  serviceId: string;
  name: string;
  amountMicros: number;
  currency?: string;
  period: ManualCostPeriod;
  effectiveFrom: string;
  effectiveTo?: string | null;
  note?: string | null;
};

/** Every field optional; `undefined` = leave as is, `null` (where allowed) = clear. */
export type ManualCostItemPatch = {
  [K in keyof ManualCostItemInput]?: ManualCostItemInput[K] | undefined;
};

export type ManualCostActor = { adminId: string | null };

export type EligibleManualService = {
  providerId: string;
  providerDisplayName: string;
  serviceId: string;
  displayName: string;
};

export type MaterialiseResult = {
  environment: string;
  today: string;
  items: number;
  rowsWritten: number;
  rowsDeleted: number;
};

/** A refused write: which field, a stable code, and why — for a 400 with field errors. */
export class ManualCostError extends Error {
  constructor(
    readonly field: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ManualCostError';
  }
}

const CURRENCY = /^[A-Z]{3}$/;
const NAME_MAX = 120;
const NOTE_MAX = 1000;
const INSERT_CHUNK = 500;

export class ManualCostService {
  constructor(
    private readonly db: Db,
    private readonly registry: CostRegistry,
    private readonly options: {
      environment: string;
      now?: () => Date;
      /** #388 — supplied by the composer; see `ports/audit.port.ts`. */
      audit: CostAuditWriter;
    },
  ) {}

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  /** Services a manual item may name, registry order — what the CMS form lists. */
  eligibleServices(): EligibleManualService[] {
    return this.registry.servicesWith('MANUAL_COST').map((s) => ({
      providerId: s.providerId,
      providerDisplayName: this.registry.provider(s.providerId)?.displayName ?? s.providerId,
      serviceId: s.id,
      displayName: s.displayName,
    }));
  }

  async list(): Promise<ManualCostItem[]> {
    const { rows } = await this.db.execute(sql`
      select ${COLUMNS} from manual_cost_items
      where environment = ${this.options.environment}
      order by provider_id, service_id, name, created_at
    `);
    return (rows as unknown as RawItem[]).map(toItem);
  }

  async get(id: string): Promise<ManualCostItem | null> {
    const { rows } = await this.db.execute(sql`
      select ${COLUMNS} from manual_cost_items
      where environment = ${this.options.environment} and id = ${id}
    `);
    const row = rows[0] as RawItem | undefined;
    return row ? toItem(row) : null;
  }

  /**
   * Insert, audit as `cost.manual_item.created`, and materialise so the
   * Cost Center reflects the item in the same request.
   */
  async create(input: ManualCostItemInput, actor: ManualCostActor): Promise<ManualCostItem> {
    const facts = this.validate({
      providerId: input.providerId,
      serviceId: input.serviceId,
      name: input.name,
      amountMicros: input.amountMicros,
      currency: input.currency ?? 'USD',
      period: input.period,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      note: input.note ?? null,
    });
    const { rows } = await this.db.execute(sql`
      insert into manual_cost_items
        (environment, provider_id, service_id, name, amount_micros, currency, period,
         effective_from, effective_to, note, created_by, updated_by)
      values (${this.options.environment}, ${facts.providerId}, ${facts.serviceId}, ${facts.name},
              ${facts.amountMicros}, ${facts.currency}, ${facts.period}, ${facts.effectiveFrom}::date,
              ${facts.effectiveTo}::date, ${facts.note}, ${actor.adminId}, ${actor.adminId})
      returning ${COLUMNS}
    `);
    const item = toItem(rows[0] as unknown as RawItem);
    await this.options.audit(this.db, {
      actorType: actor.adminId ? 'admin' : 'system',
      actorId: actor.adminId,
      action: 'cost.manual_item.created',
      resourceType: 'manual_cost_item',
      resourceId: item.id,
      diff: { after: facts },
    });
    await this.materialise();
    return item;
  }

  /**
   * Partial update; the merged item is validated as a whole (a new
   * `effectiveTo` is checked against the stored `effectiveFrom`). Audited
   * with only the fields that changed, before and after. `null` = no such
   * item in this environment.
   */
  async update(
    id: string,
    patch: ManualCostItemPatch,
    actor: ManualCostActor,
  ): Promise<ManualCostItem | null> {
    const before = await this.get(id);
    if (before === null) return null;
    const facts = this.validate({
      providerId: patch.providerId ?? before.providerId,
      serviceId: patch.serviceId ?? before.serviceId,
      name: patch.name ?? before.name,
      amountMicros: patch.amountMicros ?? before.amountMicros,
      currency: patch.currency ?? before.currency,
      period: patch.period ?? before.period,
      effectiveFrom: patch.effectiveFrom ?? before.effectiveFrom,
      effectiveTo: patch.effectiveTo === undefined ? before.effectiveTo : patch.effectiveTo,
      note: patch.note === undefined ? before.note : patch.note,
    });
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of Object.keys(facts) as (keyof ItemFacts)[]) {
      if (before[key] !== facts[key]) changed[key] = { before: before[key], after: facts[key] };
    }
    if (Object.keys(changed).length === 0) return before;
    const { rows } = await this.db.execute(sql`
      update manual_cost_items set
        provider_id = ${facts.providerId}, service_id = ${facts.serviceId}, name = ${facts.name},
        amount_micros = ${facts.amountMicros}, currency = ${facts.currency}, period = ${facts.period},
        effective_from = ${facts.effectiveFrom}::date, effective_to = ${facts.effectiveTo}::date,
        note = ${facts.note}, updated_by = ${actor.adminId}, updated_at = now()
      where environment = ${this.options.environment} and id = ${id}
      returning ${COLUMNS}
    `);
    const item = toItem(rows[0] as unknown as RawItem);
    await this.options.audit(this.db, {
      actorType: actor.adminId ? 'admin' : 'system',
      actorId: actor.adminId,
      action: 'cost.manual_item.updated',
      resourceType: 'manual_cost_item',
      resourceId: item.id,
      diff: { changed },
    });
    await this.materialise();
    return item;
  }

  /** Delete, audit with the item as it was, and drop its rows. `false` = no such item. */
  async remove(id: string, actor: ManualCostActor): Promise<boolean> {
    const before = await this.get(id);
    if (before === null) return false;
    await this.db.execute(sql`
      delete from manual_cost_items where environment = ${this.options.environment} and id = ${id}
    `);
    await this.options.audit(this.db, {
      actorType: actor.adminId ? 'admin' : 'system',
      actorId: actor.adminId,
      action: 'cost.manual_item.deleted',
      resourceType: 'manual_cost_item',
      resourceId: before.id,
      diff: { before: factsOf(before) },
    });
    await this.materialise();
    return true;
  }

  /**
   * Rebuild this environment's MANUAL rows from its items as of `now`:
   * upsert every planned (day, item) row — touching `updated_at` only when
   * the amount, currency or metadata actually differ — then delete rows an
   * item no longer covers (moved service, shortened range, ended) and rows
   * of items that no longer exist. Idempotent; safe to run every tick.
   */
  async materialise(now: Date = this.now()): Promise<MaterialiseResult> {
    const env = this.options.environment;
    const today = utcDay(now);
    const items = await this.list();
    const plan = planManualCosts(items, today);
    const byId = new Map(items.map((i) => [i.id, i]));
    let rowsWritten = 0;
    for (let at = 0; at < plan.rows.length; at += INSERT_CHUNK) {
      const chunk = plan.rows.slice(at, at + INSERT_CHUNK);
      const values = sql.join(
        chunk.map((r) => {
          const item = byId.get(r.itemId)!;
          const metadata = JSON.stringify({
            itemId: item.id,
            name: item.name,
            period: item.period,
            amountMicros: item.amountMicros,
            effectiveFrom: item.effectiveFrom,
            effectiveTo: item.effectiveTo,
          });
          return sql`(${r.day}::date, ${env}, ${r.providerId}, ${r.serviceId}, ${r.amountMicros}, ${r.currency},
                      'MANUAL', 'HIGH', ${r.source}, ${item.updatedAt}::timestamptz, ${metadata}::jsonb)`;
        }),
        sql`, `,
      );
      const { rows } = await this.db.execute(sql`
        insert into provider_cost_daily
          (day, environment, provider_id, service_id, amount_micros, currency, basis, confidence,
           source, source_as_of, metadata)
        values ${values}
        on conflict (day, environment, provider_id, service_id, coalesce(operation_id, ''),
                     coalesce(usage_metric_id, ''), coalesce(billing_sku_id, ''), source, basis)
        do update set amount_micros = excluded.amount_micros, currency = excluded.currency,
                      metadata = excluded.metadata, source_as_of = excluded.source_as_of,
                      collected_at = now(), updated_at = now()
        where (provider_cost_daily.amount_micros, provider_cost_daily.currency, provider_cost_daily.metadata)
              is distinct from (excluded.amount_micros, excluded.currency, excluded.metadata)
        returning 1
      `);
      rowsWritten += rows.length;
    }
    let rowsDeleted = 0;
    for (const k of plan.keep) {
      const { rows } =
        k.range === null
          ? await this.db.execute(sql`
              delete from provider_cost_daily
              where environment = ${env} and source = ${k.source}
              returning 1
            `)
          : await this.db.execute(sql`
              delete from provider_cost_daily
              where environment = ${env} and source = ${k.source}
                and not (provider_id = ${k.providerId} and service_id = ${k.serviceId}
                         and day between ${k.range.from}::date and ${k.range.to}::date)
              returning 1
            `);
      rowsDeleted += rows.length;
    }
    const live = plan.keep.map((k) => k.source);
    const { rows: orphans } = await this.db.execute(sql`
      delete from provider_cost_daily
      where environment = ${env}
        and substr(source, 1, ${MANUAL_COST_SOURCE_PREFIX.length}) = ${MANUAL_COST_SOURCE_PREFIX}
        ${
          live.length > 0
            ? sql`and source not in (${sql.join(
                live.map((s) => sql`${s}`),
                sql`, `,
              )})`
            : sql``
        }
      returning 1
    `);
    rowsDeleted += orphans.length;
    return { environment: env, today, items: items.length, rowsWritten, rowsDeleted };
  }

  private validate(facts: ItemFacts): ItemFacts {
    const name = facts.name.trim();
    if (name.length === 0 || name.length > NAME_MAX) {
      throw new ManualCostError('name', 'invalid_name', `name must be 1–${NAME_MAX} characters`);
    }
    if (this.registry.provider(facts.providerId) === null) {
      throw new ManualCostError(
        'providerId',
        'unknown_provider',
        `No registered provider ${facts.providerId}`,
      );
    }
    const service = this.registry.service(facts.serviceId);
    if (service === null || service.providerId !== facts.providerId) {
      throw new ManualCostError(
        'serviceId',
        'unknown_service',
        `No registered service ${facts.serviceId} under provider ${facts.providerId}`,
      );
    }
    if (!this.registry.serviceHasCapability(service.id, 'MANUAL_COST')) {
      throw new ManualCostError(
        'serviceId',
        'manual_cost_not_supported',
        `${service.id} does not declare MANUAL_COST; a manual item cannot name it`,
      );
    }
    if (
      !Number.isInteger(facts.amountMicros) ||
      facts.amountMicros < 0 ||
      facts.amountMicros > Number.MAX_SAFE_INTEGER
    ) {
      throw new ManualCostError(
        'amountMicros',
        'invalid_amount',
        'amountMicros must be a non-negative integer',
      );
    }
    if (!CURRENCY.test(facts.currency)) {
      throw new ManualCostError(
        'currency',
        'invalid_currency',
        'currency must be an ISO 4217 code',
      );
    }
    if (!MANUAL_COST_PERIODS.includes(facts.period)) {
      throw new ManualCostError(
        'period',
        'invalid_period',
        `period must be one of ${MANUAL_COST_PERIODS.join(', ')}`,
      );
    }
    if (!isCalendarDay(facts.effectiveFrom)) {
      throw new ManualCostError('effectiveFrom', 'invalid_day', 'effectiveFrom must be YYYY-MM-DD');
    }
    if (facts.effectiveTo !== null) {
      if (!isCalendarDay(facts.effectiveTo)) {
        throw new ManualCostError('effectiveTo', 'invalid_day', 'effectiveTo must be YYYY-MM-DD');
      }
      if (facts.effectiveTo < facts.effectiveFrom) {
        throw new ManualCostError(
          'effectiveTo',
          'invalid_range',
          'effectiveTo must not be before effectiveFrom',
        );
      }
    }
    const note = facts.note === null ? null : facts.note.trim();
    if (note !== null && note.length > NOTE_MAX) {
      throw new ManualCostError(
        'note',
        'invalid_note',
        `note must be at most ${NOTE_MAX} characters`,
      );
    }
    return { ...facts, name, note: note === '' ? null : note };
  }
}

type ItemFacts = Pick<
  ManualCostItem,
  | 'providerId'
  | 'serviceId'
  | 'name'
  | 'amountMicros'
  | 'currency'
  | 'period'
  | 'effectiveFrom'
  | 'effectiveTo'
  | 'note'
>;

function factsOf(item: ManualCostItem): ItemFacts {
  return {
    providerId: item.providerId,
    serviceId: item.serviceId,
    name: item.name,
    amountMicros: item.amountMicros,
    currency: item.currency,
    period: item.period,
    effectiveFrom: item.effectiveFrom,
    effectiveTo: item.effectiveTo,
    note: item.note,
  };
}

const COLUMNS = sql`
  id, environment, provider_id, service_id, name, amount_micros, currency, period,
  to_char(effective_from, 'YYYY-MM-DD') as effective_from,
  to_char(effective_to, 'YYYY-MM-DD') as effective_to,
  note, created_by, created_at, updated_by, updated_at
`;

type RawItem = {
  id: string;
  environment: string;
  provider_id: string;
  service_id: string;
  name: string;
  amount_micros: number | string;
  currency: string;
  period: ManualCostPeriod;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_by: string | null;
  updated_at: Date | string;
};

function toItem(r: RawItem): ManualCostItem {
  return {
    id: r.id,
    environment: r.environment,
    providerId: r.provider_id,
    serviceId: r.service_id,
    name: r.name,
    amountMicros: Number(r.amount_micros),
    currency: r.currency.trim(),
    period: r.period,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    note: r.note,
    createdBy: r.created_by,
    createdAt: new Date(r.created_at).toISOString(),
    updatedBy: r.updated_by,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

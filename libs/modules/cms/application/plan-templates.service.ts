import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';
import { decodeKeysetCursor, encodeKeysetCursor, toIso } from '../../shared/cursor';
import type { ContentAudience } from '../../shared/audience';

/**
 * BE-CMS-G4b (#223) — plan templates the CMS owns.
 *
 * Source material for future plans, never live ones. Nothing here touches
 * `plans`, `plan_stops` or a room: a template is what a plan can be built
 * *from*, and editing one must not reach a plan somebody already has. The
 * user-facing plan flow is not in this file and should not become reachable
 * from it.
 *
 * Money is integer minor units and never travels without its currency and its
 * scope — `per_person` and `per_group` are different numbers, and a client
 * given one without the other has to guess.
 */

export const PLAN_TEMPLATE_STATUSES = ['draft', 'published', 'archived'] as const;
export type PlanTemplateStatus = (typeof PLAN_TEMPLATE_STATUSES)[number];

export const BUDGET_SCOPES = ['per_person', 'per_group'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/**
 * `archived` is terminal, as for recommendations: retiring a template and
 * bringing it back are not the same act, and a template that reappeared would
 * quietly start seeding plans again.
 */
const STATUS_TRANSITIONS: Record<PlanTemplateStatus, PlanTemplateStatus[]> = {
  draft: ['published', 'archived'],
  published: ['draft', 'archived'],
  archived: [],
};

/** A stop is categorised; a template is given a mood. Both stable keys. */
const STOP_TAXONOMY_KIND = 'category';
const TEMPLATE_TAXONOMY_KINDS = ['mood', 'setting'] as const;

export type BudgetRange = {
  min: number;
  max: number;
  currency: string;
  scope: BudgetScope;
};

export type PlanTemplateStopInput = {
  categoryTaxonomyId: string;
  preferredPlaceId?: string | undefined;
  isOptional?: boolean | undefined;
  expectedDurationMinutes: number;
  budget?: BudgetRange | undefined;
  note?: string | undefined;
};

export type PlanTemplateInput = {
  slug: string;
  internalName: string;
  title: string;
  description?: string | undefined;
  locale?: string | undefined;
  audience?: ContentAudience | undefined;
  areaKey?: string | undefined;
  budget?: BudgetRange | undefined;
  expectedDurationMinutes?: number | undefined;
  taxonomyIds?: string[] | undefined;
  stops?: PlanTemplateStopInput[] | undefined;
};

export type PlanTemplatePatch = {
  [K in keyof Omit<PlanTemplateInput, 'slug'>]?: PlanTemplateInput[K] | undefined;
};

export type PlanTemplateListQuery = {
  status?: PlanTemplateStatus | undefined;
  audience?: ContentAudience | undefined;
  areaKey?: string | undefined;
  q?: string | undefined;
  limit: number;
  cursor?: string | undefined;
};

type TemplateRow = {
  id: string;
  slug: string;
  locale: string;
  internal_name: string;
  title: string;
  description: string | null;
  audience: ContentAudience | null;
  area_key: string | null;
  budget_min: string | number | null;
  budget_max: string | number | null;
  budget_currency: string | null;
  budget_scope: BudgetScope | null;
  expected_duration_minutes: number | null;
  status: PlanTemplateStatus;
  stop_count: number;
  taxonomy_keys: { id: string; kind: string; key: string }[];
  created_by_admin_id: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type StopRow = {
  id: string;
  position: number;
  category_taxonomy_id: string;
  category_key: string;
  preferred_place_id: string | null;
  preferred_place_name: string | null;
  is_optional: boolean;
  expected_duration_minutes: number;
  budget_min: string | number | null;
  budget_max: string | number | null;
  budget_currency: string | null;
  budget_scope: BudgetScope | null;
  note: string | null;
};

/** `bigint` arrives as a string from the driver; minor units stay integers. */
const minorUnits = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

@Injectable()
export class PlanTemplatesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(query: PlanTemplateListQuery) {
    const filters: SQL[] = [sql`true`];
    if (query.status) filters.push(sql`t.status = ${query.status}`);
    if (query.audience) filters.push(sql`t.audience = ${query.audience}`);
    if (query.areaKey) filters.push(sql`t.area_key = ${query.areaKey}`);
    if (query.q) {
      const needle = `%${query.q.trim().toLowerCase()}%`;
      filters.push(
        sql`(lower(t.internal_name) like ${needle}
             or lower(t.title) like ${needle}
             or lower(t.slug) like ${needle})`,
      );
    }

    const countWhere = sql.join(filters, sql` and `);
    const pageFilters = [...filters];
    if (query.cursor) {
      const { at, id } = decodeKeysetCursor(query.cursor);
      pageFilters.push(sql`(t.created_at, t.id) < (${at}::timestamptz, ${id}::uuid)`);
    }

    const [page, total] = await Promise.all([
      this.db.execute(sql`
        ${this.selectTemplate()}
        where ${sql.join(pageFilters, sql` and `)}
        order by t.created_at desc, t.id desc
        limit ${query.limit + 1}
      `),
      this.db.execute(sql`select count(*)::int as n from plan_templates t where ${countWhere}`),
    ]);

    const rows = page.rows as TemplateRow[];
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map((r) => this.toDto(r)),
      nextCursor:
        rows.length > query.limit && last ? encodeKeysetCursor(last.created_at, last.id) : null,
      totalCount: (total.rows[0] as { n: number }).n,
    };
  }

  async get(id: string) {
    const row = await this.requireRow(id);
    const stops = await this.db.execute(sql`
      select s.id, s.position, s.category_taxonomy_id, tax.key as category_key,
             s.preferred_place_id, p.name as preferred_place_name,
             s.is_optional, s.expected_duration_minutes,
             s.budget_min, s.budget_max, s.budget_currency, s.budget_scope, s.note
      from plan_template_stops s
      join taxonomies tax on tax.id = s.category_taxonomy_id
      left join places p on p.id = s.preferred_place_id
      where s.template_id = ${id}::uuid
      order by s.position
    `);

    return {
      ...this.toDto(row),
      stops: (stops.rows as StopRow[]).map((s) => ({
        id: s.id,
        position: s.position,
        categoryTaxonomyId: s.category_taxonomy_id,
        categoryKey: s.category_key,
        preferredPlaceId: s.preferred_place_id ?? undefined,
        preferredPlaceName: s.preferred_place_name ?? undefined,
        isOptional: s.is_optional,
        expectedDurationMinutes: s.expected_duration_minutes,
        budget: this.toBudget(s),
        note: s.note ?? undefined,
      })),
    };
  }

  async create(adminId: string, input: PlanTemplateInput) {
    await this.validate(input.taxonomyIds ?? [], input.stops ?? []);

    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.planTemplates)
        .values({
          slug: input.slug,
          locale: input.locale ?? 'vi',
          internalName: input.internalName,
          title: input.title,
          description: input.description ?? null,
          audience: input.audience ?? null,
          areaKey: input.areaKey ?? null,
          ...this.budgetColumns(input.budget),
          expectedDurationMinutes: input.expectedDurationMinutes ?? null,
          createdByAdminId: adminId,
        })
        .returning({ id: schema.planTemplates.id })
        .catch((err: unknown) => {
          throw this.slugConflict(err, input.slug);
        });
      await this.replaceTaxonomies(tx, row!.id, input.taxonomyIds ?? []);
      await this.replaceStops(tx, row!.id, input.stops ?? []);
      return row!.id;
    });

    await this.audit(adminId, 'plan_template.created', id, {
      slug: input.slug,
      stops: input.stops?.length ?? 0,
    });
    return this.get(id);
  }

  async update(adminId: string, id: string, patch: PlanTemplatePatch) {
    const before = await this.requireRow(id);
    await this.validate(patch.taxonomyIds ?? [], patch.stops ?? []);

    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.planTemplates)
        .set({
          ...(patch.internalName !== undefined ? { internalName: patch.internalName } : {}),
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
          ...(patch.audience !== undefined ? { audience: patch.audience } : {}),
          ...(patch.areaKey !== undefined ? { areaKey: patch.areaKey } : {}),
          ...(patch.expectedDurationMinutes !== undefined
            ? { expectedDurationMinutes: patch.expectedDurationMinutes }
            : {}),
          ...(patch.budget !== undefined ? this.budgetColumns(patch.budget) : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.planTemplates.id, id));
      if (patch.taxonomyIds) await this.replaceTaxonomies(tx, id, patch.taxonomyIds);
      if (patch.stops) await this.replaceStops(tx, id, patch.stops);
    });

    await this.audit(adminId, 'plan_template.updated', id, {
      before: { title: before.title, status: before.status },
      after: { ...patch, stops: patch.stops?.length },
    });
    return this.get(id);
  }

  async setStatus(adminId: string, id: string, status: PlanTemplateStatus) {
    const before = await this.requireRow(id);
    if (before.status === status) return { id, status };
    if (!STATUS_TRANSITIONS[before.status].includes(status)) {
      throw AppError.conflict(
        'INVALID_STATUS_TRANSITION',
        `A plan template cannot go from ${before.status} to ${status}`,
      );
    }
    // A template with no stops is not a plan anyone can be given.
    if (status === 'published' && before.stop_count === 0) {
      throw AppError.badRequest('EMPTY_TEMPLATE', 'A published template needs at least one stop', [
        { field: 'stops', code: 'required', message: 'add at least one stop' },
      ]);
    }
    await this.db
      .update(schema.planTemplates)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(schema.planTemplates.id, id));
    await this.audit(adminId, 'plan_template.status_changed', id, {
      before: before.status,
      after: status,
    });
    return { id, status };
  }

  /** Replaces the ordered stop list wholesale; position is the array index. */
  async setStops(adminId: string, id: string, stops: PlanTemplateStopInput[]) {
    await this.requireRow(id);
    await this.validate([], stops);
    await this.db.transaction(async (tx) => {
      await this.replaceStops(tx, id, stops);
    });
    await this.audit(adminId, 'plan_template.stops_set', id, { count: stops.length });
    return this.get(id);
  }

  // ---------------------------------------------------------------- internals

  private selectTemplate(): SQL {
    return sql`
      select t.id, t.slug, t.locale, t.internal_name, t.title, t.description,
             t.audience, t.area_key, t.budget_min, t.budget_max, t.budget_currency,
             t.budget_scope, t.expected_duration_minutes, t.status,
             t.created_by_admin_id, t.created_at, t.updated_at,
             (select count(*)::int from plan_template_stops s where s.template_id = t.id)
               as stop_count,
             coalesce(
               (select jsonb_agg(jsonb_build_object('id', tx.id, 'kind', tx.kind, 'key', tx.key)
                                 order by tx.kind, tx.key)
                from plan_template_taxonomies tt
                join taxonomies tx on tx.id = tt.taxonomy_id
                where tt.template_id = t.id),
               '[]'::jsonb
             ) as taxonomy_keys
      from plan_templates t
    `;
  }

  private toDto(row: TemplateRow) {
    return {
      id: row.id,
      slug: row.slug,
      locale: row.locale,
      internalName: row.internal_name,
      title: row.title,
      description: row.description ?? undefined,
      audience: row.audience ?? undefined,
      areaKey: row.area_key ?? undefined,
      budget: this.toBudget(row),
      expectedDurationMinutes: row.expected_duration_minutes ?? undefined,
      status: row.status,
      stopCount: row.stop_count,
      taxonomies: row.taxonomy_keys,
      createdByAdminId: row.created_by_admin_id,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  /**
   * An amount never leaves without its unit: the range, the currency and what
   * it is per travel as one object or not at all, so no client can render a
   * number whose scope it had to assume.
   */
  private toBudget(row: {
    budget_min: string | number | null;
    budget_max: string | number | null;
    budget_currency: string | null;
    budget_scope: BudgetScope | null;
  }): BudgetRange | undefined {
    const min = minorUnits(row.budget_min);
    const max = minorUnits(row.budget_max);
    if (min === null || max === null || !row.budget_currency || !row.budget_scope) return undefined;
    return { min, max, currency: row.budget_currency, scope: row.budget_scope };
  }

  private budgetColumns(budget: BudgetRange | undefined) {
    return budget
      ? {
          budgetMin: budget.min,
          budgetMax: budget.max,
          budgetCurrency: budget.currency,
          budgetScope: budget.scope,
        }
      : { budgetMin: null, budgetMax: null, budgetCurrency: null, budgetScope: null };
  }

  private async requireRow(id: string): Promise<TemplateRow> {
    const { rows } = await this.db.execute(sql`
      ${this.selectTemplate()} where t.id = ${id}::uuid
    `);
    const row = rows[0] as TemplateRow | undefined;
    if (!row) throw AppError.notFound('PLAN_TEMPLATE_NOT_FOUND', 'Plan template not found');
    return row;
  }

  private async validate(taxonomyIds: string[], stops: PlanTemplateStopInput[]): Promise<void> {
    for (const [index, stop] of stops.entries()) {
      if (stop.budget && stop.budget.min > stop.budget.max) {
        throw AppError.badRequest('INVALID_BUDGET', 'A budget range ends below where it starts', [
          { field: `stops.${index}.budget`, code: 'range', message: 'min must not exceed max' },
        ]);
      }
    }

    await this.assertTaxonomies(taxonomyIds, TEMPLATE_TAXONOMY_KINDS);
    await this.assertTaxonomies(
      stops.map((s) => s.categoryTaxonomyId),
      [STOP_TAXONOMY_KIND],
    );

    const placeIds = stops
      .map((s) => s.preferredPlaceId)
      .filter((id): id is string => id !== undefined);
    if (placeIds.length > 0) {
      const found = await this.db
        .select({ id: schema.places.id })
        .from(schema.places)
        .where(inArray(schema.places.id, [...new Set(placeIds)]));
      const known = new Set(found.map((r) => r.id));
      const missing = placeIds.filter((id) => !known.has(id));
      if (missing.length > 0) {
        throw AppError.badRequest('PLACE_NOT_FOUND', 'A preferred place does not exist', [
          { field: 'stops', code: 'not_found', message: [...new Set(missing)].join(', ') },
        ]);
      }
    }
  }

  private async assertTaxonomies(ids: string[], kinds: readonly string[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    const found = await this.db
      .select({ id: schema.taxonomies.id, kind: schema.taxonomies.kind })
      .from(schema.taxonomies)
      .where(inArray(schema.taxonomies.id, unique));
    if (found.length !== unique.length) {
      throw AppError.badRequest('TAXONOMY_NOT_FOUND', 'A referenced taxonomy does not exist', [
        {
          field: 'taxonomyIds',
          code: 'not_found',
          message: unique.filter((id) => !found.some((f) => f.id === id)).join(', '),
        },
      ]);
    }
    const wrong = found.filter((f) => !kinds.includes(f.kind));
    if (wrong.length > 0) {
      throw AppError.badRequest('TAXONOMY_KIND_INVALID', 'That taxonomy is the wrong kind here', [
        {
          field: 'taxonomyIds',
          code: 'kind',
          message: `expected ${kinds.join(' or ')}, got ${wrong.map((f) => f.kind).join(', ')}`,
        },
      ]);
    }
  }

  private async replaceTaxonomies(
    tx: Pick<Db, 'delete' | 'insert'>,
    templateId: string,
    taxonomyIds: string[],
  ): Promise<void> {
    await tx
      .delete(schema.planTemplateTaxonomies)
      .where(eq(schema.planTemplateTaxonomies.templateId, templateId));
    const unique = [...new Set(taxonomyIds)];
    if (unique.length > 0) {
      await tx
        .insert(schema.planTemplateTaxonomies)
        .values(unique.map((taxonomyId) => ({ templateId, taxonomyId })));
    }
  }

  /**
   * Position is the array index, always.
   *
   * Letting the client send positions invites two stops to claim the same one,
   * or a gap that means nothing; the order it sent them in already carries the
   * intent, and the unique constraint would only turn that into a 500.
   */
  private async replaceStops(
    tx: Pick<Db, 'delete' | 'insert'>,
    templateId: string,
    stops: PlanTemplateStopInput[],
  ): Promise<void> {
    await tx
      .delete(schema.planTemplateStops)
      .where(eq(schema.planTemplateStops.templateId, templateId));
    if (stops.length === 0) return;
    await tx.insert(schema.planTemplateStops).values(
      stops.map((stop, position) => ({
        templateId,
        position,
        categoryTaxonomyId: stop.categoryTaxonomyId,
        preferredPlaceId: stop.preferredPlaceId ?? null,
        isOptional: stop.isOptional ?? false,
        expectedDurationMinutes: stop.expectedDurationMinutes,
        budgetMin: stop.budget?.min ?? null,
        budgetMax: stop.budget?.max ?? null,
        budgetCurrency: stop.budget?.currency ?? null,
        budgetScope: stop.budget?.scope ?? null,
        note: stop.note ?? null,
      })),
    );
  }

  private slugConflict(err: unknown, slug: string): unknown {
    for (let cause: unknown = err; cause instanceof Error; cause = cause.cause) {
      const pg = cause as Error & { code?: string; constraint?: string };
      if (pg.code === '23505' || pg.message.includes('plan_templates_slug_locale_unique')) {
        return AppError.conflict('SLUG_TAKEN', `Template key "${slug}" is already used`);
      }
    }
    return err;
  }

  private audit(adminId: string, action: string, id: string, diff: unknown) {
    return writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action,
      resourceType: 'plan_template',
      resourceId: id,
      diff,
    });
  }
}

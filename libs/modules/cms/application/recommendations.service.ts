import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';
import { decodeKeysetCursor, encodeKeysetCursor, toIso } from '../../shared/cursor';
import type { ContentAudience } from '../../shared/audience';

/**
 * BE-CMS-G4a (#222) — recommendations, as targeted collections (ADR-0009).
 *
 * A recommendation is a named, ordered list of places with a schedule and a
 * status — which is what a collection already is — plus who it is for. It
 * therefore lives in `content_collections` under `kind = 'recommendation'`
 * rather than in a second editorial store the next feature would have to keep
 * in agreement with the first.
 *
 * Two things this deliberately does not do: it does not rank, and it does not
 * choose. Ordering is what an editor dragged; nothing here scores a place.
 */

export const RECOMMENDATION_STATUSES = ['draft', 'scheduled', 'published', 'archived'] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

/**
 * Which status may follow which.
 *
 * Archived is terminal: bringing content back is a new row, not a resurrection,
 * so a link that was retired stays retired. Everything else moves both ways,
 * because scheduling a draft and pulling it back are both ordinary editing.
 */
const STATUS_TRANSITIONS: Record<RecommendationStatus, RecommendationStatus[]> = {
  draft: ['scheduled', 'published', 'archived'],
  scheduled: ['draft', 'published', 'archived'],
  published: ['draft', 'archived'],
  archived: [],
};

/** Taxonomy kinds a recommendation may target. Anything else is a mistake. */
const TARGETABLE_TAXONOMY_KINDS = ['category', 'mood'] as const;

export type RecommendationInput = {
  slug: string;
  internalName: string;
  title: string;
  subtitle?: string | undefined;
  description?: string | undefined;
  locale?: string | undefined;
  audience: ContentAudience;
  areaKey?: string | undefined;
  priority?: number | undefined;
  startsAt?: Date | undefined;
  endsAt?: Date | undefined;
  taxonomyIds?: string[] | undefined;
  placeIds?: string[] | undefined;
};

export type RecommendationPatch = {
  [K in keyof Omit<RecommendationInput, 'slug'>]?: RecommendationInput[K] | undefined;
};

export type RecommendationListQuery = {
  status?: RecommendationStatus | undefined;
  audience?: ContentAudience | undefined;
  areaKey?: string | undefined;
  q?: string | undefined;
  limit: number;
  cursor?: string | undefined;
};

type RecommendationRow = {
  id: string;
  slug: string;
  locale: string;
  internal_name: string | null;
  title: string;
  subtitle: string | null;
  description: string | null;
  audience: ContentAudience | null;
  area_key: string | null;
  priority: number;
  status: RecommendationStatus;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  place_count: number;
  taxonomy_keys: { id: string; kind: string; key: string }[];
  created_by_admin_id: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type PlaceRow = {
  position: number;
  id: string;
  name: string;
  address_text: string | null;
  status: string;
};

@Injectable()
export class RecommendationsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(query: RecommendationListQuery) {
    const filters: SQL[] = [sql`c.kind = 'recommendation'`];
    if (query.status) filters.push(sql`c.status = ${query.status}`);
    if (query.audience) filters.push(sql`c.audience = ${query.audience}`);
    if (query.areaKey) filters.push(sql`c.area_key = ${query.areaKey}`);
    if (query.q) {
      const needle = `%${query.q.trim().toLowerCase()}%`;
      filters.push(
        sql`(lower(c.internal_name) like ${needle}
             or lower(c.title) like ${needle}
             or lower(c.slug) like ${needle})`,
      );
    }

    const countWhere = sql.join(filters, sql` and `);
    const pageFilters = [...filters];
    if (query.cursor) {
      const { at, id } = decodeKeysetCursor(query.cursor);
      // Priority is not in the cursor: it is editable, so a row whose priority
      // changed mid-traversal would move across pages. The traversal is by
      // creation, and priority is what the reader sorts a page by.
      pageFilters.push(sql`(c.created_at, c.id) < (${at}::timestamptz, ${id}::uuid)`);
    }

    const [page, total] = await Promise.all([
      this.db.execute(sql`
        ${this.selectRecommendation()}
        where ${sql.join(pageFilters, sql` and `)}
        order by c.created_at desc, c.id desc
        limit ${query.limit + 1}
      `),
      this.db.execute(
        sql`select count(*)::int as n from content_collections c where ${countWhere}`,
      ),
    ]);

    const rows = page.rows as RecommendationRow[];
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
    const places = await this.db.execute(sql`
      select ci.position, p.id, p.name, p.address_text, p.status
      from collection_items ci
      join places p on p.id = ci.place_id
      where ci.collection_id = ${id}::uuid
      order by ci.position
    `);
    return {
      ...this.toDto(row),
      // The order an editor dragged, read back in that order. `position` is
      // returned rather than implied by the array so a client that reorders
      // locally cannot silently disagree with the server.
      places: (places.rows as PlaceRow[]).map((p) => ({
        position: p.position,
        placeId: p.id,
        name: p.name,
        addressText: p.address_text ?? undefined,
        // A published recommendation quietly holding a suspended place is a
        // bug an editor can only catch if the list shows it.
        status: p.status,
      })),
    };
  }

  async create(adminId: string, input: RecommendationInput) {
    this.assertSchedule(input.startsAt, input.endsAt);
    await this.assertTaxonomies(input.taxonomyIds ?? []);
    await this.assertPlaces(input.placeIds ?? []);

    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.contentCollections)
        .values({
          kind: 'recommendation',
          slug: input.slug,
          locale: input.locale ?? 'vi',
          internalName: input.internalName,
          title: input.title,
          subtitle: input.subtitle ?? null,
          description: input.description ?? null,
          audience: input.audience,
          areaKey: input.areaKey ?? null,
          priority: input.priority ?? 0,
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
          createdByAdminId: adminId,
        })
        .returning({ id: schema.contentCollections.id })
        .catch((err: unknown) => {
          throw this.slugConflict(err, input.slug);
        });
      await this.replaceTaxonomies(tx, row!.id, input.taxonomyIds ?? []);
      await this.replacePlaces(tx, row!.id, input.placeIds ?? []);
      return row!.id;
    });

    await this.audit(adminId, 'recommendation.created', id, {
      slug: input.slug,
      audience: input.audience,
    });
    return this.get(id);
  }

  async update(adminId: string, id: string, patch: RecommendationPatch) {
    const before = await this.requireRow(id);
    this.assertSchedule(
      patch.startsAt ?? (before.starts_at ? new Date(before.starts_at) : undefined),
      patch.endsAt ?? (before.ends_at ? new Date(before.ends_at) : undefined),
    );
    if (patch.taxonomyIds) await this.assertTaxonomies(patch.taxonomyIds);
    if (patch.placeIds) await this.assertPlaces(patch.placeIds);

    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.contentCollections)
        .set({
          ...(patch.internalName !== undefined ? { internalName: patch.internalName } : {}),
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.subtitle !== undefined ? { subtitle: patch.subtitle } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.audience !== undefined ? { audience: patch.audience } : {}),
          ...(patch.areaKey !== undefined ? { areaKey: patch.areaKey } : {}),
          ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
          ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
          ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.contentCollections.id, id));
      if (patch.taxonomyIds) await this.replaceTaxonomies(tx, id, patch.taxonomyIds);
      if (patch.placeIds) await this.replacePlaces(tx, id, patch.placeIds);
    });

    await this.audit(adminId, 'recommendation.updated', id, {
      before: { title: before.title, audience: before.audience, priority: before.priority },
      after: patch,
    });
    return this.get(id);
  }

  /**
   * Status moves along declared edges only. A transition the machine does not
   * have is a 409, not a silent write: "publish an archived recommendation"
   * has to fail loudly, because the alternative is content reappearing on a
   * surface after someone deliberately retired it.
   */
  async setStatus(adminId: string, id: string, status: RecommendationStatus) {
    const before = await this.requireRow(id);
    if (before.status === status) return { id, status };

    if (!STATUS_TRANSITIONS[before.status].includes(status)) {
      throw AppError.conflict(
        'INVALID_STATUS_TRANSITION',
        `A recommendation cannot go from ${before.status} to ${status}`,
      );
    }
    if (status === 'scheduled' && !before.starts_at) {
      throw AppError.badRequest('SCHEDULE_REQUIRED', 'Scheduling needs a start time', [
        { field: 'startsAt', code: 'required', message: 'set a start time before scheduling' },
      ]);
    }
    if (status === 'published' && before.place_count === 0) {
      throw AppError.badRequest('EMPTY_RECOMMENDATION', 'A published recommendation needs places', [
        { field: 'placeIds', code: 'required', message: 'add at least one place' },
      ]);
    }

    await this.db
      .update(schema.contentCollections)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(schema.contentCollections.id, id));
    await this.audit(adminId, 'recommendation.status_changed', id, {
      before: before.status,
      after: status,
    });
    return { id, status };
  }

  /** Replaces the ordered list wholesale; position is the array index. */
  async setPlaces(adminId: string, id: string, placeIds: string[]) {
    await this.requireRow(id);
    await this.assertPlaces(placeIds);
    await this.db.transaction(async (tx) => {
      await this.replacePlaces(tx, id, placeIds);
    });
    await this.audit(adminId, 'recommendation.places_set', id, { count: placeIds.length });
    return this.get(id);
  }

  // ---------------------------------------------------------------- internals

  private selectRecommendation(): SQL {
    return sql`
      select c.id, c.slug, c.locale, c.internal_name, c.title, c.subtitle, c.description,
             c.audience, c.area_key, c.priority, c.status, c.starts_at, c.ends_at,
             c.created_by_admin_id, c.created_at, c.updated_at,
             (select count(*)::int from collection_items ci where ci.collection_id = c.id)
               as place_count,
             coalesce(
               (select jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'key', t.key)
                                 order by t.kind, t.key)
                from content_collection_taxonomies ct
                join taxonomies t on t.id = ct.taxonomy_id
                where ct.collection_id = c.id),
               '[]'::jsonb
             ) as taxonomy_keys
      from content_collections c
    `;
  }

  private toDto(row: RecommendationRow) {
    return {
      id: row.id,
      slug: row.slug,
      locale: row.locale,
      internalName: row.internal_name ?? undefined,
      title: row.title,
      subtitle: row.subtitle ?? undefined,
      description: row.description ?? undefined,
      audience: row.audience ?? undefined,
      areaKey: row.area_key ?? undefined,
      priority: row.priority,
      status: row.status,
      startsAt: row.starts_at ? toIso(row.starts_at) : undefined,
      endsAt: row.ends_at ? toIso(row.ends_at) : undefined,
      placeCount: row.place_count,
      // Stable keys with their kind, so the client resolves labels through
      // i18n rather than the API shipping display text.
      taxonomies: row.taxonomy_keys,
      createdByAdminId: row.created_by_admin_id,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private async requireRow(id: string): Promise<RecommendationRow> {
    const { rows } = await this.db.execute(sql`
      ${this.selectRecommendation()}
      where c.id = ${id}::uuid and c.kind = 'recommendation'
    `);
    const row = rows[0] as RecommendationRow | undefined;
    // A collection id here is a 404, not a 403: the two resources are separate
    // in the contract even though they share a table.
    if (!row) throw AppError.notFound('RECOMMENDATION_NOT_FOUND', 'Recommendation not found');
    return row;
  }

  private assertSchedule(startsAt?: Date | undefined, endsAt?: Date | undefined): void {
    if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw AppError.badRequest('INVALID_SCHEDULE', 'The window ends before it starts', [
        { field: 'endsAt', code: 'range', message: 'endsAt must be after startsAt' },
      ]);
    }
  }

  /**
   * Every referenced place must exist. A recommendation pointing at a place id
   * nothing resolves is a contract error, not a rendering one — the surface
   * would simply show a shorter list and nobody would know why.
   */
  private async assertPlaces(placeIds: string[]): Promise<void> {
    if (placeIds.length === 0) return;
    const unique = new Set(placeIds);
    if (unique.size !== placeIds.length) {
      throw AppError.badRequest('DUPLICATE_PLACE', 'The same place appears twice', [
        { field: 'placeIds', code: 'duplicate', message: 'each place may appear once' },
      ]);
    }
    // Parameterized through the query builder, never string-built SQL: these
    // ids come from a request body.
    const rows = await this.db
      .select({ id: schema.places.id })
      .from(schema.places)
      .where(inArray(schema.places.id, [...unique]));
    if (rows.length !== unique.size) {
      const found = new Set(rows.map((r) => r.id));
      const missing = [...unique].filter((id) => !found.has(id));
      throw AppError.badRequest('PLACE_NOT_FOUND', 'A referenced place does not exist', [
        { field: 'placeIds', code: 'not_found', message: missing.join(', ') },
      ]);
    }
  }

  private async assertTaxonomies(taxonomyIds: string[]): Promise<void> {
    if (taxonomyIds.length === 0) return;
    const unique = [...new Set(taxonomyIds)];
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
    const wrongKind = found.filter(
      (f) => !(TARGETABLE_TAXONOMY_KINDS as readonly string[]).includes(f.kind),
    );
    if (wrongKind.length > 0) {
      throw AppError.badRequest('TAXONOMY_KIND_INVALID', 'That taxonomy cannot target content', [
        {
          field: 'taxonomyIds',
          code: 'kind',
          message: `expected ${TARGETABLE_TAXONOMY_KINDS.join(' or ')}, got ${wrongKind
            .map((f) => f.kind)
            .join(', ')}`,
        },
      ]);
    }
  }

  private async replaceTaxonomies(
    tx: Pick<Db, 'delete' | 'insert'>,
    collectionId: string,
    taxonomyIds: string[],
  ): Promise<void> {
    await tx
      .delete(schema.contentCollectionTaxonomies)
      .where(eq(schema.contentCollectionTaxonomies.collectionId, collectionId));
    const unique = [...new Set(taxonomyIds)];
    if (unique.length > 0) {
      await tx
        .insert(schema.contentCollectionTaxonomies)
        .values(unique.map((taxonomyId) => ({ collectionId, taxonomyId })));
    }
  }

  private async replacePlaces(
    tx: Pick<Db, 'delete' | 'insert'>,
    collectionId: string,
    placeIds: string[],
  ): Promise<void> {
    await tx
      .delete(schema.collectionItems)
      .where(eq(schema.collectionItems.collectionId, collectionId));
    if (placeIds.length > 0) {
      await tx
        .insert(schema.collectionItems)
        .values(placeIds.map((placeId, position) => ({ collectionId, placeId, position })));
    }
  }

  /**
   * Turns the unique-violation into the 409 it is.
   *
   * The driver's error is wrapped by the query builder, so the constraint name
   * lives on the cause rather than the message — matching on the top-level
   * text alone let a duplicate key surface as a 500.
   */
  private slugConflict(err: unknown, slug: string): unknown {
    for (let cause: unknown = err; cause instanceof Error; cause = cause.cause) {
      const pg = cause as Error & { code?: string; constraint?: string };
      const unique = pg.code === '23505';
      const named =
        pg.constraint === 'content_collections_slug_locale_unique' ||
        pg.message.includes('content_collections_slug_locale_unique');
      if (unique || named) {
        return AppError.conflict('SLUG_TAKEN', `Internal key "${slug}" is already used`);
      }
    }
    return err;
  }

  private audit(adminId: string, action: string, id: string, diff: unknown) {
    return writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action,
      resourceType: 'recommendation',
      resourceId: id,
      diff,
    });
  }
}

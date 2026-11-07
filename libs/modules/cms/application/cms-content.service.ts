import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { readTaxonomyVersion } from '../../shared/taxonomy-version';
import { writeAudit } from '../../shared/audit';

type TaxonomyKind = (typeof schema.taxonomies.$inferSelect)['kind'];
type CollectionStatus = (typeof schema.contentCollections.$inferSelect)['status'];

type TaxonomyRow = {
  id: string;
  kind: TaxonomyKind;
  key: string;
  labels: Record<string, string>;
  sort_order: number;
  is_active: boolean;
  usage_count: number;
  synonyms: { id: string; term: string; locale: string }[];
};

type CollectionItemRow = {
  position: number;
  id: string;
  name: string;
  address_text: string | null;
  status: string;
};

/** CMS-005/006 — taxonomy/synonym/localization + editorial collections. */
@Injectable()
export class CmsContentService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async audit(
    adminId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    diff?: unknown,
  ) {
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action,
      resourceType,
      resourceId,
      diff,
    });
  }

  taxonomyVersion() {
    return readTaxonomyVersion(this.db);
  }

  private async taxonomyWrite<T>(
    adminId: string,
    action: string,
    write: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<{
      resourceId: string;
      diff: Record<string, unknown>;
      result: T;
    }>,
  ) {
    return this.db.transaction(async (tx) => {
      // Acquire before touching taxonomy rows: one lock order for all writers.
      await tx.execute(sql`select id from taxonomy_version where id = 1 for update`);
      const change = await write(tx);
      await tx.execute(sql`update taxonomy_version set version = version + 1,
        updated_at = clock_timestamp() where id = 1`);
      const state = await readTaxonomyVersion(tx);
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: adminId,
        action,
        resourceType: action === 'taxonomy.synonym_removed' ? 'taxonomy_synonym' : 'taxonomy',
        resourceId: change.resourceId,
        diff: { ...change.diff, ...state },
      });
      return { ...change.result, ...state };
    });
  }

  async createTaxonomy(
    adminId: string,
    input: {
      kind: TaxonomyKind;
      key: string;
      labels: Record<string, string>;
      sortOrder?: number | undefined;
    },
  ) {
    return this.taxonomyWrite(adminId, 'taxonomy.created', async (tx) => {
      const [row] = await tx
        .insert(schema.taxonomies)
        .values({ kind: input.kind, key: input.key, sortOrder: input.sortOrder ?? 0 })
        .returning();
      for (const [locale, label] of Object.entries(input.labels)) {
        await tx.insert(schema.taxonomyLabels).values({ taxonomyId: row!.id, locale, label });
      }

      return {
        resourceId: row!.id,
        diff: { kind: input.kind, key: input.key },
        result: { id: row!.id },
      };
    });
  }

  async updateTaxonomy(
    adminId: string,
    taxonomyId: string,
    input: {
      labels?: Record<string, string> | undefined;
      sortOrder?: number | undefined;
      isActive?: boolean | undefined;
    },
  ) {
    return this.taxonomyWrite(
      adminId,
      input.isActive === false ? 'taxonomy.deactivated' : 'taxonomy.updated',
      async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.taxonomies)
          .where(eq(schema.taxonomies.id, taxonomyId))
          .limit(1);
        if (!existing) throw AppError.notFound('TAXONOMY_NOT_FOUND', 'Taxonomy not found');

        let references: number | undefined;
        // CMS-005 acceptance: cannot hard-deactivate a referenced key unsafely —
        // deactivation is allowed (hides from pickers) but deletion never happens.
        if (input.isActive === false) {
          const [{ n }] = (await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.placeTaxonomies)
            .where(eq(schema.placeTaxonomies.taxonomyId, taxonomyId))) as [{ n: number }];
          references = n;
        }

        await tx
          .update(schema.taxonomies)
          .set({
            ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(schema.taxonomies.id, taxonomyId));
        if (input.labels) {
          for (const [locale, label] of Object.entries(input.labels)) {
            await tx
              .insert(schema.taxonomyLabels)
              .values({ taxonomyId, locale, label })
              .onConflictDoUpdate({
                target: [schema.taxonomyLabels.taxonomyId, schema.taxonomyLabels.locale],
                set: { label },
              });
          }
        }
        return {
          resourceId: taxonomyId,
          diff: { ...input, references },
          result: { updated: true },
        };
      },
    );
  }

  async addSynonym(
    adminId: string,
    taxonomyId: string,
    input: { term: string; locale?: string | undefined },
  ) {
    return this.taxonomyWrite(adminId, 'taxonomy.synonym_added', async (tx) => {
      await tx
        .insert(schema.taxonomySynonyms)
        .values({ taxonomyId, term: input.term, locale: input.locale ?? 'vi' })
        .onConflictDoNothing();

      return { resourceId: taxonomyId, diff: input, result: { added: true } };
    });
  }

  async removeSynonym(adminId: string, synonymId: string) {
    return this.taxonomyWrite(adminId, 'taxonomy.synonym_removed', async (tx) => {
      await tx.delete(schema.taxonomySynonyms).where(eq(schema.taxonomySynonyms.id, synonymId));

      return { resourceId: synonymId, diff: {}, result: { removed: true } };
    });
  }

  // --- collections (CMS-006) -----------------------------------------------

  async createCollection(
    adminId: string,
    input: {
      slug: string;
      locale?: string | undefined;
      title: string;
      description?: string | undefined;
      startsAt?: Date | undefined;
      endsAt?: Date | undefined;
    },
  ) {
    const [row] = await this.db
      .insert(schema.contentCollections)
      .values({
        slug: input.slug,
        locale: input.locale ?? 'vi',
        title: input.title,
        description: input.description ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        createdByAdminId: adminId,
      })
      .returning();
    await this.audit(adminId, 'collection.created', 'collection', row!.id, { slug: input.slug });
    return { id: row!.id };
  }

  async setCollectionStatus(adminId: string, collectionId: string, status: CollectionStatus) {
    const [row] = await this.db
      .update(schema.contentCollections)
      .set({ status, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.contentCollections.id, collectionId),
          // A recommendation's status moves through its own machine
          // (ADR-0009); this path would skip those checks.
          eq(schema.contentCollections.kind, 'collection'),
        ),
      )
      .returning();
    if (!row) throw AppError.notFound('COLLECTION_NOT_FOUND', 'Collection not found');
    await this.audit(adminId, 'collection.status_changed', 'collection', collectionId, { status });
    return { id: collectionId, status };
  }

  async setCollectionItems(adminId: string, collectionId: string, placeIds: string[]) {
    const [collection] = await this.db
      .select({ id: schema.contentCollections.id })
      .from(schema.contentCollections)
      .where(
        and(
          eq(schema.contentCollections.id, collectionId),
          eq(schema.contentCollections.kind, 'collection'),
        ),
      )
      .limit(1);
    if (!collection) throw AppError.notFound('COLLECTION_NOT_FOUND', 'Collection not found');

    await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.collectionItems)
        .where(eq(schema.collectionItems.collectionId, collectionId));
      if (placeIds.length > 0) {
        await tx
          .insert(schema.collectionItems)
          .values(placeIds.map((placeId, position) => ({ collectionId, placeId, position })));
      }
    });
    await this.audit(adminId, 'collection.items_set', 'collection', collectionId, {
      count: placeIds.length,
    });
    return { count: placeIds.length };
  }

  /**
   * BE-IMP-010 — the CMS taxonomy list.
   *
   * `GET /v1/taxonomies` cannot serve this: it is the consumer endpoint, so it
   * returns active keys only and no usage data. The CMS needs the opposite —
   * deactivated keys, so they can be brought back, and a usage count, because
   * "cannot delete a referenced key" is only enforceable if the count is known
   * before the operator tries.
   */
  async listTaxonomies(filter: {
    kind?: TaxonomyKind | undefined;
    isActive?: boolean | undefined;
  }) {
    const where: SQL[] = [];
    if (filter.kind) where.push(sql`t.kind = ${filter.kind}`);
    if (filter.isActive !== undefined) where.push(sql`t.is_active = ${filter.isActive}`);
    const condition = where.length > 0 ? sql.join(where, sql` and `) : sql`true`;

    const rows = await this.db.execute(sql`
      select t.id, t.kind, t.key, t.sort_order, t.is_active,
             coalesce(
               (select jsonb_object_agg(l.locale, l.label)
                from taxonomy_labels l where l.taxonomy_id = t.id),
               '{}'::jsonb
             ) as labels,
             coalesce(
               (select jsonb_agg(jsonb_build_object('id', s.id, 'term', s.term, 'locale', s.locale)
                                 order by s.term)
                from taxonomy_synonyms s where s.taxonomy_id = t.id),
               '[]'::jsonb
             ) as synonyms,
             (select count(*)::int from place_taxonomies pt where pt.taxonomy_id = t.id)
               as usage_count
      from taxonomies t
      where ${condition}
      order by t.kind, t.sort_order, t.key
    `);

    return (rows.rows as TaxonomyRow[]).map((t) => ({
      id: t.id,
      kind: t.kind,
      key: t.key,
      labels: t.labels,
      sortOrder: t.sort_order,
      isActive: t.is_active,
      /** Places referencing this key — what makes the delete rule checkable. */
      usageCount: t.usage_count,
      synonyms: t.synonyms,
    }));
  }

  /**
   * BE-IMP-011 — read back a collection's ordered places.
   *
   * `setCollectionItems` replaces the list wholesale. Without a read, the only
   * safe edit is to rebuild it from scratch, and the unsafe one — assuming the
   * list is what you last remember — silently drops places.
   *
   * `status` is included because a published collection quietly holding a
   * suspended place is a bug an editor can only catch if the list shows it.
   */
  async listCollectionItems(collectionId: string) {
    const [collection] = await this.db
      .select({ id: schema.contentCollections.id })
      .from(schema.contentCollections)
      .where(
        and(
          eq(schema.contentCollections.id, collectionId),
          eq(schema.contentCollections.kind, 'collection'),
        ),
      )
      .limit(1);
    if (!collection) throw AppError.notFound('COLLECTION_NOT_FOUND', 'Collection not found');

    const rows = await this.db.execute(sql`
      select ci.position, p.id, p.name, p.address_text, p.status
      from collection_items ci
      join places p on p.id = ci.place_id
      where ci.collection_id = ${collectionId}::uuid
      order by ci.position
    `);

    return {
      collectionId,
      items: (rows.rows as CollectionItemRow[]).map((r) => ({
        position: r.position,
        placeId: r.id,
        name: r.name,
        addressText: r.address_text,
        status: r.status,
      })),
    };
  }

  /**
   * Curated collections only.
   *
   * ADR-0009 put recommendations in this table under `kind =
   * 'recommendation'`, because a recommendation is a collection that knows who
   * it is for. This endpoint is the collections screen, which cannot edit
   * targeting — so it must not start listing rows it would silently strip the
   * audience from on the next save.
   */
  async listCollections(filter: { status?: CollectionStatus | undefined }) {
    const rows = await this.db
      .select()
      .from(schema.contentCollections)
      .where(
        and(
          eq(schema.contentCollections.kind, 'collection'),
          ...(filter.status ? [eq(schema.contentCollections.status, filter.status)] : []),
        ),
      )
      .orderBy(asc(schema.contentCollections.slug));
    return rows.map((c) => ({
      id: c.id,
      slug: c.slug,
      locale: c.locale,
      title: c.title,
      status: c.status,
      startsAt: c.startsAt?.toISOString(),
      endsAt: c.endsAt?.toISOString(),
    }));
  }
}

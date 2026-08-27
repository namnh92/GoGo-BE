import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';

type TaxonomyKind = (typeof schema.taxonomies.$inferSelect)['kind'];
type CollectionStatus = (typeof schema.contentCollections.$inferSelect)['status'];

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

  async createTaxonomy(
    adminId: string,
    input: {
      kind: TaxonomyKind;
      key: string;
      labels: Record<string, string>;
      sortOrder?: number | undefined;
    },
  ) {
    const [row] = await this.db
      .insert(schema.taxonomies)
      .values({ kind: input.kind, key: input.key, sortOrder: input.sortOrder ?? 0 })
      .returning();
    for (const [locale, label] of Object.entries(input.labels)) {
      await this.db.insert(schema.taxonomyLabels).values({ taxonomyId: row!.id, locale, label });
    }
    await this.audit(adminId, 'taxonomy.created', 'taxonomy', row!.id, {
      kind: input.kind,
      key: input.key,
    });
    return { id: row!.id };
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
    const [existing] = await this.db
      .select()
      .from(schema.taxonomies)
      .where(eq(schema.taxonomies.id, taxonomyId))
      .limit(1);
    if (!existing) throw AppError.notFound('TAXONOMY_NOT_FOUND', 'Taxonomy not found');

    // CMS-005 acceptance: cannot hard-deactivate a referenced key unsafely —
    // deactivation is allowed (hides from pickers) but deletion never happens.
    if (input.isActive === false) {
      const [{ n }] = (await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.placeTaxonomies)
        .where(eq(schema.placeTaxonomies.taxonomyId, taxonomyId))) as [{ n: number }];
      await this.audit(adminId, 'taxonomy.deactivated', 'taxonomy', taxonomyId, { references: n });
    }

    await this.db
      .update(schema.taxonomies)
      .set({
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(schema.taxonomies.id, taxonomyId));
    if (input.labels) {
      for (const [locale, label] of Object.entries(input.labels)) {
        await this.db
          .insert(schema.taxonomyLabels)
          .values({ taxonomyId, locale, label })
          .onConflictDoUpdate({
            target: [schema.taxonomyLabels.taxonomyId, schema.taxonomyLabels.locale],
            set: { label },
          });
      }
    }
    return { updated: true };
  }

  async addSynonym(
    adminId: string,
    taxonomyId: string,
    input: { term: string; locale?: string | undefined },
  ) {
    await this.db
      .insert(schema.taxonomySynonyms)
      .values({ taxonomyId, term: input.term, locale: input.locale ?? 'vi' })
      .onConflictDoNothing();
    await this.audit(adminId, 'taxonomy.synonym_added', 'taxonomy', taxonomyId, {
      term: input.term,
    });
    return { added: true };
  }

  async removeSynonym(adminId: string, synonymId: string) {
    await this.db.delete(schema.taxonomySynonyms).where(eq(schema.taxonomySynonyms.id, synonymId));
    await this.audit(adminId, 'taxonomy.synonym_removed', 'taxonomy_synonym', synonymId);
    return { removed: true };
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
      .where(eq(schema.contentCollections.id, collectionId))
      .returning();
    if (!row) throw AppError.notFound('COLLECTION_NOT_FOUND', 'Collection not found');
    await this.audit(adminId, 'collection.status_changed', 'collection', collectionId, { status });
    return { id: collectionId, status };
  }

  async setCollectionItems(adminId: string, collectionId: string, placeIds: string[]) {
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

  async listCollections(filter: { status?: CollectionStatus | undefined }) {
    const rows = await this.db
      .select()
      .from(schema.contentCollections)
      .where(filter.status ? and(eq(schema.contentCollections.status, filter.status)) : undefined)
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

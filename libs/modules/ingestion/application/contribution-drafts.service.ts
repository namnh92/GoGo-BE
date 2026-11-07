import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import type { Actor } from '../../identity/domain/actor';
import { DB } from '../../shared/tokens';
import { AppError } from '../../shared/app-error';
import {
  saveContributionDraftSchema,
  type SaveContributionDraft,
} from '../domain/contribution-enrichment';
import {
  assertContributor,
  validateEnrichment,
  contributionStorageFailure,
} from './contribution-enrichment';

const drafts = schema.placeContributionDrafts;
function view(row: typeof drafts.$inferSelect) {
  return {
    id: row.id,
    googlePlaceId: row.googlePlaceId,
    enrichment: row.enrichment,
    verificationStatus: 'unverified' as const,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
@Injectable()
export class ContributionDraftsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async save(actor: Actor, id: string, input: SaveContributionDraft) {
    assertContributor(actor);
    input = saveContributionDraftSchema.parse(input);
    return this.db
      .transaction(async (tx) => {
        // Serialise the per-owner cap, expiry and privacy erasure. No payload in locks/logs.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`assistant:${actor.id}`}, 0))`,
        );
        const active = await tx.execute(
          sql`select id from users where id=${actor.id} and status='active' for share`,
        );
        if (!active.rows.length) throw AppError.forbidden();
        await validateEnrichment(tx, input.enrichment);
        const [current] = await tx.select().from(drafts).where(eq(drafts.id, id)).for('update');
        if (current && current.userId !== actor.id) throw AppError.notFound();
        if (current && current.expiresAt <= new Date()) throw AppError.notFound();
        if ((current?.version ?? 0) !== input.expectedVersion)
          throw AppError.conflict('DRAFT_MODIFIED', 'Draft version changed');
        const values = {
          googlePlaceId: input.googlePlaceId,
          enrichment: input.enrichment,
          updatedAt: sql`clock_timestamp()`,
          expiresAt: sql`clock_timestamp() + interval '30 days'`,
        };
        if (current) {
          const [row] = await tx
            .update(drafts)
            .set({ ...values, version: current.version + 1 })
            .where(eq(drafts.id, id))
            .returning();
          return view(row!);
        }
        const count = await tx.execute(
          sql`select count(*)::int as n from place_contribution_drafts where user_id=${actor.id} and expires_at > now()`,
        );
        if (Number((count.rows[0] as { n: number }).n) >= 20)
          throw AppError.conflict('DRAFT_LIMIT_REACHED', 'At most twenty active drafts');
        // A UUID collision from concurrent owners cannot overwrite another owner's draft.
        const [row] = await tx
          .insert(drafts)
          .values({ id, userId: actor.id, ...values })
          .onConflictDoNothing()
          .returning();
        if (!row) throw AppError.conflict('DRAFT_MODIFIED', 'Draft ID already exists');
        return view(row);
      })
      .catch(contributionStorageFailure);
  }

  async list(actor: Actor) {
    assertContributor(actor);
    const rows = await this.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.userId, actor.id), gt(drafts.expiresAt, sql`now()`)))
      .orderBy(drafts.id)
      .limit(20);
    return { items: rows.map(view) };
  }

  async get(actor: Actor, id: string) {
    assertContributor(actor);
    const [row] = await this.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.userId, actor.id), gt(drafts.expiresAt, sql`now()`)));
    if (!row) throw AppError.notFound();
    return view(row);
  }

  async delete(actor: Actor, id: string, version: number) {
    assertContributor(actor);
    const rows = await this.db
      .delete(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.userId, actor.id), eq(drafts.version, version)))
      .returning({ id: drafts.id });
    if (!rows.length)
      throw AppError.notFound('DRAFT_NOT_FOUND_OR_MODIFIED', 'Draft not found or version changed');
    return { deleted: true };
  }
}

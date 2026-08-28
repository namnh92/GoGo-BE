import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';

/**
 * SG-010 (#49) — defining and stopping experiments.
 *
 * Every change is audited, and the audit is the version record the acceptance
 * asks for: which variants existed, with which shares, from when. Turning an
 * experiment off is a normal write, deliberately — a kill switch that needs a
 * deploy is not one.
 */
@Injectable()
export class ExperimentsAdminService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list() {
    const rows = await this.db
      .select()
      .from(schema.experiments)
      .orderBy(asc(schema.experiments.key));
    return rows.map((row) => ({
      key: row.key,
      description: row.description,
      enabled: row.enabled,
      variants: row.variants,
      // The share left over after the named variants: what control gets.
      controlShare: Number(
        (1 - Object.values(row.variants).reduce((sum, v) => sum + v, 0)).toFixed(4),
      ),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async upsert(
    adminId: string,
    key: string,
    input: { description?: string | undefined; enabled: boolean; variants: Record<string, number> },
  ) {
    const total = Object.values(input.variants).reduce((sum, v) => sum + v, 0);
    if (total > 1) {
      // Over-allocating would silently drop whichever variant sorted last,
      // which is the kind of quiet miscount an experiment cannot survive.
      throw AppError.badRequest(
        'VARIANT_SHARES_EXCEED_ONE',
        'Variant shares must sum to at most 1',
      );
    }

    const [before] = await this.db
      .select()
      .from(schema.experiments)
      .where(eq(schema.experiments.key, key))
      .limit(1);

    const [row] = await this.db
      .insert(schema.experiments)
      .values({
        key,
        description: input.description ?? null,
        enabled: input.enabled,
        variants: input.variants,
        createdByAdminId: adminId,
      })
      .onConflictDoUpdate({
        target: schema.experiments.key,
        set: {
          description: input.description ?? null,
          enabled: input.enabled,
          variants: input.variants,
          updatedAt: sql`now()`,
        },
      })
      .returning();

    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action: before ? 'experiment.updated' : 'experiment.created',
      resourceType: 'experiment',
      resourceId: key,
      diff: {
        before: before ? { enabled: before.enabled, variants: before.variants } : null,
        after: { enabled: input.enabled, variants: input.variants },
      },
    });

    return { key: row!.key, enabled: row!.enabled, variants: row!.variants };
  }
}

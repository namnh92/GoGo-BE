import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { readTaxonomyVersion } from '../../shared/taxonomy-version';
import { ifNoneMatchSatisfied } from '../../administrative/application/administrative-etag';
import { Controller, Get, Headers, Inject, Query, Res } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import { Public } from '../../identity/presentation/decorators';

/**
 * FR-PREF-001/002 — taxonomy comes from the API as stable keys with i18n
 * labels; clients never hard-code business ids. Public: contains no PII and
 * is cacheable.
 */
@Controller('taxonomies')
export class TaxonomyController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Public()
  @Get('version')
  async version(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    const state = await readTaxonomyVersion(this.db);
    return this.answer(
      reply,
      ifNoneMatch,
      'version',
      state.version,
      'public, max-age=0, must-revalidate',
    )
      ? state
      : undefined;
  }

  private answer(
    reply: FastifyReply,
    header: string | undefined,
    scope: string,
    version: number,
    cacheControl = 'public, max-age=60, stale-while-revalidate=300',
  ) {
    const hash = createHash('sha256')
      .update(JSON.stringify([1, version, scope]))
      .digest('base64url');
    const etag = `W/"${hash}"`;
    void reply.header('ETag', etag).header('Cache-Control', cacheControl);
    if (ifNoneMatchSatisfied(header, etag)) {
      void reply.status(304).send();
      return false;
    }
    return true;
  }

  @Public()
  @Get()
  async list(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query('kinds') kinds?: string,
    @Query('locale') locale?: string,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    const wanted = kinds
      ? new Set(
          kinds
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean),
        )
      : null;
    // The generation and rows must come from the same MVCC snapshot.
    return this.db.transaction(
      async (tx) => {
        const state = await readTaxonomyVersion(tx);
        const scope = JSON.stringify(['list', wanted ? [...wanted].sort() : null, locale ?? null]);
        if (!this.answer(reply, ifNoneMatch, scope, state.version)) return undefined;
        const rows = await tx
          .select({
            id: schema.taxonomies.id,
            kind: schema.taxonomies.kind,
            key: schema.taxonomies.key,
            sortOrder: schema.taxonomies.sortOrder,
            locale: schema.taxonomyLabels.locale,
            label: schema.taxonomyLabels.label,
          })
          .from(schema.taxonomies)
          .leftJoin(
            schema.taxonomyLabels,
            eq(schema.taxonomyLabels.taxonomyId, schema.taxonomies.id),
          )
          .where(eq(schema.taxonomies.isActive, true))
          .orderBy(
            asc(schema.taxonomies.kind),
            asc(schema.taxonomies.sortOrder),
            asc(schema.taxonomies.key),
            asc(schema.taxonomyLabels.locale),
          );

        const byKind = new Map<
          string,
          Map<string, { key: string; sortOrder: number; labels: Record<string, string> }>
        >();
        for (const row of rows) {
          if (wanted && !wanted.has(row.kind)) continue;
          const kindMap = byKind.get(row.kind) ?? new Map();
          const entry = kindMap.get(row.key) ?? {
            key: row.key,
            sortOrder: row.sortOrder,
            labels: {},
          };
          if (row.locale && row.label && (!locale || row.locale === locale))
            entry.labels[row.locale] = row.label;
          kindMap.set(row.key, entry);
          byKind.set(row.kind, kindMap);
        }
        return {
          version: state.version,
          kinds: Object.fromEntries(
            [...byKind.entries()].map(([kind, entries]) => [kind, [...entries.values()]]),
          ),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}

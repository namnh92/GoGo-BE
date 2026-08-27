import { Controller, Get, Inject, Query } from '@nestjs/common';
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
  @Get()
  async list(@Query('kinds') kinds?: string) {
    const wanted = kinds
      ? new Set(
          kinds
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean),
        )
      : null;
    const rows = await this.db
      .select({
        id: schema.taxonomies.id,
        kind: schema.taxonomies.kind,
        key: schema.taxonomies.key,
        sortOrder: schema.taxonomies.sortOrder,
        locale: schema.taxonomyLabels.locale,
        label: schema.taxonomyLabels.label,
      })
      .from(schema.taxonomies)
      .leftJoin(schema.taxonomyLabels, eq(schema.taxonomyLabels.taxonomyId, schema.taxonomies.id))
      .where(eq(schema.taxonomies.isActive, true))
      .orderBy(asc(schema.taxonomies.kind), asc(schema.taxonomies.sortOrder));

    const byKind = new Map<
      string,
      Map<string, { key: string; sortOrder: number; labels: Record<string, string> }>
    >();
    for (const row of rows) {
      if (wanted && !wanted.has(row.kind)) continue;
      const kindMap = byKind.get(row.kind) ?? new Map();
      const entry = kindMap.get(row.key) ?? { key: row.key, sortOrder: row.sortOrder, labels: {} };
      if (row.locale && row.label) entry.labels[row.locale] = row.label;
      kindMap.set(row.key, entry);
      byKind.set(row.kind, kindMap);
    }
    return {
      kinds: Object.fromEntries(
        [...byKind.entries()].map(([kind, entries]) => [kind, [...entries.values()]]),
      ),
    };
  }
}

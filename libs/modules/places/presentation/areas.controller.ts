import { Controller, Get, Inject, Query } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '@gogo/database';
import { AREA_AUTOCOMPLETE, GOOGLE_ATTRIBUTION, type AreaAutocompletePort } from '@gogo/providers';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { DB } from '../../shared/tokens';
import { Public, RateLimit } from '../../identity/presentation/decorators';
import { normalizeVietnamese } from '../../search/domain/normalize';

const querySchema = z.object({
  query: z.string().trim().min(1).max(120),
  sessionToken: z.string().trim().min(8).max(64),
});
type AreasDto = z.infer<typeof querySchema>;

/**
 * BE-BFF-016 / FR-PLACE-007 — server-side proxy for area autocomplete.
 * Provider key never reaches clients; sessionToken groups a typing session
 * for billing; provider failure returns the static service-area list.
 */
@Controller('places/areas')
export class AreasController {
  constructor(
    @Inject(AREA_AUTOCOMPLETE) private readonly autocomplete: AreaAutocompletePort,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Public()
  @RateLimit({ action: 'places.areas', limit: 30, windowSeconds: 60, keyBy: 'ip' })
  @Get()
  async suggest(@Query(new ZodValidationPipe(querySchema)) q: AreasDto) {
    try {
      const predictions = await this.autocomplete.suggest(q.query, q.sessionToken);
      return {
        predictions: predictions.slice(0, 8),
        source: 'provider',
        attribution: GOOGLE_ATTRIBUTION,
      };
    } catch {
      // Deterministic fallback (FR-PLACE-007): cached static service areas.
      const areas = await this.db
        .select()
        .from(schema.serviceAreas)
        .where(eq(schema.serviceAreas.isActive, true))
        .orderBy(asc(schema.serviceAreas.sortOrder));
      const needle = normalizeVietnamese(q.query);
      const filtered = areas.filter((a) => normalizeVietnamese(a.name).includes(needle));
      return {
        predictions: (filtered.length > 0 ? filtered : areas).map((a) => ({
          key: a.key,
          description: a.name,
          lat: a.centerLat,
          lng: a.centerLng,
        })),
        source: 'fallback',
        attribution: null,
      };
    }
  }
}

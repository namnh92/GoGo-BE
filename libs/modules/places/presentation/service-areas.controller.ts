import { Controller, Get, Header, Inject } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import { Public, RateLimit } from '../../identity/presentation/decorators';

/**
 * PROF-BE-005 (#535), ADR-0022 — the curated areas a profile may name as its
 * home. The same table the areas autocomplete falls back to, exposed on its
 * own: a picker for a default needs the whole list grouped by city, offline
 * and free, not a per-keystroke provider call with a billing session token.
 *
 * Public and cacheable: it carries no PII and changes when an editor changes
 * it, which is rarely. An hour at the edge is well within how stale a city
 * list may be.
 */
@Controller('service-areas')
export class ServiceAreasController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Public()
  @RateLimit({ action: 'places.service-areas', limit: 60, windowSeconds: 60, keyBy: 'ip' })
  @Header('cache-control', 'public, max-age=3600')
  @Get()
  async list() {
    const rows = await this.db
      .select({
        key: schema.serviceAreas.key,
        name: schema.serviceAreas.name,
        city: schema.serviceAreas.city,
        // The area's centre, so a client that picks one as a room's starting
        // point can set the origin the way the autocomplete fallback does.
        // A curated area's centre is a map fact, not a person's location.
        lat: schema.serviceAreas.centerLat,
        lng: schema.serviceAreas.centerLng,
      })
      .from(schema.serviceAreas)
      .where(eq(schema.serviceAreas.isActive, true))
      .orderBy(asc(schema.serviceAreas.sortOrder), asc(schema.serviceAreas.name));
    return { areas: rows };
  }
}

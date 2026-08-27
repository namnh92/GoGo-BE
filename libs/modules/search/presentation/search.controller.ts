import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Public, RateLimit } from '../../identity/presentation/decorators';
import { decodeCursor, SearchService } from '../application/search.service';

const csv = (max: number) =>
  z
    .string()
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, max),
    )
    .optional();

/**
 * FR-SEARCH-002 (SE-010): multi-category, free-form radius and per-person
 * price bounds, suited-for, lodging opt-in, open-at.
 */
const searchQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusM: z.coerce.number().int().min(100).max(100_000).optional(),
    openAt: z
      .union([z.literal('now'), z.string().datetime({ offset: true })])
      .transform((v) => (v === 'now' ? new Date() : new Date(v)))
      .optional(),
    categories: csv(10),
    suitedFor: z.enum(['couple', 'group', 'family']).optional(),
    priceMinPerPerson: z.coerce.number().int().min(0).optional(),
    priceMaxPerPerson: z.coerce.number().int().min(0).optional(),
    minRating: z.coerce.number().min(0).max(5).optional(),
    dietary: csv(10),
    accessibility: csv(10),
    includeLodging: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    sort: z.enum(['relevance', 'distance', 'rating', 'price', 'curated']).default('relevance'),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine((v) => v.sort !== 'distance' || (v.lat !== undefined && v.lng !== undefined), {
    message: 'distance sort requires lat/lng',
    path: ['sort'],
  });

type SearchQueryDto = z.infer<typeof searchQuerySchema>;

@Controller('places')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Public()
  @RateLimit({ action: 'places.search', limit: 60, windowSeconds: 60, keyBy: 'ip' })
  @Get('search')
  async searchPlaces(@Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQueryDto) {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    return this.search.search({
      q: query.q,
      lat: query.lat,
      lng: query.lng,
      radiusM: query.radiusM ?? (query.lat !== undefined ? 10_000 : undefined),
      openAt: query.openAt,
      categories: query.categories,
      suitedFor: query.suitedFor,
      priceMinPerPerson: query.priceMinPerPerson,
      priceMaxPerPerson: query.priceMaxPerPerson,
      minRating: query.minRating,
      dietary: query.dietary,
      accessibility: query.accessibility,
      includeLodging: query.includeLodging,
      sort: query.sort,
      limit: query.limit,
      cursor,
      scoredAt: cursor?.scoredAt ?? new Date(),
    });
  }

  @Public()
  @RateLimit({ action: 'places.detail', limit: 120, windowSeconds: 60, keyBy: 'ip' })
  @Get(':id')
  placeDetail(@Param('id', new ZodValidationPipe(z.string().uuid())) id: string) {
    return this.search.placeDetail(id);
  }
}

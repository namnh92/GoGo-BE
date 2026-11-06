import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Public, RateLimit } from '../../identity/presentation/decorators';
import { decodeCursor, SearchService } from '../application/search.service';

const csv = (max: number) =>
  z
    .string()
    .transform((v) => [
      ...new Set(
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(z.string().min(1).max(64)).max(max))
    .optional();

/**
 * FR-SEARCH-002 (SE-010): multi-category, free-form radius and per-person
 * price bounds, suited-for, lodging opt-in, open-at.
 */
export const searchQuerySchema = z
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
    suitedFor: csv(10),
    amenities: csv(10),
    moods: csv(10),
    settings: csv(10),
    locale: z.enum(['vi', 'en']).default('vi'),
    includeTotal: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    priceMinPerPerson: z.coerce.number().int().min(0).optional(),
    priceMaxPerPerson: z.coerce.number().int().min(0).optional(),
    minRating: z.coerce.number().min(0).max(5).optional(),
    dietary: csv(10),
    accessibility: csv(10),
    includeLodging: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    // ADM-021 (#568): a canonical area as the fallback scope when the client
    // has no usable position. Codes only; labels come back in meta.location.
    datasetVersion: z.string().trim().min(1).max(200).optional(),
    provinceCode: z
      .string()
      .regex(/^\d{2,5}$/)
      .optional(),
    communeCode: z
      .string()
      .regex(/^\d{2,5}$/)
      .optional(),
    sort: z.enum(['relevance', 'distance', 'rating', 'price', 'curated']).default('relevance'),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: 'lat/lng go together',
    path: ['lat'],
  })
  .refine(
    (v) =>
      v.priceMinPerPerson === undefined ||
      v.priceMaxPerPerson === undefined ||
      v.priceMinPerPerson <= v.priceMaxPerPerson,
    { message: 'price range is inverted', path: ['priceMinPerPerson'] },
  )
  .refine((v) => v.sort !== 'distance' || (v.lat !== undefined && v.lng !== undefined), {
    message: 'distance sort requires lat/lng',
    path: ['sort'],
  })
  .refine((v) => (v.provinceCode === undefined) === (v.datasetVersion === undefined), {
    message: 'provinceCode and datasetVersion go together',
    path: ['provinceCode'],
  })
  .refine((v) => v.communeCode === undefined || v.provinceCode !== undefined, {
    message: 'communeCode requires provinceCode',
    path: ['communeCode'],
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
      amenities: query.amenities,
      moods: query.moods,
      settings: query.settings,
      locale: query.locale,
      includeTotal: query.includeTotal,
      priceMinPerPerson: query.priceMinPerPerson,
      priceMaxPerPerson: query.priceMaxPerPerson,
      minRating: query.minRating,
      dietary: query.dietary,
      accessibility: query.accessibility,
      includeLodging: query.includeLodging,
      ...(query.provinceCode && query.datasetVersion
        ? {
            administrativeArea: {
              datasetVersion: query.datasetVersion,
              provinceCode: query.provinceCode,
              communeCode: query.communeCode ?? null,
            },
          }
        : {}),
      sort: query.sort,
      limit: query.limit,
      cursor,
      scoredAt: cursor?.scoredAt ?? new Date(),
    });
  }

  @Public()
  @RateLimit({ action: 'places.detail', limit: 120, windowSeconds: 60, keyBy: 'ip' })
  @Get(':id')
  // GoGo-BE#217 — the GoGo rating is computed per read from published reviews,
  // so a moderation decision (publish, reject, emergency hide) holds on the
  // next read; no cache may serve the population from before it.
  @Header('cache-control', 'no-store')
  placeDetail(@Param('id', new ZodValidationPipe(z.string().uuid())) id: string) {
    return this.search.placeDetail(id);
  }
}

import { Controller, Get, Headers, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/app-error';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Public, RateLimit } from '../../identity/presentation/decorators';
import {
  AdministrativeQueryService,
  MAX_LIMIT,
  type Page,
  type UnitDto,
} from '../application/administrative-query.service';
import { administrativeEtag, ifNoneMatchSatisfied } from '../application/administrative-etag';
import { NoPublishedDatasetError } from '../application/administrative-dataset.port';
import type { DatasetSnapshot } from '../domain/snapshot';

/**
 * ADM-003 (#456) / ADR-0019 — the public administrative read API.
 *
 * Public and unauthenticated: the list of Vietnam's provinces is not GoGo's
 * secret, it carries no PII, and every client needs it before a user has signed
 * in. Rate-limited by IP all the same, because it is cheap to call and cheap to
 * abuse.
 *
 * **Legacy is excluded by default, everywhere.** District-level units were
 * dissolved on 2025-07-01, and a caller who does not ask for history must never
 * be handed it — an address form offering "Quận Ba Đình" would be offering
 * something that no longer exists.
 *
 * These are the first endpoints in this API to carry an `ETag`, which ADR-0019
 * introduces for exactly this shape of resource: immutable per version, read far
 * more often than it changes.
 *
 * The per-action limit is 120/minute, matching the anonymous baseline the guard
 * already applies to every route. Lower would be the binding constraint on a
 * normal session — an address form loads the provinces, then one province's
 * communes, then a search per keystroke — and higher would be a limit that never
 * fires, because the baseline stops the caller first.
 */

const CODE = z
  .string()
  .trim()
  .regex(/^[0-9]{2,5}$/, 'an administrative code is 2 to 5 digits');

/**
 * A date, not a timestamp. "What did this code mean" is answered per day, and
 * an ISO date keeps the ETag free of a clock.
 */
const AT_DATE = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'at must be an ISO date (YYYY-MM-DD)')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'at is not a real date');

const pagination = {
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  cursor: z.string().trim().max(64).optional(),
};

/** Absent means false. Only the two spellings a client would reasonably send. */
const INCLUDE_LEGACY = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

const listQuery = z.object(pagination);
const unitQuery = z.object({ includeLegacy: INCLUDE_LEGACY });
const searchQuery = z.object({
  query: z.string().trim().min(1).max(120),
  provinceCode: CODE.optional(),
  includeLegacy: INCLUDE_LEGACY,
  ...pagination,
});
const resolveQuery = z.object({ code: CODE, at: AT_DATE.optional() });

@Controller('administrative')
export class AdministrativeController {
  constructor(private readonly service: AdministrativeQueryService) {}

  /**
   * Every handler goes through here, so no endpoint can forget its
   * `datasetVersion` or its `ETag`, and the 304 path is written once.
   *
   * `parts` is the *resolved* request — defaults applied, values canonicalised —
   * which is what lets two spellings of one request share a tag while two
   * genuinely different requests cannot.
   */
  private async answer<T extends object>(
    reply: FastifyReply,
    ifNoneMatch: string | undefined,
    route: string,
    parts: Record<string, string | number | boolean | null | undefined>,
    body: (snapshot: DatasetSnapshot) => T,
  ): Promise<(T & { datasetVersion: string }) | undefined> {
    let snapshot: DatasetSnapshot;
    try {
      snapshot = await this.service.snapshot();
    } catch (error) {
      if (error instanceof NoPublishedDatasetError) {
        // Not an empty list. An empty list would read as "Vietnam has no
        // provinces"; this is an operational fault and says so, loudly enough
        // for the alert in #463 to key on.
        throw AppError.serviceUnavailable(
          'ADMINISTRATIVE_DATASET_UNAVAILABLE',
          'no administrative dataset is published',
        );
      }
      throw error;
    }

    const etag = administrativeEtag(snapshot.datasetVersion, route, parts);
    void reply.header('ETag', etag);
    // Immutable per version, but the *active version* can change under a
    // client, so revalidation rather than a long max-age.
    void reply.header('Cache-Control', 'public, max-age=0, must-revalidate');
    if (ifNoneMatchSatisfied(ifNoneMatch, etag)) {
      void reply.status(304).send();
      return undefined;
    }
    return { datasetVersion: snapshot.datasetVersion, ...body(snapshot) };
  }

  /**
   * The cheap poll. A client holding a snapshot asks this and refetches only
   * when `datasetVersion` changes.
   */
  @Public()
  @RateLimit({ action: 'administrative.version', limit: 120, windowSeconds: 60, keyBy: 'ip' })
  @Get('version')
  async version(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    return this.answer(reply, ifNoneMatch, 'version', {}, (s) => this.service.version(s));
  }

  @Public()
  @RateLimit({ action: 'administrative.read', limit: 120, windowSeconds: 60, keyBy: 'ip' })
  @Get('provinces')
  async provinces(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    return this.answer<Page<UnitDto>>(
      reply,
      ifNoneMatch,
      'provinces',
      { limit: q.limit ?? null, cursor: q.cursor ?? null },
      (s) => this.service.provinces(s, q),
    );
  }

  @Public()
  @RateLimit({ action: 'administrative.read', limit: 120, windowSeconds: 60, keyBy: 'ip' })
  @Get('provinces/:provinceCode/communes')
  async communes(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('provinceCode', new ZodValidationPipe(CODE)) provinceCode: string,
    @Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    return this.answer<Page<UnitDto>>(
      reply,
      ifNoneMatch,
      'communes',
      { provinceCode, limit: q.limit ?? null, cursor: q.cursor ?? null },
      (s) => this.service.communes(s, provinceCode, q),
    );
  }

  @Public()
  @RateLimit({ action: 'administrative.read', limit: 120, windowSeconds: 60, keyBy: 'ip' })
  @Get('search')
  async search(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query(new ZodValidationPipe(searchQuery)) q: z.infer<typeof searchQuery>,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    return this.answer<Page<UnitDto>>(
      reply,
      ifNoneMatch,
      'search',
      {
        query: q.query,
        provinceCode: q.provinceCode ?? null,
        includeLegacy: q.includeLegacy,
        limit: q.limit ?? null,
        cursor: q.cursor ?? null,
      },
      (s) => this.service.search(s, q),
    );
  }

  @Public()
  @RateLimit({ action: 'administrative.read', limit: 120, windowSeconds: 60, keyBy: 'ip' })
  @Get('resolve')
  async resolve(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query(new ZodValidationPipe(resolveQuery)) q: z.infer<typeof resolveQuery>,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    return this.answer(reply, ifNoneMatch, 'resolve', { code: q.code, at: q.at ?? null }, (s) =>
      this.service.resolve(s, q.code, q.at ?? null),
    );
  }

  /**
   * Declared last. Nest matches in declaration order, so `units/:code` is not
   * given the chance to swallow a sibling literal path.
   */
  @Public()
  @RateLimit({ action: 'administrative.read', limit: 120, windowSeconds: 60, keyBy: 'ip' })
  @Get('units/:code')
  async unit(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('code', new ZodValidationPipe(CODE)) code: string,
    @Query(new ZodValidationPipe(unitQuery)) q: z.infer<typeof unitQuery>,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    return this.answer(reply, ifNoneMatch, 'unit', { code, includeLegacy: q.includeLegacy }, (s) =>
      this.service.unit(s, code, q.includeLegacy),
    );
  }
}

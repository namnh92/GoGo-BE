import { submissionEnrichmentViewSchema } from '../domain/submission-enrichment-view';
import { SubmissionDisplayService } from './submission-display.service';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import type { Actor } from '../../identity/domain/actor';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type MediaConfig } from '../../shared/config';
import { encodeKeysetCursor, toIso } from '../../shared/cursor';
import { publicCatalogueUrl } from '../../shared/media-url';
import { DB } from '../../shared/tokens';
import type { SubmissionRejectionReason } from '../domain/submission-rejection';

type DisplayAnswer =
  | Awaited<ReturnType<SubmissionDisplayService['get']>>
  | { providerStatus: 'deferred'; providerDisplay: undefined };

const cursorTuple = z.tuple([z.string().datetime({ offset: true }), z.string().uuid()]);

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = cursorTuple.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    return { at, id };
  } catch {
    throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid');
  }
}

type SubmissionRow = {
  id: string;
  google_place_id: string;
  category_key: string | null;
  address_short: string | null;
  own_input: {
    categoryKey?: string;
    priceMin?: number;
    priceMax?: number;
    priceUnit?: string;
    vibeKeys?: string[];
    note?: string;
  } | null;
  own_enrichment: unknown;
  status: 'pending' | 'approved' | 'rejected' | 'merged';
  rejection_reason: SubmissionRejectionReason | null;
  name: string | null;
  photo_key: string | null;
  result_place_id: string | null;
  created_at: string;
  updated_at: Date | string;
  decided_at: Date | string | null;
};

/** Account contribution history; never reuse the moderator's richer projection. */
@Injectable()
export class MyPlaceSubmissionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: MediaConfig,
    private readonly display: SubmissionDisplayService,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  async detail(actor: Actor, id: string) {
    if (actor.type !== 'user') throw AppError.forbidden();
    const rows = await this.query(actor, [sql`s.id = ${id}::uuid`], 1);
    const row = rows[0];
    if (!row) throw AppError.notFound('SUBMISSION_NOT_FOUND', 'Submission not found');
    const [item] = await this.project([row]);
    const enrichment = submissionEnrichmentViewSchema.safeParse(row.own_enrichment);
    const input = row.own_input;
    return {
      ...item!,
      ...(input || enrichment.success
        ? {
            contribution: {
              verificationStatus: 'unverified' as const,
              ...(input?.categoryKey ? { categoryKey: input.categoryKey } : {}),
              ...(input?.priceMin != null && input?.priceMax != null && input?.priceUnit
                ? {
                    estimatedPrice: {
                      min: input.priceMin,
                      max: input.priceMax,
                      unit: input.priceUnit,
                      currency: 'VND' as const,
                    },
                  }
                : {}),
              ...(input?.vibeKeys ? { vibeKeys: input.vibeKeys } : {}),
              ...(input?.note ? { note: input.note } : {}),
              ...(enrichment.success ? { enrichment: enrichment.data } : {}),
            },
          }
        : {}),
    };
  }

  async list(actor: Actor, options: { limit: number; cursor?: string | undefined }) {
    if (actor.type !== 'user') throw AppError.forbidden();
    const where = [];
    if (options.cursor !== undefined) {
      const { at, id } = decodeCursor(options.cursor);
      where.push(sql`(s.created_at, s.id) < (${at}::timestamptz, ${id}::uuid)`);
    }
    const rows = await this.query(actor, where, options.limit + 1);
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      items: await this.project(page),
      // Keep Postgres microseconds; JS Date would skip rows within a millisecond.
      nextCursor:
        rows.length > options.limit && last ? encodeKeysetCursor(last.created_at, last.id) : null,
    };
  }

  private async query(actor: Actor, where: ReturnType<typeof sql>[], limit: number) {
    const started = performance.now();
    const result = await this.db
      .execute(
        sql`
      select s.id, s.status, s.result_place_id, s.rejection_reason, s.google_place_id,
             st.key as category_key, p.address_text as address_short,
             case when s.submitted_by_user_id = ${actor.id}::uuid then
               jsonb_strip_nulls(jsonb_build_object('categoryKey', s.category_key,
                 'priceMin', s.price_min, 'priceMax', s.price_max, 'priceUnit', s.price_unit,
                 'vibeKeys', s.vibe_keys, 'note', s.note)) end as own_input,
             case when s.submitted_by_user_id = ${actor.id}::uuid
               then to_jsonb(s)->'enrichment' end as own_enrichment,
             coalesce(p.name, nullif(s.review_draft->>'name', '')) as name,
             m.storage_key as photo_key,
             to_char(s.created_at at time zone 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
             s.updated_at, s.decided_at
      from place_submissions s
      left join places p on p.id = s.result_place_id
      left join taxonomies st on st.kind = 'category' and st.key = s.category_key and st.is_active = true
      left join lateral (
        select storage_key from place_media
        where place_id = p.id and moderation = 'approved'
          and source_type in ('editorial', 'community')
          and storage_key like 'places/%'
        order by is_cover desc, sort_order, created_at, id
        limit 1
      ) m on true
      where (s.submitted_by_user_id = ${actor.id}::uuid or exists (
        select 1 from place_submission_contributors c
        where c.submission_id = s.id and c.user_id = ${actor.id}::uuid
      )) ${where.length ? sql`and ${sql.join(where, sql` and `)}` : sql``}
      order by s.created_at desc, s.id desc
      limit ${limit}
    `,
      )
      .finally(() => {
        this.metrics.observe('my_place_submissions_query_duration_ms', performance.now() - started);
      });
    const rows = result.rows as SubmissionRow[];
    return rows;
  }

  private async project(rows: SubmissionRow[]) {
    const deadline = performance.now() + 6000;
    const liveById = new Map<string, Promise<DisplayAnswer>>();
    let next = 0;
    const projected = new Array<ReturnType<typeof projectRow>>(rows.length);
    const display = this.display;
    const config = this.config;
    function projectRow(row: SubmissionRow, live: DisplayAnswer) {
      return {
        id: row.id,
        status: row.status,
        ...(row.name || live.providerDisplay?.name
          ? { name: row.name || live.providerDisplay!.name }
          : {}),
        ...(row.address_short || live.providerDisplay?.addressShort
          ? { addressShort: row.address_short || live.providerDisplay!.addressShort }
          : {}),
        ...(row.category_key || live.providerDisplay?.categoryKey
          ? { categoryKey: row.category_key || live.providerDisplay!.categoryKey }
          : {}),
        ...live,
        ...(publicCatalogueUrl(config.MEDIA_PUBLIC_BASE_URL, row.photo_key)
          ? { photoUrl: publicCatalogueUrl(config.MEDIA_PUBLIC_BASE_URL, row.photo_key)! }
          : {}),
        // Only the stored public key is safe; historical rows may not have one.
        ...(row.status === 'rejected' && row.rejection_reason
          ? { rejectionReason: row.rejection_reason }
          : {}),
        ...((row.status === 'approved' || row.status === 'merged') && row.result_place_id
          ? { placeId: row.result_place_id }
          : {}),
        createdAt: row.created_at,
        updatedAt: toIso(row.updated_at),
        ...(row.decided_at ? { decidedAt: toIso(row.decided_at) } : {}),
      };
    }
    await Promise.all(
      Array.from({ length: Math.min(4, rows.length) }, async () => {
        while (next < rows.length) {
          const index = next++;
          const row = rows[index]!;
          let pending = liveById.get(row.google_place_id);
          if (!pending) {
            pending =
              performance.now() < deadline
                ? display.get(row.google_place_id, deadline)
                : Promise.resolve({ providerStatus: 'deferred', providerDisplay: undefined });
            liveById.set(row.google_place_id, pending);
          }
          projected[index] = projectRow(row, await pending);
        }
      }),
    );
    return projected;
  }
}

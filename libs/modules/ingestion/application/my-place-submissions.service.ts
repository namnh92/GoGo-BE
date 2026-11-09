import { submissionPhotoView, updateDeadline } from '../domain/submission-provider-photo';
import { communityPhotoUrl, isSubmissionPhotoKey } from '../../shared/submission-photo-url';
import {
  freshSnapshot,
  submissionDisplaySnapshotSchema,
} from '../domain/submission-display-snapshot';
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
  display_snapshot: unknown;
  provider_photo: unknown;
  cover: {
    id: string;
    storage_key: string;
    source_type: string;
    attribution: string | null;
    width: number | null;
    height: number | null;
    provider_photo: {
      authorAttributions: { displayName: string; uri: string | null; photoUri: string | null }[];
      googleMapsUri: string | null;
    } | null;
  } | null;
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
    let live = this.storedDisplay(row);
    if (!live.providerDisplay && row.status !== 'approved' && row.status !== 'merged') {
      // Atomic lease prevents concurrent stale reads from all buying Details.
      // No transaction/row lock is held while the provider runs. Failed attempts
      // may retry after 60s; successful refreshes stay fresh for 30 days.
      const claimed = await this.db.execute(sql`update place_submissions
        set display_refresh_started_at = clock_timestamp()
        where id = ${row.id}::uuid and status in ('pending', 'rejected')
          and (display_snapshot is null or (display_snapshot->>'fetchedAt')::timestamptz < now() - interval '30 days')
          and (display_refresh_started_at is null or display_refresh_started_at < now() - interval '60 seconds')
        returning id`);
      if (claimed.rows.length) {
        live = await this.display.get(row.google_place_id, { photos: false });
        if (live.providerDisplay) {
          // Strip the transient photo before writing. Never bump submission's
          // review concurrency token/updatedAt for a display-only refresh.
          const snapshot = submissionDisplaySnapshotSchema.parse(live.providerDisplay);
          await this.db
            .execute(sql`update place_submissions set display_snapshot = ${JSON.stringify(snapshot)}::jsonb
            where id = ${row.id}::uuid and google_place_id = ${row.google_place_id}
              and status in ('pending', 'rejected')`);
        }
      }
    }
    const item = this.projectRow(row, live);
    const enrichment = submissionEnrichmentViewSchema.safeParse(row.own_enrichment);
    const input = row.own_input;
    return {
      ...item,
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
      items: page.map((row) => this.projectRow(row, this.storedDisplay(row))),
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
      select s.id, s.status, s.result_place_id, s.rejection_reason, s.google_place_id, s.display_snapshot, s.provider_photo, to_jsonb(cover) as cover,
             case when p.id is not null then ct.key else st.key end as category_key,
             p.address_text as address_short,
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
        select t.key from place_taxonomies pt join taxonomies t on t.id = pt.taxonomy_id
        where pt.place_id = p.id and t.kind = 'category' and t.is_active = true
        order by t.key limit 1
      ) ct on true
      left join lateral (
        select storage_key from place_media
        where place_id = p.id and moderation = 'approved'
          and source_type in ('editorial', 'community')
          and storage_key like 'places/%'
        order by is_cover desc, sort_order, created_at, id
        limit 1
      ) m on true
      left join lateral (
        select id, storage_key, source_type, attribution, width, height, provider_photo
        from place_media where place_id = p.id and moderation = 'approved'
        order by is_cover desc, sort_order, created_at, id limit 1
      ) cover on true
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

  private storedDisplay(row: SubmissionRow): DisplayAnswer {
    // A decided catalogue place uses canonical GoGo facts, never another fetch.
    if (row.status === 'approved' || row.status === 'merged')
      return { providerStatus: 'deferred', providerDisplay: undefined };
    const snapshot = freshSnapshot(row.display_snapshot);
    return snapshot
      ? {
          providerStatus: 'ok',
          providerDisplay: snapshot,
        }
      : { providerStatus: 'deferred', providerDisplay: undefined };
  }

  private projectRow(row: SubmissionRow, live: DisplayAnswer) {
    const c = row.cover;
    const url = c
      ? isSubmissionPhotoKey(c.storage_key)
        ? communityPhotoUrl(row.result_place_id!, c.id)
        : publicCatalogueUrl(this.config.MEDIA_PUBLIC_BASE_URL, c.storage_key)
      : null;
    const photo =
      row.status === 'approved' || row.status === 'merged'
        ? c && url
          ? {
              id: c.id,
              url,
              source:
                c.source_type === 'google_derived'
                  ? ('google' as const)
                  : c.source_type === 'community'
                    ? ('community' as const)
                    : ('manual' as const),
              ...(c.width ? { width: c.width } : {}),
              ...(c.height ? { height: c.height } : {}),
              ...(c.attribution ? { attribution: c.attribution } : {}),
              ...(c.provider_photo ?? {}),
            }
          : undefined
        : submissionPhotoView(
            row.provider_photo,
            this.config.MEDIA_PUBLIC_BASE_URL,
            row.status,
            row.decided_at,
          );
    const deadline = updateDeadline(row.status, row.decided_at);
    return {
      ...(photo ? { photo } : {}),
      ...(deadline ? { updateDeadline: deadline } : {}),
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
      ...(publicCatalogueUrl(this.config.MEDIA_PUBLIC_BASE_URL, row.photo_key)
        ? { photoUrl: publicCatalogueUrl(this.config.MEDIA_PUBLIC_BASE_URL, row.photo_key)! }
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
}

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
  status: 'pending' | 'approved' | 'rejected' | 'merged';
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
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  async list(actor: Actor, options: { limit: number; cursor?: string | undefined }) {
    if (actor.type !== 'user') throw AppError.forbidden();
    const where = [
      sql`(s.submitted_by_user_id = ${actor.id}::uuid or exists (
      select 1 from place_submission_contributors c
      where c.submission_id = s.id and c.user_id = ${actor.id}::uuid
    ))`,
    ];
    if (options.cursor !== undefined) {
      const { at, id } = decodeCursor(options.cursor);
      where.push(sql`(s.created_at, s.id) < (${at}::timestamptz, ${id}::uuid)`);
    }
    const started = performance.now();
    const result = await this.db
      .execute(
        sql`
      select s.id, s.status, s.result_place_id,
             coalesce(p.name, nullif(s.review_draft->>'name', '')) as name,
             m.storage_key as photo_key,
             to_char(s.created_at at time zone 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
             s.updated_at, s.decided_at
      from place_submissions s
      left join places p on p.id = s.result_place_id
      left join lateral (
        select storage_key from place_media
        where place_id = p.id and moderation = 'approved'
          and source_type in ('editorial', 'community')
          and storage_key like 'places/%'
        order by is_cover desc, sort_order, created_at, id
        limit 1
      ) m on true
      where ${sql.join(where, sql` and `)}
      order by s.created_at desc, s.id desc
      limit ${options.limit + 1}
    `,
      )
      .finally(() => {
        this.metrics.observe('my_place_submissions_query_duration_ms', performance.now() - started);
      });
    const rows = result.rows as SubmissionRow[];
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        status: row.status,
        ...(row.name ? { name: row.name } : {}),
        ...(publicCatalogueUrl(this.config.MEDIA_PUBLIC_BASE_URL, row.photo_key)
          ? { photoUrl: publicCatalogueUrl(this.config.MEDIA_PUBLIC_BASE_URL, row.photo_key)! }
          : {}),
        // CMS reasons are free text and may contain PII. Clients translate this key.
        ...(row.status === 'rejected' ? { rejectionReason: 'MODERATION_REJECTED' as const } : {}),
        ...((row.status === 'approved' || row.status === 'merged') && row.result_place_id
          ? { placeId: row.result_place_id }
          : {}),
        createdAt: row.created_at,
        updatedAt: toIso(row.updated_at),
        ...(row.decided_at ? { decidedAt: toIso(row.decided_at) } : {}),
      })),
      // Keep Postgres microseconds; JS Date would skip rows within a millisecond.
      nextCursor:
        rows.length > options.limit && last ? encodeKeysetCursor(last.created_at, last.id) : null,
    };
  }
}

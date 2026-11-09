import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import type { CachePurgePort, StoragePort } from '@gogo/providers';
import { NoopMetrics, type MetricsPort } from '@gogo/observability';
import { RETRY_BACKOFF_SECONDS } from '../../notifications/application/outbox-dispatcher';
import { publicMediaUrl } from '../../shared/media-url';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type QueueWriter = Pick<Db | Tx, 'insert'>;

/** Logical, not the bucket's name: config may rename a bucket, a queue row may not. */
export type CleanupBucket = 'private' | 'public';

export type CleanupEntry = { bucket: CleanupBucket; objectKey: string; reason: string };

/** A retirement replaces any maintenance intent under the same open-object identity. */
export async function scheduleRetirement(
  writer: QueueWriter,
  entry: CleanupEntry,
  at: Date,
): Promise<string[]> {
  const rows = await writer
    .insert(schema.mediaCleanupQueue)
    .values({ ...entry, nextAttemptAt: at })
    .onConflictDoUpdate({
      target: [schema.mediaCleanupQueue.bucket, schema.mediaCleanupQueue.objectKey],
      targetWhere: sql`failed_at is null`,
      set: { reason: entry.reason, nextAttemptAt: at, attempts: 0 },
    })
    .returning({ id: schema.mediaCleanupQueue.id });
  return rows.map((r) => r.id);
}

/** After this many failures a row is dead-lettered and needs a person. */
export const MEDIA_CLEANUP_MAX_ATTEMPTS = 6;

export type CleanupRunReport = {
  attempted: number;
  done: number;
  retried: number;
  deadLettered: number;
  /** Rows that named an object a profile still points at: dropped, never deleted. */
  skipped: number;
};

/**
 * ADR-0022 — every object that must disappear goes through here.
 *
 * `enqueue` runs inside the transaction that unreferences the object, so a
 * committed avatar change and its cleanup row are one fact. `attemptNow` is
 * what the API calls right after that commit: most rows are gone before the
 * response returns. `runDue` is the worker's retry, with the outbox backoff,
 * for whatever storage or the edge refused the first time.
 *
 * Plain class, no Nest decorators: the worker constructs it by hand exactly
 * as it does the outbox dispatcher.
 */
export class MediaCleanupService {
  constructor(
    private readonly db: Db,
    private readonly storage: { private: StoragePort; public: StoragePort },
    private readonly purge: CachePurgePort,
    private readonly mediaBaseUrl: string,
    private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  /**
   * One row per object. The same object enqueued twice — a replace racing a
   * remove — is one job, because of the partial unique index; the second
   * insert returns nothing and nothing is lost.
   */
  scheduleRetirement(writer: QueueWriter, entry: CleanupEntry, at: Date): Promise<string[]> {
    return scheduleRetirement(writer, entry, at);
  }

  /** Re-derive lost schedules; dead-lettered jobs still require operator retry. */
  async reconcileRetirements(limit = 100): Promise<number> {
    return this.db.transaction(async (tx) => {
      const due = await tx.execute(sql`select s.id, s.provider_photo->>'storageKey' as key
        from place_submissions s
        where (s.provider_photo->>'deleteAfter')::timestamptz <= now()
          and not exists (select 1 from media_cleanup_queue q where q.bucket = 'public' and q.object_key = s.provider_photo->>'storageKey')
          and not exists (select 1 from place_media m where m.storage_key = s.provider_photo->>'storageKey')
          and not exists (select 1 from users u where u.avatar_key = s.provider_photo->>'storageKey')
          and not exists (select 1 from place_submissions n where n.provider_photo->>'storageKey' = s.provider_photo->>'storageKey'
            and (n.provider_photo->>'deleteAfter' is null or (n.provider_photo->>'deleteAfter')::timestamptz > now()))
        order by s.id limit ${limit} for update of s skip locked`);
      for (const row of due.rows as { id: string; key: string }[]) {
        await this.scheduleRetirement(
          tx,
          {
            bucket: 'public',
            objectKey: row.key,
            reason: 'submission_provider_photo_retirement_reconciled',
          },
          new Date(),
        );
      }
      this.metrics.increment('provider_photo_reconciled_total', undefined, due.rows.length);
      return due.rows.length;
    });
  }

  async enqueue(
    writer: QueueWriter,
    entries: CleanupEntry[],
    options: { delaySeconds?: number } = {},
  ): Promise<string[]> {
    if (entries.length === 0) return [];
    const delay = Math.max(0, Math.trunc(options.delaySeconds ?? 0));
    const rows = await writer
      .insert(schema.mediaCleanupQueue)
      .values(
        entries.map((e) => ({
          bucket: e.bucket,
          objectKey: e.objectKey,
          reason: e.reason,
          nextAttemptAt: sql`now() + make_interval(secs => ${delay})`,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: schema.mediaCleanupQueue.id });
    this.metrics.increment('media_cleanup_enqueued_total', undefined, rows.length);
    return rows.map((r) => r.id);
  }

  /** Same, in its own transaction — for a request that failed before it had one. */
  enqueueNow(entries: CleanupEntry[], options: { delaySeconds?: number } = {}): Promise<string[]> {
    return this.enqueue(this.db, entries, options);
  }

  /** Try the rows just enqueued, right now. Failure is not an error: the worker retries. */
  async attemptNow(ids: string[]): Promise<void> {
    for (const id of ids) {
      const [row] = await this.db
        .select()
        .from(schema.mediaCleanupQueue)
        .where(and(eq(schema.mediaCleanupQueue.id, id), isNull(schema.mediaCleanupQueue.failedAt)))
        .limit(1);
      if (row) await this.attempt(row);
    }
  }

  /** The worker's tick: due rows, oldest first. */
  async runDue(limit = 50): Promise<CleanupRunReport> {
    const rows = await this.db
      .select()
      .from(schema.mediaCleanupQueue)
      .where(
        and(
          isNull(schema.mediaCleanupQueue.failedAt),
          sql`${schema.mediaCleanupQueue.nextAttemptAt} <= now()`,
        ),
      )
      .orderBy(asc(schema.mediaCleanupQueue.nextAttemptAt))
      .limit(limit);
    const report: CleanupRunReport = {
      attempted: 0,
      done: 0,
      retried: 0,
      deadLettered: 0,
      skipped: 0,
    };
    for (const row of rows) {
      report.attempted += 1;
      const outcome = await this.attempt(row);
      report[outcome] += 1;
    }
    return report;
  }

  /** How many rows are waiting, for the gauge the worker exposes. */
  async pendingCount(): Promise<{ pending: number; deadLettered: number }> {
    const [row] = (
      await this.db.execute(sql`
        select
          count(*) filter (where failed_at is null)::int as pending,
          count(*) filter (where failed_at is not null)::int as dead_lettered
        from media_cleanup_queue
      `)
    ).rows as { pending: number; dead_lettered: number }[];
    return { pending: row?.pending ?? 0, deadLettered: row?.dead_lettered ?? 0 };
  }

  /** The public URL an object was served from — what the edge is asked to forget. */
  publicUrl(key: string): string | null {
    return publicMediaUrl(this.mediaBaseUrl, key);
  }

  /**
   * Whether a public object is the avatar some account points at right now.
   * Keys are random per attempt, so a queue row can only name a live avatar
   * through a bug upstream — and the answer to a bug upstream is to refuse the
   * delete here, not to trust that the bug never happens. Read at attempt time,
   * never at enqueue time: a retry that succeeded after the row was written is
   * exactly the case this exists for.
   */
  private async isLiveObject(objectKey: string): Promise<false | true | Date> {
    const [referenced] = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.avatarKey, objectKey))
      .limit(1);
    if (referenced !== undefined) return true;
    const [media] = await this.db
      .select({ id: schema.placeMedia.id })
      .from(schema.placeMedia)
      .where(eq(schema.placeMedia.storageKey, objectKey))
      .limit(1);
    if (media !== undefined) return true;
    const refs = await this.db.execute(sql`select provider_photo->>'deleteAfter' as until
      from place_submissions where provider_photo->>'storageKey' = ${objectKey}
        and (provider_photo->>'deleteAfter' is null or (provider_photo->>'deleteAfter')::timestamptz > now())`);
    const rows = refs.rows as { until: string | null }[];
    if (rows.some((r) => r.until === null)) return true;
    return rows.length ? new Date(Math.max(...rows.map((r) => Date.parse(r.until!)))) : false;
  }

  private async attempt(
    row: typeof schema.mediaCleanupQueue.$inferSelect,
  ): Promise<'done' | 'retried' | 'deadLettered' | 'skipped'> {
    const bucket = row.bucket as CleanupBucket;
    const live = bucket === 'public' ? await this.isLiveObject(row.objectKey) : false;
    if (live instanceof Date) {
      await this.db
        .update(schema.mediaCleanupQueue)
        .set({ nextAttemptAt: live })
        .where(eq(schema.mediaCleanupQueue.id, row.id));
      this.metrics.increment('media_cleanup_attempt_total', { bucket, outcome: 'deferred' });
      return 'skipped';
    }
    if (live) {
      await this.db.delete(schema.mediaCleanupQueue).where(eq(schema.mediaCleanupQueue.id, row.id));
      this.metrics.increment('media_cleanup_attempt_total', { bucket, outcome: 'referenced' });
      return 'skipped';
    }
    try {
      await this.storage[bucket].deleteObject(row.objectKey);
      // The edge is asked after the origin is gone, so a purge that lands
      // before a delete cannot re-fill the cache from the object.
      if (bucket === 'public') {
        const url = this.publicUrl(row.objectKey);
        if (url) await this.purge.purgeUrls([url]);
      }
      if (bucket === 'public')
        await this.db.execute(sql`update place_submissions set provider_photo = null
        where provider_photo->>'storageKey' = ${row.objectKey} and (provider_photo->>'deleteAfter')::timestamptz <= now()`);
      await this.db.delete(schema.mediaCleanupQueue).where(eq(schema.mediaCleanupQueue.id, row.id));
      this.metrics.increment('media_cleanup_attempt_total', { bucket, outcome: 'done' });
      return 'done';
    } catch (err) {
      const attempts = row.attempts + 1;
      const exhausted = attempts >= MEDIA_CLEANUP_MAX_ATTEMPTS;
      await this.db
        .update(schema.mediaCleanupQueue)
        .set({
          attempts,
          // An object key is not a person; a provider message might echo the
          // request, which here carries nothing but the key either.
          lastError: String(err).slice(0, 500),
          nextAttemptAt: sql`now() + make_interval(secs => ${RETRY_BACKOFF_SECONDS(attempts)})`,
          ...(exhausted ? { failedAt: sql`now()` } : {}),
        })
        .where(eq(schema.mediaCleanupQueue.id, row.id));
      const outcome = exhausted ? 'deadLettered' : 'retried';
      this.metrics.increment('media_cleanup_attempt_total', {
        bucket,
        outcome: exhausted ? 'dead_lettered' : 'retried',
      });
      return outcome;
    }
  }
}

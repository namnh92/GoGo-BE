import {
  PROVIDER_PHOTO_RESERVATION_ACTION,
  providerPhotoUnattempted,
  providerPhotoEligible,
} from './provider-photo-reservation';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { listCostMicros } from '@gogo/cost-observability';
import type { SubmissionPhotoService } from '../../ingestion/application/submission-photo.service';
import type { ProviderPhotosService } from '../../search/application/provider-photos.service';
import { googleProvenanceRows } from '../../shared/google-provenance';
import { writeAudit } from '../../shared/audit';

type Candidate = { id: string; externalId: string };
type Prepared = NonNullable<Awaited<ReturnType<SubmissionPhotoService['prepare']>>>;
export interface PhotoBackfillStore {
  scan(after: string | null, limit: number): Promise<Candidate[]>;
  /** Durable at-most-once reservation, committed before any provider/storage I/O. */
  claimIfEligible(place: Candidate): Promise<boolean>;
  attachIfEligible(place: Candidate, photo: Prepared): Promise<boolean>;
}
export type PhotoBackfillOptions = {
  dryRun: boolean;
  probe: boolean;
  limit: number;
  signal?: AbortSignal;
  /** Internal IDs only; never provider IDs, names, addresses or credits. */
  reportCandidate?: ((id: string) => void) | undefined;
};

export async function backfillProviderPhotos(
  store: PhotoBackfillStore,
  photos: Pick<ProviderPhotosService, 'enabled' | 'probeForProvider'>,
  persistence: Pick<SubmissionPhotoService, 'prepare' | 'discard'>,
  options: PhotoBackfillOptions,
) {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit <= 0 ||
    (!options.dryRun && options.probe)
  )
    throw new Error('Invalid backfill options');
  const counts = {
    total: 0,
    withPhoto: 0,
    withoutPhoto: 0,
    errors: 0,
    written: 0,
    skipped: 0,
    stopped: 'complete' as 'complete' | 'disabled' | 'signal' | 'error',
  };
  let after: string | null = null;
  try {
    while (!options.signal?.aborted && counts.total < options.limit) {
      if (!(await photos.enabled())) {
        counts.stopped = 'disabled';
        break;
      }
      const batch = await store.scan(after, Math.min(100, options.limit - counts.total));
      if (!batch.length) break;
      for (const place of batch) {
        if (options.signal?.aborted) break;
        if (!(await photos.enabled())) {
          counts.stopped = 'disabled';
          break;
        }
        after = place.id;
        counts.total++;
        options.reportCandidate?.(place.id);
        if (options.dryRun && !options.probe) continue;
        try {
          if (options.probe) {
            const result = await photos.probeForProvider(place.externalId);
            if (result.status === 'disabled') {
              counts.stopped = 'disabled';
              break;
            }
            if (result.status !== 'ok') counts.errors++;
            else if (result.hasPhoto) counts.withPhoto++;
            else counts.withoutPhoto++;
          } else {
            if (!(await store.claimIfEligible(place))) {
              counts.skipped++;
              continue;
            }
            if (options.signal?.aborted || !(await photos.enabled())) {
              counts.stopped = options.signal?.aborted ? 'signal' : 'disabled';
              break;
            }
            const prepared = await persistence.prepare(place.externalId, 'backfill');
            if (!prepared) {
              if (!(await photos.enabled())) {
                counts.stopped = 'disabled';
                break;
              }
              counts.withoutPhoto++;
              continue;
            }
            counts.withPhoto++;
            let attached = false;
            try {
              // A kill switch during provider/storage work must also prevent attachment.
              if (options.signal?.aborted || !(await photos.enabled())) {
                counts.stopped = options.signal?.aborted ? 'signal' : 'disabled';
                break;
              }
              attached = await store.attachIfEligible(place, prepared);
              if (attached) counts.written++;
              else counts.skipped++;
            } finally {
              if (!attached) await persistence.discard(prepared);
            }
          }
        } catch {
          // Never log arbitrary provider/DB errors, which may carry keys or PII.
          counts.errors++;
        }
      }
      if (counts.stopped !== 'complete') break;
    }
  } catch {
    counts.errors++;
    counts.stopped = 'error';
  }
  if (options.signal?.aborted) counts.stopped = 'signal';
  const candidates = options.probe ? counts.withPhoto : counts.total;
  const day = new Date().toISOString().slice(0, 10);
  return {
    ...counts,
    estimate: {
      // Baseline: one Details and one media call per candidate. Expired refs
      // can require one additional Details + media call in the existing pipeline.
      detailsCalls: counts.total,
      mediaCalls: candidates,
      maxDetailsCallsWithRetry: counts.total * 2,
      maxMediaCallsWithRetry: counts.total * 2,
      listCostUsdMicros: listCostMicros('google.photoMedia', day, candidates),
      maxListCostUsdMicrosWithRetry: listCostMicros('google.photoMedia', day, counts.total * 2),
    },
  };
}

/** Same identity priority/rollback switch as ProviderPhotosService. */
function identity(unified: boolean) {
  return sql`select src.external_id from (${googleProvenanceRows(sql`p.id`, unified)}) src
    left join place_provider_sources canon on canon.id = src.id
    where src.provider = 'google' and coalesce(canon.source_status <> 'moved', true)
      and nullif(btrim(src.external_id), '') is not null
    order by (canon.id is not null) desc, src.fetched_at desc nulls last, src.external_id
    limit 1`;
}
const eligible = () => providerPhotoEligible(true);
const unattempted = providerPhotoUnattempted;

export class DbPhotoBackfillStore implements PhotoBackfillStore {
  constructor(
    private readonly db: Db,
    private readonly persistence: Pick<SubmissionPhotoService, 'attach'>,
    private readonly unified = true,
  ) {}

  async scan(after: string | null, limit: number): Promise<Candidate[]> {
    const result = await this.db.execute(sql`
      select p.id, src.external_id as "externalId" from places p
      join lateral (${identity(this.unified)}) src on true
      where ${eligible()} and ${unattempted()}
        ${after === null ? sql`` : sql`and p.id > ${after}::uuid`}
      order by p.id limit ${limit}`);
    return result.rows as Candidate[];
  }

  async claimIfEligible(place: Candidate): Promise<boolean> {
    // Append-only audit is also the durable purchase reservation. Keep it on
    // every outcome (including no-photo and crashes): prepare can fail after a
    // paid call, so automatic retries cannot safely infer that no purchase ran.
    return this.db.transaction(
      async (tx) => {
        await tx.execute(sql`select id from places where id = ${place.id}::uuid for update`);
        const current = await tx.execute(sql`
          select p.id from places p join lateral (${identity(this.unified)}) src on true
          where p.id = ${place.id}::uuid and ${eligible()} and ${unattempted()}
            and src.external_id = ${place.externalId}`);
        if (!current.rows.length) return false;
        await writeAudit(tx, {
          actorType: 'system',
          action: PROVIDER_PHOTO_RESERVATION_ACTION,
          resourceType: 'place',
          resourceId: place.id,
          diff: { source: 'backfill_797', sourceType: 'google_derived' },
        });
        return true;
      },
      { isolationLevel: 'read committed' },
    );
  }

  async attachIfEligible(place: Candidate, photo: Prepared): Promise<boolean> {
    // Lock and re-read in separate READ COMMITTED statements, so two concurrent
    // runs cannot both see an empty gallery. No Google/storage I/O in the tx.
    return this.db.transaction(
      async (tx) => {
        await tx.execute(sql`select id from places where id = ${place.id}::uuid for update`);
        const current = await tx.execute(sql`
        select p.id from places p join lateral (${identity(this.unified)}) src on true
        where p.id = ${place.id}::uuid and ${eligible()} and src.external_id = ${place.externalId}`);
        if (!current.rows.length) return false;
        await this.persistence.attach(tx, place.id, null, photo, 'Provider photo backfill #797');
        await writeAudit(tx, {
          actorType: 'system',
          action: 'place.provider_photo_backfill',
          resourceType: 'place',
          resourceId: place.id,
          diff: { fields: ['media'], sourceType: 'google_derived' },
        });
        return true;
      },
      { isolationLevel: 'read committed' },
    );
  }
}

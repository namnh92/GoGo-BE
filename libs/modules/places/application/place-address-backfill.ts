import { sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { GOOGLE_PROVIDER } from '../../shared/google-provenance';
import { writeAudit } from '../../shared/audit';

export type AddressCandidate = { id: string; externalId: string };
export interface AddressBackfillStore {
  scan(after: string | null, limit: number): Promise<AddressCandidate[]>;
  writeIfEmpty(place: AddressCandidate, address: string): Promise<boolean>;
}
export type AddressBackfillOptions = {
  dryRun: boolean;
  maxGoogleCalls: number;
  /** Stop between candidates; a started provider/write operation finishes normally. */
  signal?: AbortSignal;
};
export type AddressBackfillCounts = {
  scanned: number;
  written: number;
  skipped: number;
  errors: number;
  /** Reserved attempts; circuit-open failures may use a slot without HTTP. */
  callSlots: number;
};

export async function backfillPlaceAddresses(
  store: AddressBackfillStore,
  provider: { address(externalId: string): Promise<string | null> },
  options: AddressBackfillOptions,
): Promise<AddressBackfillCounts> {
  if (!Number.isSafeInteger(options.maxGoogleCalls) || options.maxGoogleCalls <= 0) {
    throw new Error('maxGoogleCalls must be a positive safe integer');
  }
  const counts: AddressBackfillCounts = {
    scanned: 0,
    written: 0,
    skipped: 0,
    errors: 0,
    callSlots: 0,
  };
  let after: string | null = null;
  // Dry-run previews the same bounded number of eligible rows, with no calls/writes.
  while (!options.signal?.aborted && counts.scanned < options.maxGoogleCalls) {
    let batch: AddressCandidate[];
    try {
      batch = await store.scan(after, Math.min(100, options.maxGoogleCalls - counts.scanned));
    } catch {
      counts.errors++;
      break;
    }
    if (batch.length === 0) break;
    for (const place of batch) {
      if (options.signal?.aborted || counts.scanned >= options.maxGoogleCalls) break;
      after = place.id;
      counts.scanned++;
      if (options.dryRun) {
        counts.skipped++;
        continue;
      }
      counts.callSlots++;
      try {
        const address = await provider.address(place.externalId);
        if (!address?.trim()) {
          counts.skipped++;
        } else if (await store.writeIfEmpty(place, address)) {
          counts.written++;
        } else {
          counts.skipped++;
        }
      } catch {
        // Provider/DB messages can contain addresses, URLs or credentials.
        counts.errors++;
      }
    }
  }
  return counts;
}

/** Canonical Google identity plus the legacy CMS add-by-link identity. */
function identities() {
  return sql`
    select place_id, external_id, 0 as priority from place_provider_sources
      where provider = ${GOOGLE_PROVIDER} and nullif(btrim(external_id), '') is not null
    union all
    select place_id, external_id, 1 as priority from place_sources
      where provider = 'google' and nullif(btrim(external_id), '') is not null`;
}

export class DbAddressBackfillStore implements AddressBackfillStore {
  constructor(private readonly db: Db) {}

  async scan(after: string | null, limit: number): Promise<AddressCandidate[]> {
    const result = await this.db.execute(sql`
      select p.id, src.external_id as "externalId"
      from places p
      join lateral (
        select external_id from (${identities()}) sources
        where sources.place_id = p.id order by priority, external_id limit 1
      ) src on true
      where (p.address_text is null or btrim(p.address_text) = '')
        ${after === null ? sql`` : sql`and p.id > ${after}::uuid`}
      order by p.id limit ${limit}`);
    return result.rows as AddressCandidate[];
  }

  async writeIfEmpty(place: AddressCandidate, address: string): Promise<boolean> {
    if (!address.trim()) return false;
    // No transaction is held during Google I/O. The UPDATE locks the place;
    // a concurrent editor wins if they filled it before we obtained that lock.
    return this.db.transaction(async (tx) => {
      const changed = await tx.execute(sql`
        update places p set address_text = ${address}, updated_at = now()
        where p.id = ${place.id}::uuid
          and (p.address_text is null or btrim(p.address_text) = '')
          and exists (select 1 from (${identities()}) sources
            where sources.place_id = p.id and sources.external_id = ${place.externalId})
        returning p.id`);
      if (changed.rows.length === 0) return false;
      await tx
        .insert(schema.placeFieldProvenance)
        .values({
          placeId: place.id,
          field: 'address_text',
          sourceType: 'google_derived',
          sourceReference: place.externalId,
          actorId: null,
          collectedAt: null,
        })
        .onConflictDoUpdate({
          target: [schema.placeFieldProvenance.placeId, schema.placeFieldProvenance.field],
          set: {
            sourceType: 'google_derived',
            sourceReference: place.externalId,
            actorId: null,
            collectedAt: null,
            verifiedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
      await writeAudit(tx, {
        actorType: 'system',
        action: 'place.address_backfill',
        resourceType: 'place',
        resourceId: place.id,
        diff: { fields: ['address_text'], sourceType: 'google_derived' },
      });
      return true;
    });
  }
}

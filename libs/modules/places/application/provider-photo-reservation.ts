import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { writeAudit } from '../../shared/audit';
import type { SubmissionPhotoService } from '../../ingestion/application/submission-photo.service';

export const PROVIDER_PHOTO_RESERVATION_ACTION = 'place.provider_photo_reservation';
export const LEGACY_PROVIDER_PHOTO_RESERVATION_ACTION = 'place.provider_photo_backfill_attempt';
export function providerPhotoUnattempted() {
  return sql`not exists (select 1 from audit_logs a where a.resource_type = 'place' and a.resource_id = p.id::text
    and a.action in (${PROVIDER_PHOTO_RESERVATION_ACTION}, ${LEGACY_PROVIDER_PHOTO_RESERVATION_ACTION}))`;
}
/** #797 keeps published-only eligibility. CMS create deliberately accepts its new draft. */
export function providerPhotoEligible(published: boolean) {
  return sql`${published ? sql`p.status = 'published' and` : sql``} not exists
    (select 1 from place_media m where m.place_id = p.id and (m.moderation in ('pending', 'approved') or m.is_cover))`;
}

export async function acquireCmsProviderPhoto(
  db: Db,
  photos: SubmissionPhotoService,
  placeId: string,
  googlePlaceId: string,
  adminId: string,
) {
  let prepared: Awaited<ReturnType<SubmissionPhotoService['prepare']>>;
  let attached = false;
  try {
    if (!(await photos.acquisitionEnabled())) return;
    const eligible = () => sql`select p.id from places p where p.id = ${placeId}::uuid
      and ${providerPhotoEligible(false)} and exists (select 1 from place_sources s where s.place_id = p.id
        and s.provider = 'google' and s.external_id = ${googlePlaceId})`;
    const claimed = await db.transaction(async (tx) => {
      await tx.execute(sql`select id from places where id = ${placeId}::uuid for update`);
      const row = await tx.execute(sql`${eligible()} and ${providerPhotoUnattempted()}`);
      if (!row.rows.length) return false;
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: adminId,
        action: PROVIDER_PHOTO_RESERVATION_ACTION,
        resourceType: 'place',
        resourceId: placeId,
        diff: { source: 'cms_create', sourceType: 'google_derived' },
      });
      return true;
    });
    if (!claimed) {
      photos.count('cms_create', 'skipped');
      return;
    }
    prepared = await photos.prepare(googlePlaceId, 'cms_create');
    if (!prepared) {
      photos.count('cms_create', 'empty');
      return;
    }
    attached = await db.transaction(async (tx) => {
      await tx.execute(sql`select id from places where id = ${placeId}::uuid for update`);
      if (!(await tx.execute(eligible())).rows.length) return false;
      await photos.attach(tx, placeId, adminId, prepared!);
      return true;
    });
    photos.count('cms_create', attached ? 'stored' : 'skipped');
  } catch {
    photos.count('cms_create', 'error');
  } finally {
    if (prepared && !attached) await photos.discard(prepared);
  }
}

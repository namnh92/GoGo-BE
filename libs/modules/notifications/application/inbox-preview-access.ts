import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { EventNotificationFacts } from '../../shared/notification-event-facts';

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

/** Historical facts are not an authorization or media-availability grant. */
export async function inboxPreviewPayload(
  db: Db,
  userId: string,
  payload: unknown,
): Promise<unknown> {
  if (!payload || typeof payload !== 'object') return payload;
  const facts = payload as Record<string, unknown> & EventNotificationFacts;
  if (
    !facts.planPreview &&
    !facts.reminder &&
    !facts.inviterAvatar &&
    !facts.inviterName &&
    !facts._inviterMemberId
  )
    return payload;
  const roomId = uuidOrNull(facts.roomId);
  const inviterId = uuidOrNull(facts._inviterMemberId);
  const { rows } = await db.execute<{
    allowed: boolean;
    inviter_allowed: boolean;
    plan_available: boolean;
    places: string[];
    media: string[];
    avatars: string[];
  }>(sql`
    select exists(select 1 from room_members m join rooms r on r.id = m.room_id
      join users u on u.id = m.user_id and u.status <> 'deleted'
      where m.room_id = ${roomId}::uuid and m.user_id = ${userId}::uuid
        and m.removed_at is null) as allowed,
      exists(select 1 from room_members m left join users u on u.id = m.user_id
        where m.id = ${inviterId}::uuid and m.room_id = ${roomId}::uuid
          and m.removed_at is null and (m.user_id is null or u.status <> 'deleted')) as inviter_allowed,
      exists(select 1 from plans where id = ${uuidOrNull(facts.planPreview?.planId)}::uuid
        and room_id = ${roomId}::uuid) as plan_available,
      array(select id::text from places where status = 'published'
        and id in (select (s->>'placeId')::uuid from jsonb_array_elements(
          ${JSON.stringify(facts.planPreview?.stops ?? [])}::jsonb) s)) as places,
      array(select m.id::text from place_media m join places p on p.id = m.place_id
        where m.id in (select (s->>'mediaId')::uuid from jsonb_array_elements(
          ${JSON.stringify(facts.planPreview?.stops ?? [])}::jsonb) s)
          and p.status = 'published' and m.moderation = 'approved'
          and m.source_type in ('editorial','community') and m.provider_photo is null
          and exists(select 1 from media_uploads mu where mu.id = m.media_upload_id
            and mu.storage_key = m.storage_key and mu.status = 'attached')
          and exists(select 1 from jsonb_array_elements(${JSON.stringify(facts.planPreview?.stops ?? [])}::jsonb) s
            where (s->>'mediaId')::uuid = m.id and (s->>'placeId')::uuid = m.place_id)) as media,
      array(select u.avatar_key from users u join room_members m on m.user_id = u.id
        where m.room_id = ${roomId}::uuid and m.id = ${inviterId}::uuid
          and m.removed_at is null
          and u.status <> 'deleted' and u.avatar_key = ${facts.inviterAvatar?.mediaKey ?? null}) as avatars
  `);
  const live = rows[0];
  const result = { ...facts };
  delete result._inviterMemberId;
  if (!live?.allowed) {
    for (const key of [
      'planPreview',
      'reminder',
      'inviterAvatar',
      'inviterName',
      'roomName',
      'preferenceProgress',
      'planChange',
      'stopCount',
    ])
      delete result[key];
    return result;
  }
  if (facts._inviterMemberId && !live.inviter_allowed) {
    delete result.inviterName;
    delete result.inviterAvatar;
  }
  if (result.inviterAvatar && !live.avatars.includes(result.inviterAvatar.mediaKey))
    delete result.inviterAvatar;
  if (result.planPreview) {
    // A removed plan is unavailable; never substitute today's plan facts.
    if (!live.plan_available) delete result.planPreview;
    else
      result.planPreview = {
        ...result.planPreview,
        stops: result.planPreview.stops.map((stop) => {
          const visible = { ...stop };
          if (!live.places.includes(stop.placeId)) {
            delete visible.name;
            delete visible.addressText;
          }
          if (visible.mediaId && !live.media.includes(visible.mediaId)) delete visible.mediaId;
          return visible;
        }),
      };
  }
  return result;
}

import { sql } from 'drizzle-orm';
import type { Tx } from './outbox';
import { contactOwnership, isGoogleReference, isTransportReference } from './place-contact';

type Instant = Date | string;
type Provenance = {
  source_type: string;
  source_reference: string | null;
  verified_at: Instant;
  collected_at: Instant | null;
};
export type SourcedText = {
  value: string;
  sourceType: 'gogo';
  originType: 'editorial' | 'community' | 'provider';
  verifiedAt: string;
  collectedAt?: string;
};
export type PreviewStop = {
  position: number;
  placeId: string;
  arriveAt?: string;
  name?: SourcedText;
  addressText?: SourcedText;
  mediaId?: string;
};
export type PlanPreview = {
  planId: string;
  planVersion: number;
  constraintVersion: number;
  capturedAt: string;
  startAt?: string;
  startAtSource?: 'room_constraints';
  stopCount: number;
  stops: PreviewStop[];
};
export type ReminderFacts = {
  trigger: 'room_started' | 'scheduled';
  triggeredAt: string;
  scheduledFor: string | null;
  startsAt: string | null;
  leadTimeSeconds?: number;
  scheduleRevision?: string;
};
export type EventNotificationFacts = {
  /** Internal access evidence; stripped by the inbox mapper. */
  _inviterMemberId?: string;
  planPreview?: PlanPreview;
  reminder?: ReminderFacts;
  inviterName?: string;
  inviterAvatar?: { sourceType: 'gogo'; mediaKey: string };
};

const utc = (value: Instant) => new Date(value).toISOString();

/** Private evidence stays here. A canonical value or provider label alone proves nothing. */
export function sourcedNotificationText(
  value: string | null,
  provenance: Provenance | null,
  field: 'name' | 'address_text',
): SourcedText | undefined {
  if (!value?.trim() || !provenance) return;
  const origin = provenance.source_type;
  if (!['editorial', 'community', 'provider'].includes(origin)) return;
  const reference = provenance.source_reference?.trim();
  if (!reference || isGoogleReference(reference) || isTransportReference(reference)) return;
  // ADR-0031 owns addresses. Provider text also needs independently collected evidence;
  // no inference from place_provider_sources, provider labels or canonical columns.
  if (
    (field === 'address_text' || origin === 'provider') &&
    contactOwnership(provenance) !== 'gogo'
  )
    return;
  if (!Number.isFinite(new Date(provenance.verified_at).getTime())) return;
  if (provenance.collected_at && !Number.isFinite(new Date(provenance.collected_at).getTime()))
    return;
  return {
    value,
    sourceType: 'gogo',
    originType: origin as SourcedText['originType'],
    verifiedAt: utc(provenance.verified_at),
    ...(provenance.collected_at ? { collectedAt: utc(provenance.collected_at) } : {}),
  };
}

export function roomStartedFacts(triggeredAt: Instant, startsAt: Instant | null): ReminderFacts {
  return {
    trigger: 'room_started',
    triggeredAt: utc(triggeredAt),
    scheduledFor: null,
    startsAt: startsAt ? utc(startsAt) : null,
  };
}

export function inviterDisplayFacts(
  displayName: string,
  avatarKey: string | null,
): EventNotificationFacts {
  return {
    inviterName: displayName,
    // Only the processed public object namespace written by AvatarService. Never a URL.
    ...(/^avatars\/[a-f0-9]{32}\.webp$/.test(avatarKey ?? '')
      ? { inviterAvatar: { sourceType: 'gogo' as const, mediaKey: avatarKey! } }
      : {}),
  };
}

type StopRow = {
  position: number;
  place_id: string;
  arrive_at: Instant | null;
  name: string | null;
  address_text: string | null;
  name_provenance: Provenance | null;
  address_provenance: Provenance | null;
  media_id: string | null;
};
export function buildPlanPreview(input: {
  plan_id: string;
  plan_version: number;
  constraint_version: number;
  captured_at: Instant;
  start_at: Instant | null;
  stop_count: number;
  stops: StopRow[];
}): PlanPreview {
  return {
    planId: input.plan_id,
    planVersion: input.plan_version,
    constraintVersion: input.constraint_version,
    capturedAt: utc(input.captured_at),
    ...(input.start_at
      ? { startAt: utc(input.start_at), startAtSource: 'room_constraints' as const }
      : {}),
    stopCount: input.stop_count,
    stops: [...input.stops]
      .sort((a, b) => a.position - b.position)
      .slice(0, 3)
      .map((s) => {
        const name = sourcedNotificationText(s.name, s.name_provenance, 'name');
        const addressText = sourcedNotificationText(
          s.address_text,
          s.address_provenance,
          'address_text',
        );
        return {
          position: s.position,
          placeId: s.place_id,
          ...(s.arrive_at ? { arriveAt: utc(s.arrive_at) } : {}),
          ...(name ? { name } : {}),
          ...(addressText ? { addressText } : {}),
          ...(s.media_id ? { mediaId: s.media_id } : {}),
        };
      }),
  };
}

/** Called by producers inside the originating transaction, after the plan/stops write. */
export async function capturePlanPreview(
  tx: Tx,
  roomId: string,
  planId?: string,
): Promise<PlanPreview | undefined> {
  const { rows } = await tx.execute<Parameters<typeof buildPlanPreview>[0]>(sql`
    select p.id as plan_id, p.version as plan_version, p.constraint_version,
      statement_timestamp() as captured_at,
      case when rc.version = p.constraint_version then rc.start_at end as start_at,
      (select count(*)::int from plan_stops where plan_id = p.id) as stop_count,
      coalesce((select jsonb_agg(s order by s.position) from (
        select ps.position, ps.place_id, ps.arrive_at,
          case when pl.status = 'published' then pl.name end as name,
          case when pl.status = 'published' then pl.address_text end as address_text,
          to_jsonb(np) as name_provenance, to_jsonb(ap) as address_provenance,
          (select m.id from place_media m where m.place_id = ps.place_id
            and pl.status = 'published' and m.moderation = 'approved'
            and m.source_type in ('editorial','community') and m.provider_photo is null
            and exists(select 1 from media_uploads mu where mu.id = m.media_upload_id
              and mu.storage_key = m.storage_key and mu.status = 'attached')
            order by m.is_cover desc, m.sort_order, m.id limit 1) as media_id
        from plan_stops ps join places pl on pl.id = ps.place_id
        left join place_field_provenance np on np.place_id = pl.id and np.field = 'name'
        left join place_field_provenance ap on ap.place_id = pl.id and ap.field = 'address_text'
        where ps.plan_id = p.id order by ps.position limit 3
      ) s), '[]'::jsonb) as stops
    from plans p join rooms r on r.id = p.room_id
    left join room_constraints rc on rc.room_id = r.id and rc.version = r.constraint_version
    where p.room_id = ${roomId}::uuid
      ${planId ? sql`and p.id = ${planId}::uuid` : sql`and p.status = 'current'`}
    limit 1
  `);
  return rows[0] ? buildPlanPreview(rows[0]) : undefined;
}

export async function captureRoomStartedFacts(
  tx: Tx,
  roomId: string,
): Promise<EventNotificationFacts> {
  const { rows } = await tx.execute<{ triggered_at: Instant; start_at: Instant | null }>(sql`
    select statement_timestamp() as triggered_at,
      (select rc.start_at from room_constraints rc join rooms r on r.id = rc.room_id
        and r.constraint_version = rc.version where r.id = ${roomId}::uuid) as start_at
  `);
  const planPreview = await capturePlanPreview(tx, roomId);
  return {
    reminder: roomStartedFacts(rows[0]!.triggered_at, rows[0]!.start_at),
    ...(planPreview ? { planPreview } : {}),
  };
}

export async function captureInviterFacts(
  tx: Tx,
  roomId: string,
  memberId: unknown,
): Promise<EventNotificationFacts> {
  if (typeof memberId !== 'string') return {};
  // User first, then a fresh membership/profile read. Erasure holds UPDATE on
  // this same account through membership pseudonymization and snapshot cleanup.
  // A join that wins commits its event before cleanup; a waiting join sees the
  // deleted status and captures no facts. Guests have no account to lock.
  await tx.execute(sql`
    select id from users where id = (
      select user_id from room_members
      where id = ${memberId}::uuid and room_id = ${roomId}::uuid
    ) for share
  `);
  const { rows } = await tx.execute<{ display_name: string; avatar_key: string | null }>(sql`
    select m.display_name, u.avatar_key from room_members m
    left join users u on u.id = m.user_id and u.status <> 'deleted'
    where m.id = ${memberId}::uuid and m.room_id = ${roomId}::uuid and m.removed_at is null
      and (m.user_id is null or u.id is not null)
  `);
  return rows[0]
    ? {
        ...inviterDisplayFacts(rows[0].display_name, rows[0].avatar_key),
        _inviterMemberId: memberId,
      }
    : {};
}

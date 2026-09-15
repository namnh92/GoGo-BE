import type { AdministrativeAreaInput } from '../../administrative/application/area-selection';
import { matchingReadiness } from '../domain/matching-readiness';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type MediaConfig } from '../../shared/config';
import { publicMediaUrl } from '../../shared/media-url';
import { ROOM_EVENT_BUS, type RoomEventBus } from '../../realtime/application/room-event-bus';
import type { Actor } from '../../identity/domain/actor';
import { TokenService } from '../../identity/application/token.service';
import { IdentityRepository } from '../../identity/infrastructure/identity.repository';
import { SessionRevocationService } from '../../identity/application/session-revocation.service';
import {
  assertBudgetMode,
  assertConstraintsEditable,
  assertDecisionMode,
  assertTransition,
  type DecisionMode,
  type RoomStatus,
  type RoomType,
  assertRoomDetailsEditable,
} from '../domain/room-state';
import {
  inviteJoinRefusal,
  JOINABLE_ROOM_STATUSES,
  type JoinRefusal,
  type JoinRules,
} from '../domain/invite-join';
import { RoomPolicy } from '../presentation/room-policy';
import {
  RoomsRepository,
  type NewConstraint,
  type RoomRow,
} from '../infrastructure/rooms.repository';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export type ConstraintInput = {
  administrativeArea?: AdministrativeAreaInput | null | undefined;
  originText?: string | undefined;
  originLat?: number | undefined;
  originLng?: number | undefined;
  areaKey?: string | undefined;
  radiusM?: number | undefined;
  startAt?: Date | undefined;
  endAt?: Date | undefined;
  budgetMode: 'total' | 'per_person';
  budgetAmount: number;
  currency?: string | undefined;
  dietaryKeys?: string[] | undefined;
  accessibilityKeys?: string[] | undefined;
};

function toNewConstraint(input: ConstraintInput): NewConstraint {
  return {
    ...(input.administrativeArea !== undefined
      ? { administrativeArea: input.administrativeArea }
      : {}),
    originText: input.originText ?? null,
    originLat: input.originLat ?? null,
    originLng: input.originLng ?? null,
    areaKey: input.areaKey ?? null,
    radiusM: input.radiusM ?? null,
    startAt: input.startAt ?? null,
    endAt: input.endAt ?? null,
    budgetMode: input.budgetMode,
    budgetAmount: input.budgetAmount,
    currency: input.currency ?? 'VND',
    dietaryKeys: input.dietaryKeys ?? [],
    accessibilityKeys: input.accessibilityKeys ?? [],
  };
}

/** BE-BFF-003/004 + BE-BFF-015 — room lifecycle, invites, members, seeds. */
@Injectable()
export class RoomsService {
  constructor(
    private readonly repo: RoomsRepository,
    private readonly policy: RoomPolicy,
    private readonly tokens: TokenService,
    private readonly identity: IdentityRepository,
    private readonly revocations: SessionRevocationService,
    @Inject(ROOM_EVENT_BUS) private readonly events: RoomEventBus,
    // Optional so the unit tests that build this service by hand keep working;
    // without it every member's avatarUrl is null, which is also honest.
    @Optional() @Inject(APP_CONFIG) private readonly config?: MediaConfig,
  ) {}

  async createRoom(
    actor: Actor,
    input: {
      type: RoomType;
      decisionMode: DecisionMode;
      participantCount: number;
      title?: string;
      scheduledDate?: Date;
      constraint: ConstraintInput;
      seedPlaceIds?: string[];
    },
  ) {
    if (actor.type !== 'user') {
      throw AppError.forbidden('USER_ONLY', 'Guests cannot create rooms');
    }
    assertDecisionMode(input.type, input.decisionMode);
    assertBudgetMode(input.type, input.constraint.budgetMode);
    if (input.type === 'couple' && input.participantCount !== 2) {
      throw AppError.badRequest('INVALID_PARTICIPANT_COUNT', 'Couple rooms have exactly 2 people', [
        { field: 'participantCount', code: 'invalid', message: 'must be 2 for couple rooms' },
      ]);
    }

    // FR-ROOM-010: only verified (published) catalog places can be seeded.
    const seedIds = input.seedPlaceIds ?? [];
    const publishedIds = await this.repo.listPublishedPlaces(seedIds);
    if (publishedIds.length !== seedIds.length) {
      throw AppError.badRequest('INVALID_SEED_PLACE', 'Seed places must be verified places', [
        { field: 'seedPlaceIds', code: 'invalid', message: 'contains unknown/unpublished places' },
      ]);
    }

    const user = await this.identity.findUserById(actor.id);
    const { room } = await this.repo.createRoom({
      code: randomBytes(9).toString('base64url'), // 72-bit share code, no PII
      type: input.type,
      decisionMode: input.decisionMode,
      hostUserId: actor.id,
      hostDisplayName: user?.displayName ?? 'Host',
      participantCount: input.participantCount,
      ...(input.title ? { title: input.title } : {}),
      ...(input.scheduledDate ? { scheduledDate: input.scheduledDate } : {}),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      constraint: toNewConstraint(input.constraint),
      seedPlaceIds: seedIds,
      event: {
        eventType: 'room.created',
        resourceType: 'room',
        resourceId: 'pending',
        actorId: user?.analyticsId,
        payload: { type: input.type, decisionMode: input.decisionMode },
      },
    });
    return this.getRoomSummary(actor, room.id);
  }

  /**
   * #152 — "your rooms". A summary per room, not the aggregate: enough to draw
   * a list row (progress, current plan) without a second call per room, and
   * deliberately no invite code — a list screen has no reason to hand one out.
   */
  async listRooms(
    actor: Actor,
    query: { statuses?: string[] | undefined; limit: number; cursor?: string | undefined },
  ) {
    const cursor = query.cursor ? decodeRoomCursor(query.cursor) : undefined;
    const rows = await this.repo.listRoomsForActor({
      actorType: actor.type === 'guest' ? 'guest' : 'user',
      actorId: actor.id,
      ...(query.statuses ? { statuses: query.statuses } : {}),
      limit: query.limit,
      ...(cursor ? { cursor } : {}),
    });

    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        decisionMode: row.decision_mode,
        participantCount: row.participant_count,
        title: row.title ?? undefined,
        scheduledDate: row.scheduled_date ? isoDate(row.scheduled_date) : undefined,
        updatedAt: isoDate(row.updated_at)!,
        myRole: row.my_role,
        myMemberId: row.my_member_id,
        // Enough progress to render the row: "2/3 đã xong" without a per-room call.
        memberCount: row.member_count,
        completedCount: row.completed_count,
        planId: row.plan_id ?? undefined,
      })),
      nextCursor:
        rows.length > query.limit && last ? encodeRoomCursor(last.updated_at, last.id) : null,
    };
  }

  async getRoomSummary(actor: Actor, roomId: string) {
    const { room, member } = await this.policy.requireMember(actor, roomId);
    const [constraint, members, seedPlaces] = await Promise.all([
      this.repo.getCurrentConstraint(roomId, room.constraintVersion),
      this.repo.listMembers(roomId),
      this.repo.listSeedPlaces(roomId),
    ]);
    // ADR-0022, GoGo-BE#552: the same avatar the members endpoint returns. The
    // room screen reads `members` from this summary and nothing else, so
    // omitting it here meant every co-member rendered as initials no matter
    // what they had uploaded — while `RoomMember` in the contract promised the
    // field either way.
    const avatarKeys = await this.repo.avatarKeysByUserId(
      members.flatMap((m) => (m.userId ? [m.userId] : [])),
    );
    // ADM-020: a stored area names the dataset that produced it. When that is
    // no longer the published one the client is told to reselect; the saved
    // labels stay readable and nothing is re-mapped behind the host's back.
    const storedArea = constraint?.administrativeArea ?? null;
    const publishedVersion = storedArea
      ? await this.repo.publishedAdministrativeDatasetVersion()
      : null;
    // Facts only — audience copy is composed client-side (api-contract rule).
    return {
      id: room.id,
      code: member.role === 'host' ? room.code : undefined,
      type: room.type,
      status: room.status,
      decisionMode: room.decisionMode,
      participantCount: room.participantCount,
      constraintVersion: room.constraintVersion,
      title: room.title ?? undefined,
      scheduledDate: (constraint?.startAt ?? room.scheduledDate)?.toISOString(),
      expiresAt: room.expiresAt?.toISOString(),
      myMemberId: member.id,
      myRole: member.role,
      matching: matchingReadiness(room.status, member.role, members),
      constraints: constraint
        ? {
            budgetMode: constraint.budgetMode,
            budgetAmount: constraint.budgetAmount,
            currency: constraint.currency,
            originText: constraint.originText ?? undefined,
            areaKey: constraint.areaKey ?? undefined,
            administrativeArea: storedArea
              ? {
                  datasetVersion: storedArea.datasetVersion,
                  provinceCode: storedArea.provinceCode,
                  provinceName: storedArea.provinceName,
                  communeCode: storedArea.communeCode ?? null,
                  communeName: storedArea.communeName ?? null,
                  status:
                    publishedVersion === storedArea.datasetVersion
                      ? 'current'
                      : 'needs_reselection',
                }
              : null,
            radiusM: constraint.radiusM ?? undefined,
            startAt: constraint.startAt?.toISOString(),
            endAt: constraint.endAt?.toISOString(),
            dietaryKeys: constraint.dietaryKeys,
            accessibilityKeys: constraint.accessibilityKeys,
          }
        : undefined,
      members: members.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        role: m.role,
        selectionStatus: m.selectionStatus,
        isGuest: m.guestSessionId !== null,
        joinedAt: m.joinedAt.toISOString(),
        avatarUrl: m.userId
          ? publicMediaUrl(this.config?.MEDIA_PUBLIC_BASE_URL, avatarKeys.get(m.userId))
          : null,
      })),
      seedPlaces: seedPlaces.map((s) => ({ placeId: s.placeId, name: s.name })),
    };
  }

  async updateConstraints(
    actor: Actor,
    roomId: string,
    input: ConstraintInput & {
      expectedConstraintVersion: number;
      participantCount?: number | undefined;
    },
  ) {
    const { room, member } = await this.policy.requireHost(actor, roomId);
    assertConstraintsEditable(room.status as RoomStatus);
    // #559: an explicit constraint write states the unit, so it is checked like
    // any other write. A legacy `per_person` couple room is readable and
    // editable — the edit just has to name the right unit.
    assertBudgetMode(room.type as RoomType, input.budgetMode);
    if (room.type === 'couple' && input.participantCount && input.participantCount !== 2) {
      throw AppError.badRequest('INVALID_PARTICIPANT_COUNT', 'Couple rooms have exactly 2 people');
    }
    const version = await this.repo.applyConstraintVersion({
      roomId,
      expectedVersion: input.expectedConstraintVersion,
      constraint: toNewConstraint(input),
      memberId: member.id,
      ...(input.participantCount ? { participantCount: input.participantCount } : {}),
      event: {
        eventType: 'room.constraints_updated',
        resourceType: 'room',
        resourceId: roomId,
        payload: { fromVersion: input.expectedConstraintVersion },
      },
    });
    if (version === -1) {
      throw AppError.conflict(
        'CONSTRAINT_VERSION_CONFLICT',
        'Constraints changed concurrently — reload and retry',
      );
    }
    return this.getRoomSummary(actor, roomId);
  }

  /**
   * BE-BFF-022 (#579) — host-only rename while the room is being planned.
   * A name is not a constraint, so nothing goes stale and no version is
   * required: last write wins, the same as creation.
   */
  async renameRoom(actor: Actor, roomId: string, title: string | null) {
    const { room } = await this.policy.requireHost(actor, roomId);
    assertRoomDetailsEditable(room.status as RoomStatus);
    const next = title && title.length > 0 ? title : null;
    await this.repo.renameRoom(roomId, next, {
      eventType: 'room.renamed',
      resourceType: 'room',
      resourceId: roomId,
      // Whether a name exists, never the name itself.
      payload: { cleared: next === null },
    });
    return this.getRoomSummary(actor, roomId);
  }

  async transition(
    actor: Actor,
    roomId: string,
    to: RoomStatus,
    allowIncompletePreferences = false,
  ) {
    const { room } = await this.policy.requireHost(actor, roomId);
    assertTransition(room.status as RoomStatus, to);
    await this.repo.updateStatus(
      roomId,
      to,
      {
        eventType: `room.status_${to}`,
        resourceType: 'room',
        resourceId: roomId,
        payload: { from: room.status, to, allowIncompletePreferences },
      },
      allowIncompletePreferences,
    );
    // Realtime is a courtesy on top of a committed write: publishing after the
    // repository call means a dropped event costs a client one refetch, never
    // a room that moved for some members and not others.
    await this.publish({
      roomId,
      type: 'room.status_changed',
      payload: { from: room.status, to },
    });
    return this.getRoomSummary(actor, roomId);
  }

  /**
   * A realtime publish must never fail the write it describes. The write is
   * already committed by the time this runs, so a bus that is down degrades
   * clients to polling instead of turning a successful action into a 500.
   */
  private async publish(input: Parameters<RoomEventBus['publish']>[0]): Promise<void> {
    try {
      await this.events.publish(input);
    } catch {
      /* transport-only failure; the durable record is the room's own tables */
    }
  }

  async listMembers(actor: Actor, roomId: string) {
    await this.policy.requireMember(actor, roomId);
    const members = await this.repo.listMembers(roomId);
    // ADR-0022: the avatar is the one profile fact a co-member may see. One
    // lookup for the whole list; guests never carry one.
    const avatarKeys = await this.repo.avatarKeysByUserId(
      members.flatMap((m) => (m.userId ? [m.userId] : [])),
    );
    // FR-PREF-005: progress only — never other members' selections.
    return members.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      role: m.role,
      selectionStatus: m.selectionStatus,
      isGuest: m.guestSessionId !== null,
      joinedAt: m.joinedAt.toISOString(),
      avatarUrl: m.userId
        ? publicMediaUrl(this.config?.MEDIA_PUBLIC_BASE_URL, avatarKeys.get(m.userId))
        : null,
    }));
  }

  async removeMember(actor: Actor, roomId: string, memberId: string) {
    const { member: me } = await this.policy.requireHost(actor, roomId);
    const target = await this.repo.getMemberById(memberId);
    if (!target || target.roomId !== roomId || target.removedAt) {
      throw AppError.notFound('MEMBER_NOT_FOUND', 'Member not found');
    }
    if (target.id === me.id) {
      throw AppError.conflict('CANNOT_REMOVE_SELF', 'Host cannot remove themselves');
    }
    const { guestSessionId } = await this.repo.removeMember({
      memberId,
      removedByMemberId: me.id,
      event: {
        eventType: 'member.removed',
        resourceType: 'room',
        resourceId: roomId,
        payload: { memberId },
      },
    });
    // The guest's access token is self-contained — deny it now rather than
    // letting a removed member keep reading the room until it expires.
    if (guestSessionId) await this.revocations.revokeSession(guestSessionId);
    await this.publish({
      roomId,
      type: 'participant.left',
      actorId: me.id,
      payload: { memberId, removedByMemberId: me.id },
    });
    return { removed: true };
  }

  // --- invites --------------------------------------------------------------

  async createInvite(
    actor: Actor,
    roomId: string,
    maxUses?: number,
    /**
     * LNK-BE-002 (#205): a canonical share link's slug doubles as the invite
     * code, so the link service supplies it. Same entropy contract as ours —
     * 128 bits, base64url — and it is hashed here exactly like a generated one.
     */
    options: { code?: string } = {},
  ) {
    const { room, member } = await this.policy.requireHost(actor, roomId);
    if (!['draft', 'collecting'].includes(room.status)) {
      throw AppError.conflict('ROOM_NOT_JOINABLE', 'Room is not accepting new members');
    }
    const code = options.code ?? randomBytes(16).toString('base64url'); // 128-bit, no PII
    const invite = await this.repo.createInvite({
      roomId,
      codeHash: this.tokens.hashOpaqueToken(code),
      createdByMemberId: member.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      ...(maxUses ? { maxUses } : {}),
    });
    // Plaintext code is returned exactly once and never stored or logged.
    return {
      inviteId: invite.id,
      code,
      expiresAt: invite.expiresAt.toISOString(),
      maxUses: invite.maxUses ?? undefined,
    };
  }

  async listInvites(actor: Actor, roomId: string) {
    await this.policy.requireHost(actor, roomId);
    const invites = await this.repo.listInvites(roomId);
    return invites.map((i) => ({
      inviteId: i.id,
      expiresAt: i.expiresAt.toISOString(),
      revoked: i.revokedAt !== null,
      useCount: i.useCount,
      maxUses: i.maxUses ?? undefined,
    }));
  }

  async revokeInvite(actor: Actor, roomId: string, inviteId: string) {
    await this.policy.requireHost(actor, roomId);
    const invites = await this.repo.listInvites(roomId);
    if (!invites.some((i) => i.id === inviteId)) {
      throw AppError.notFound('INVITE_NOT_FOUND', 'Invite not found');
    }
    await this.repo.revokeInvite(inviteId);
    return { revoked: true };
  }

  /**
   * Resolve + consume an invite code. Shared by user join and guest join.
   *
   * GoGo-BE#592 — every refusal is decided before the use is spent. This used
   * to consume first and check the room afterwards, so each 410
   * `ROOM_NOT_JOINABLE` still counted against `maxUses`.
   */
  async consumeInviteCode(code: string, rules: JoinRules = {}): Promise<RoomRow> {
    const invite = await this.repo.findInviteByHash(this.tokens.hashOpaqueToken(code));
    if (!invite) throw AppError.notFound('INVITE_NOT_FOUND', 'Invite not found');
    const room = await this.policy.getRoom(invite.roomId);
    const refusal = inviteJoinRefusal(invite, roomState(room), new Date(), rules);
    if (refusal) throw joinRefused(refusal);
    const consumed = await this.repo.consumeInvite(invite.id, {
      joinableStatuses: JOINABLE_ROOM_STATUSES,
      ...rules,
    });
    if (!consumed) {
      // The invite or the room changed between the read above and the guarded
      // UPDATE, and nothing was spent. Read both again to say which.
      const [nowInvite, nowRoom] = await Promise.all([
        this.repo.findInviteByHash(invite.codeHash),
        this.policy.getRoom(invite.roomId),
      ]);
      const reason = nowInvite
        ? inviteJoinRefusal(nowInvite, roomState(nowRoom), new Date(), rules)
        : null;
      throw joinRefused(reason ?? 'INVITE_NOT_USABLE');
    }
    return room;
  }

  /** Authenticated user joins via invite code (guests go through /sessions/guest). */
  async joinAsUser(actor: Actor, inviteCode: string) {
    if (actor.type !== 'user') {
      throw AppError.forbidden('USER_ONLY', 'Use the guest session endpoint instead');
    }
    const room = await this.consumeInviteCode(inviteCode);
    const user = await this.identity.findUserById(actor.id);
    const member = await this.repo.addUserMember({
      roomId: room.id,
      userId: actor.id,
      displayName: user?.displayName ?? 'Member',
      event: {
        eventType: 'member.joined',
        resourceType: 'room',
        resourceId: room.id,
        actorId: user?.analyticsId,
        payload: { memberType: 'user' },
      },
    });
    await this.publish({
      roomId: room.id,
      type: 'participant.joined',
      // The room-scoped member id, not the user id: it identifies the
      // participant inside this room without carrying an account across rooms.
      actorId: member.id,
      payload: { memberId: member.id, role: member.role, memberType: 'user' },
    });
    return { roomId: room.id, memberId: member.id, role: member.role };
  }

  // --- seed places (FR-ROOM-010/011, BE-BFF-015) ---------------------------

  async addSeedPlaces(actor: Actor, roomId: string, placeIds: string[]) {
    const { room, member } = await this.policy.requireHost(actor, roomId);
    if (!['draft', 'collecting'].includes(room.status)) {
      throw AppError.conflict('ROOM_NOT_EDITABLE', 'Seed places can only change before matching');
    }
    const published = await this.repo.listPublishedPlaces(placeIds);
    if (published.length !== placeIds.length) {
      throw AppError.badRequest('INVALID_SEED_PLACE', 'Seed places must be verified places');
    }
    await this.repo.addSeedPlaces(roomId, placeIds, member.id);
    return { seedPlaces: await this.repo.listSeedPlaces(roomId) };
  }

  async removeSeedPlace(actor: Actor, roomId: string, placeId: string) {
    await this.policy.requireHost(actor, roomId);
    await this.repo.removeSeedPlace(roomId, placeId);
    return { seedPlaces: await this.repo.listSeedPlaces(roomId) };
  }
}

function roomState(room: RoomRow): { status: string; expiresAt: Date | null } {
  return { status: room.status, expiresAt: room.expiresAt ?? null };
}

function joinRefused(refusal: JoinRefusal): AppError {
  switch (refusal) {
    case 'ROOM_NOT_JOINABLE':
      return AppError.gone('ROOM_NOT_JOINABLE', 'Room is no longer accepting members');
    case 'ROOM_EXPIRED':
      return AppError.gone('ROOM_EXPIRED', 'Room link has expired');
    default:
      return AppError.gone('INVITE_NOT_USABLE', 'Invite expired, revoked or fully used');
  }
}

function isoDate(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function encodeRoomCursor(updatedAt: Date | string, id: string): string {
  return Buffer.from(JSON.stringify([isoDate(updatedAt), id])).toString('base64url');
}

export function decodeRoomCursor(cursor: string): { updatedAt: string; id: string } {
  try {
    const [updatedAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [
      string,
      string,
    ];
    if (typeof updatedAt !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('bad');
    return { updatedAt, id };
  } catch {
    throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid');
  }
}

import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppError } from '../../shared/app-error';
import type { Actor } from '../../identity/domain/actor';
import { TokenService } from '../../identity/application/token.service';
import { IdentityRepository } from '../../identity/infrastructure/identity.repository';
import { SessionRevocationService } from '../../identity/application/session-revocation.service';
import {
  assertConstraintsEditable,
  assertDecisionMode,
  assertTransition,
  type DecisionMode,
  type RoomStatus,
  type RoomType,
} from '../domain/room-state';
import { RoomPolicy } from '../presentation/room-policy';
import {
  RoomsRepository,
  type NewConstraint,
  type RoomRow,
} from '../infrastructure/rooms.repository';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export type ConstraintInput = {
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

  async getRoomSummary(actor: Actor, roomId: string) {
    const { room, member } = await this.policy.requireMember(actor, roomId);
    const [constraint, members, seedPlaces] = await Promise.all([
      this.repo.getCurrentConstraint(roomId, room.constraintVersion),
      this.repo.listMembers(roomId),
      this.repo.listSeedPlaces(roomId),
    ]);
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
      scheduledDate: room.scheduledDate?.toISOString(),
      expiresAt: room.expiresAt?.toISOString(),
      myMemberId: member.id,
      myRole: member.role,
      constraints: constraint
        ? {
            budgetMode: constraint.budgetMode,
            budgetAmount: constraint.budgetAmount,
            currency: constraint.currency,
            originText: constraint.originText ?? undefined,
            areaKey: constraint.areaKey ?? undefined,
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

  async transition(actor: Actor, roomId: string, to: RoomStatus) {
    const { room } = await this.policy.requireHost(actor, roomId);
    assertTransition(room.status as RoomStatus, to);
    await this.repo.updateStatus(roomId, to, {
      eventType: `room.status_${to}`,
      resourceType: 'room',
      resourceId: roomId,
      payload: { from: room.status, to },
    });
    return this.getRoomSummary(actor, roomId);
  }

  async listMembers(actor: Actor, roomId: string) {
    await this.policy.requireMember(actor, roomId);
    const members = await this.repo.listMembers(roomId);
    // FR-PREF-005: progress only — never other members' selections.
    return members.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      role: m.role,
      selectionStatus: m.selectionStatus,
      isGuest: m.guestSessionId !== null,
      joinedAt: m.joinedAt.toISOString(),
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
    return { removed: true };
  }

  // --- invites --------------------------------------------------------------

  async createInvite(actor: Actor, roomId: string, maxUses?: number) {
    const { room, member } = await this.policy.requireHost(actor, roomId);
    if (!['draft', 'collecting'].includes(room.status)) {
      throw AppError.conflict('ROOM_NOT_JOINABLE', 'Room is not accepting new members');
    }
    const code = randomBytes(16).toString('base64url'); // 128-bit, no PII
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

  /** Resolve + consume an invite code. Shared by user join and guest join. */
  async consumeInviteCode(code: string): Promise<RoomRow> {
    const invite = await this.repo.findInviteByHash(this.tokens.hashOpaqueToken(code));
    if (!invite) throw AppError.notFound('INVITE_NOT_FOUND', 'Invite not found');
    const ok = await this.repo.consumeInvite(invite.id);
    if (!ok) throw AppError.gone('INVITE_NOT_USABLE', 'Invite expired, revoked or fully used');
    const room = await this.policy.getRoom(invite.roomId);
    if (!['draft', 'collecting'].includes(room.status)) {
      throw AppError.gone('ROOM_NOT_JOINABLE', 'Room is no longer accepting members');
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

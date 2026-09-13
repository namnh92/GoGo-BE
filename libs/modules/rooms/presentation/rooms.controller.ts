import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { AuthService } from '../../identity/application/auth.service';
import { CurrentActor, Public, RateLimit } from '../../identity/presentation/decorators';
import { RoomsService } from '../application/rooms.service';
import type { RoomStatus } from '../domain/room-state';
import {
  createInviteSchema,
  createRoomSchema,
  guestJoinSchema,
  joinRoomSchema,
  seedPlacesSchema,
  transitionSchema,
  updateConstraintsSchema,
  uuidSchema,
  type CreateInviteDto,
  type CreateRoomDto,
  type GuestJoinDto,
  type JoinRoomDto,
  type SeedPlacesDto,
  type TransitionDto,
  type UpdateConstraintsDto,
} from './dtos';

const ROOM_STATUSES = [
  'draft',
  'collecting',
  'matching',
  'ready',
  'active',
  'completed',
  'cancelled',
  'expired',
] as const;

/** Repeatable or CSV, so "active rooms" does not have to pull all history. */
const roomListQuery = z.object({
  status: z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (Array.isArray(value) ? value : value.split(','))
        .map((item) => item.trim())
        .filter((item): item is (typeof ROOM_STATUSES)[number] =>
          (ROOM_STATUSES as readonly string[]).includes(item),
        ),
    )
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional(),
});

const UuidPipe = new ZodValidationPipe(uuidSchema);

@Controller('rooms')
export class RoomsController {
  constructor(
    private readonly rooms: RoomsService,
    private readonly auth: AuthService,
  ) {}

  @RateLimit({ action: 'rooms.create', limit: 10, windowSeconds: 60, keyBy: 'actor' })
  @Post()
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createRoomSchema)) body: CreateRoomDto,
  ) {
    return this.rooms.createRoom(actor, {
      type: body.type,
      decisionMode: body.decisionMode,
      participantCount: body.participantCount,
      ...(body.title ? { title: body.title } : {}),
      ...(body.scheduledDate ? { scheduledDate: body.scheduledDate } : {}),
      constraint: stripUndefined(body.constraint),
      seedPlaceIds: body.seedPlaceIds,
    });
  }

  /** #152 — a room used to be reachable only by id; losing it lost the room. */
  @Get()
  list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(roomListQuery)) query: z.infer<typeof roomListQuery>,
  ) {
    return this.rooms.listRooms(actor, {
      ...(query.status ? { statuses: query.status } : {}),
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  }

  @Get(':id')
  get(@CurrentActor() actor: Actor, @Param('id', UuidPipe) id: string) {
    return this.rooms.getRoomSummary(actor, id);
  }

  @Patch(':id/constraints')
  updateConstraints(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(updateConstraintsSchema)) body: UpdateConstraintsDto,
  ) {
    return this.rooms.updateConstraints(actor, id, stripUndefined(body));
  }

  @Patch(':id/status')
  transition(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(transitionSchema)) body: TransitionDto,
  ) {
    return this.rooms.transition(
      actor,
      id,
      body.status as RoomStatus,
      body.allowIncompletePreferences,
    );
  }

  @Get(':id/members')
  members(@CurrentActor() actor: Actor, @Param('id', UuidPipe) id: string) {
    return this.rooms.listMembers(actor, id);
  }

  @Delete(':id/members/:memberId')
  removeMember(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Param('memberId', UuidPipe) memberId: string,
  ) {
    return this.rooms.removeMember(actor, id, memberId);
  }

  @RateLimit({ action: 'rooms.invite', limit: 20, windowSeconds: 60, keyBy: 'actor' })
  @Post(':id/invites')
  createInvite(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(createInviteSchema)) body: CreateInviteDto,
  ) {
    return this.rooms.createInvite(actor, id, body.maxUses);
  }

  @Get(':id/invites')
  listInvites(@CurrentActor() actor: Actor, @Param('id', UuidPipe) id: string) {
    return this.rooms.listInvites(actor, id);
  }

  @Delete(':id/invites/:inviteId')
  revokeInvite(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Param('inviteId', UuidPipe) inviteId: string,
  ) {
    return this.rooms.revokeInvite(actor, id, inviteId);
  }

  /** Authenticated user joins via invite code (FR-ROOM-006). */
  @RateLimit({ action: 'rooms.join', limit: 10, windowSeconds: 60, keyBy: 'ip+actor' })
  @Post('join')
  join(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(joinRoomSchema)) body: JoinRoomDto,
  ) {
    return this.rooms.joinAsUser(actor, body.inviteCode);
  }

  /**
   * Guest joins via invite code without an account (FR-AUTH-002). Public —
   * the invite code is the credential; rate-limited per security rules.
   */
  @Public()
  @RateLimit({ action: 'rooms.join_guest', limit: 10, windowSeconds: 60, keyBy: 'ip' })
  @Post('join/guest')
  async joinGuest(@Body(new ZodValidationPipe(guestJoinSchema)) body: GuestJoinDto) {
    const room = await this.rooms.consumeInviteCode(body.inviteCode);
    const session = await this.auth.createGuestSession({
      roomCode: room.code,
      displayName: body.displayName,
    });
    return {
      guestSessionId: session.actor.id,
      roomId: session.roomId,
      accessToken: session.accessToken,
      guestToken: session.guestToken,
    };
  }

  @Post(':id/seed-places')
  addSeeds(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(seedPlacesSchema)) body: SeedPlacesDto,
  ) {
    return this.rooms.addSeedPlaces(actor, id, body.placeIds);
  }

  @Delete(':id/seed-places/:placeId')
  removeSeed(
    @CurrentActor() actor: Actor,
    @Param('id', UuidPipe) id: string,
    @Param('placeId', UuidPipe) placeId: string,
  ) {
    return this.rooms.removeSeedPlace(actor, id, placeId);
  }
}

/** exactOptionalPropertyTypes helper: drop keys whose value is undefined. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

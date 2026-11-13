import type { Actor } from '../../identity/domain/actor';
import { AppError } from '../../shared/app-error';

export const ROOM_SEED_LIMIT = 10;
export function normalizeSeedIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
}

type SeedMember = { id: string; userId: string | null; role: string; removedAt: Date | null };
export function assertSeedContributor(
  actor: Actor,
  room: { id: string; hostUserId: string },
  members: SeedMember[],
): SeedMember {
  if (actor.type === 'guest' && actor.roomId?.toLowerCase() !== room.id)
    throw AppError.forbidden('ROOM_SCOPE_VIOLATION', 'Guest session is bound to another room');
  if (actor.type !== 'user')
    throw AppError.forbidden(
      'SEED_PLACES_FORBIDDEN',
      'Only account members can contribute seed places',
    );
  const active = members.filter((m) => m.removedAt === null);
  const member = active.find((m) => m.userId === actor.id);
  if (!member) throw AppError.forbidden('NOT_A_MEMBER', 'You are not a member of this room');
  const hosts = active.filter((m) => m.role === 'host');
  if (
    hosts.length !== 1 ||
    hosts[0]!.userId !== room.hostUserId ||
    !['host', 'member'].includes(member.role)
  )
    throw AppError.forbidden('SEED_PLACES_FORBIDDEN', 'Room membership authority is inconsistent');
  return member;
}
export function assertSeedEditable(
  room: { status: string; expiresAt: Date | null },
  now = new Date(),
): void {
  if (
    !['draft', 'collecting'].includes(room.status) ||
    (room.expiresAt !== null && room.expiresAt <= now)
  )
    throw AppError.conflict(
      'ROOM_NOT_EDITABLE',
      'Seed places can only change before matching and room expiry',
    );
}
export function assertSeedOwnership(
  member: Pick<SeedMember, 'id' | 'role'>,
  creator: string,
): void {
  if (member.role !== 'host' && creator !== member.id)
    throw AppError.forbidden(
      'SEED_PLACE_NOT_OWNED',
      'Members can only remove their own seed places',
    );
}
export type RoomSeedPlaceDto = {
  placeId: string;
  name: string;
  position: number;
  addedByMemberId: string;
};
export type RoomSeedPlacesResponse = { seedPlaces: RoomSeedPlaceDto[]; constraintVersion: number };

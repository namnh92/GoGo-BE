import { describe, expect, it } from 'vitest';
import type { Actor } from '../../identity/domain/actor';
import {
  assertSeedContributor,
  assertSeedEditable,
  assertSeedOwnership,
  normalizeSeedIds,
} from './seed-contribution';
const room = { id: 'room', hostUserId: 'host' };
const host = { id: 'host-member', userId: 'host', role: 'host', removedAt: null };
const member = { id: 'member', userId: 'user', role: 'member', removedAt: null };
const user: Actor = { type: 'user', id: 'user', sessionId: 'session' };
describe('#878 contribution policy', () => {
  it('normalizes and deduplicates UUID spelling without assigning another creator', () => {
    expect(normalizeSeedIds(['BBBB', 'aaaa', 'bbbb'])).toEqual(['aaaa', 'bbbb']);
  });
  it('authorizes a live account member independently of participant count', () => {
    expect(assertSeedContributor(user, room, [host, member])).toBe(member);
    expect(
      assertSeedContributor(user, room, [
        host,
        member,
        { ...member, id: 'third', userId: 'third' },
      ]),
    ).toBe(member);
  });
  it.each(['member', 'host'])('refuses guest actors even with database role %s', (role) => {
    expect(() =>
      assertSeedContributor({ ...user, type: 'guest', roomId: 'room' }, room, [
        host,
        { ...member, role },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'SEED_PLACES_FORBIDDEN', httpStatus: 403 }));
  });
  it('refuses cross-room guest before policy/state', () => {
    expect(() =>
      assertSeedContributor({ ...user, type: 'guest', roomId: 'other' }, room, []),
    ).toThrowError(expect.objectContaining({ code: 'ROOM_SCOPE_VIOLATION' }));
  });
  it.each([{ members: [] }, { members: [host, { ...member, removedAt: new Date() }] }])(
    'refuses outsider/removed or pending applicant',
    ({ members }) => {
      expect(() => assertSeedContributor(user, room, members)).toThrowError(
        expect.objectContaining({ code: 'NOT_A_MEMBER' }),
      );
    },
  );
  it('fails closed on inconsistent ownership or multiple hosts', () => {
    for (const members of [
      [{ ...host, userId: 'other' }, member],
      [host, { ...member, role: 'host' }],
    ])
      expect(() => assertSeedContributor(user, room, members)).toThrowError(
        expect.objectContaining({ code: 'SEED_PLACES_FORBIDDEN' }),
      );
  });
  it.each(['draft', 'collecting'])('allows %s and a return to collecting', (status) => {
    expect(() => assertSeedEditable({ status, expiresAt: null })).not.toThrow();
  });
  it.each(['matching', 'ready', 'active', 'completed', 'cancelled', 'expired'])(
    'refuses %s',
    (status) => {
      expect(() => assertSeedEditable({ status, expiresAt: null })).toThrowError(
        expect.objectContaining({ code: 'ROOM_NOT_EDITABLE', httpStatus: 409 }),
      );
    },
  );
  it('refuses expired collecting rooms', () => {
    expect(() => assertSeedEditable({ status: 'collecting', expiresAt: new Date(0) })).toThrowError(
      expect.objectContaining({ code: 'ROOM_NOT_EDITABLE' }),
    );
  });
  it('ownership belongs to the membership; host manages removed creators', () => {
    expect(() => assertSeedOwnership(member, member.id)).not.toThrow();
    expect(() => assertSeedOwnership(host, 'removed-member')).not.toThrow();
    expect(() => assertSeedOwnership({ ...member, id: 'new-membership' }, member.id)).toThrowError(
      expect.objectContaining({ code: 'SEED_PLACE_NOT_OWNED' }),
    );
  });
});

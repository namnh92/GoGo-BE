/**
 * Actor model (ADR-0003). Every authenticated request resolves to exactly one
 * Actor; policies authorize on actor + membership + role + resource state.
 */

export type ActorType = 'user' | 'guest' | 'admin';

export type Actor = {
  type: ActorType;
  /** users.id for users, guest_sessions.id for guests. */
  id: string;
  /** auth_sessions.id (users) or guest_sessions.id (guests). */
  sessionId: string;
  /** Guests are scoped to exactly one room; undefined for users. */
  roomId?: string;
  displayName?: string;
};

export type AccessTokenClaims = {
  sub: string;
  act: ActorType;
  sid: string;
  room?: string;
  jti: string;
  iat: number;
  exp: number;
};

export const ACCESS_TOKEN_AUDIENCE = 'gogo-api';
export const ACCESS_TOKEN_ISSUER = 'gogo';

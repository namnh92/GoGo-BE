/**
 * BE-BFF-013 (#154) — the room realtime contract.
 *
 * Every one of these is server → client, which is why this is SSE and not a
 * WebSocket: nothing here needs a bidirectional channel, and SSE keeps the
 * auth story identical to the rest of the API.
 */
export const ROOM_EVENT_TYPES = [
  'room.status_changed',
  'participant.joined',
  'participant.left',
  'participant.selection_changed',
  'matching.started',
  'matching.completed',
  'matching.failed',
  'suggestions.generated',
  'suggestions.updated',
  'vote.changed',
  'plan.updated',
  /**
   * Not a domain event: the stream telling a client its resume point is gone
   * and it must refetch. Emitted instead of silently skipping the gap — a
   * client that is wrong without knowing it is the failure mode this whole
   * endpoint exists to avoid.
   */
  'resync',
  /**
   * Keeps idle connections alive through proxies. A named event rather than a
   * bare `:` comment frame because the framework serializes structured
   * messages; either keeps the socket warm, and clients ignore this one.
   */
  'heartbeat',
] as const;

export type RoomEventType = (typeof ROOM_EVENT_TYPES)[number];

/**
 * The envelope from the api-contract rules, unchanged: domain events carry
 * `event_id`, `event_version`, `occurred_at`, a pseudonymous `actor_id`,
 * `resource_id`, a correlation id, and a payload schema version.
 *
 * Payloads carry facts, never composed copy, and carry the version a client
 * should compare against (`constraintVersion`, plan `version`) so a stale
 * event can be told apart from a fresh one.
 */
export type RoomEvent = {
  event_id: string;
  event_type: RoomEventType;
  event_version: number;
  occurred_at: string;
  actor_id: string | null;
  resource_type: string;
  resource_id: string;
  correlation_id: string | null;
  payload_schema_version: number;
  payload: Record<string, unknown>;
};

/** What a subscriber receives: the event plus its per-room sequence number. */
export type SequencedRoomEvent = { seq: number; event: RoomEvent };

export type PublishInput = {
  roomId: string;
  type: RoomEventType;
  /** Pseudonymous — never a raw user id (privacy rules). */
  actorId?: string | null;
  resourceType?: string;
  resourceId?: string;
  correlationId?: string | null;
  payload?: Record<string, unknown>;
};

/**
 * One shared admission decision for the two short-window routing budgets.
 *
 * This is deliberately not a general request rate limit. A successful
 * reservation authorises a paid Routes call, so an unavailable shared store
 * must be observable to the caller and must never degrade to process-local
 * counters.
 */
export type RoutingReservationRequest = {
  roomId: string;
  actorKey: string;
  windowSeconds: number;
  perRoom: number;
  perActor: number;
};

export type RoutingReservationResult =
  { ok: true } | { ok: false; reason: 'room' | 'actor' | 'both' | 'unavailable' };

export interface RoutingReservation {
  reserve(request: RoutingReservationRequest): Promise<RoutingReservationResult>;
}

export const ROUTING_RESERVATION = Symbol('ROUTING_RESERVATION');

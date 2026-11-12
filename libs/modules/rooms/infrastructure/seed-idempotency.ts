import { createHash } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { schema } from '@gogo/database';
import type { Actor } from '../../identity/domain/actor';
import { AppError } from '../../shared/app-error';
import {
  beginIdempotent,
  completeIdempotentWithin,
  type IdempotencyClaim,
  type IdempotencyScope,
} from '../../shared/idempotency.interceptor';
import type { Tx } from '../../shared/outbox';
import type { RoomSeedPlacesResponse } from '../domain/seed-contribution';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export type SeedReplayInput = {
  key: string;
  actor: Actor;
  roomId: string;
  operation: 'add' | 'remove';
  placeIds: string[];
};
export function seedScopes(input: SeedReplayInput): {
  concrete: IdempotencyScope;
  legacy: IdempotencyScope;
} {
  if (!/^[\w-]{8,128}$/.test(input.key))
    throw AppError.badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 chars', [
      { field: 'Idempotency-Key', code: 'invalid', message: 'expected [A-Za-z0-9_-]{8,128}' },
    ]);
  const actorScope = `${input.actor.type}:${input.actor.id}`;
  const method = input.operation === 'add' ? 'POST' : 'DELETE';
  const template = `${method} /v1/rooms/:id/seed-places${input.operation === 'remove' ? '/:placeId' : ''}`;
  const endpoint = `${method} /v1/rooms/${input.roomId}/seed-places${input.operation === 'remove' ? `/${input.placeIds[0]}` : ''}`;
  const requestHash = hash(JSON.stringify({ roomId: input.roomId, placeIds: input.placeIds }));
  const scope = (route: string): IdempotencyScope => ({
    actorScope,
    endpoint: route,
    storedKey: hash(`${actorScope}|${route}|${input.key}`),
    requestHash,
  });
  return { concrete: scope(endpoint), legacy: scope(template) };
}

/** The template row binds a key to its first concrete resource and detects old unsafe records.
 * Both claims and their completions live in the seed transaction. Never purge legacy replay. */
export async function beginSeedReplay(
  tx: Tx,
  input: SeedReplayInput,
): Promise<
  | { kind: 'replay'; body: RoomSeedPlacesResponse }
  | { kind: 'owned'; claim: IdempotencyClaim; binding?: IdempotencyClaim }
> {
  const { concrete, legacy } = seedScopes(input);
  const [old] = await tx
    .select()
    .from(schema.idempotencyKeys)
    .where(
      and(
        eq(schema.idempotencyKeys.key, legacy.storedKey),
        gt(schema.idempotencyKeys.expiresAt, new Date()),
      ),
    )
    .for('update');
  if (old) {
    const marker = old.responseBody as { seedResource?: unknown } | null;
    if (!marker || typeof marker.seedResource !== 'string')
      throw AppError.conflict('IDEMPOTENCY_CONTEXT_CHANGED', 'Reload the room and use a new key');
  }
  const bound = await beginIdempotent(tx, legacy);
  if (
    bound.kind === 'replay' &&
    (bound.body as { seedResource?: string })?.seedResource !== concrete.endpoint
  )
    throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Key was used for a different resource', 422);
  const begun = await beginIdempotent(tx, concrete);
  if (begun.kind === 'replay') {
    // The binding can expire a few milliseconds before the concrete response.
    // Finish a reclaimed binding even on replay, never commit an in-flight marker.
    if (
      bound.kind === 'owned' &&
      !(await completeIdempotentWithin(tx, bound.claim, 200, { seedResource: concrete.endpoint }))
    )
      throw AppError.conflict('IDEMPOTENT_REQUEST_IN_FLIGHT', 'Replay binding changed; retry');
    return { kind: 'replay', body: begun.body as RoomSeedPlacesResponse };
  }
  return {
    kind: 'owned',
    claim: begun.claim,
    ...(bound.kind === 'owned' ? { binding: bound.claim } : {}),
  };
}
export async function completeSeedReplay(
  tx: Tx,
  input: SeedReplayInput,
  claim: IdempotencyClaim,
  binding: IdempotencyClaim | undefined,
  body: RoomSeedPlacesResponse,
): Promise<void> {
  if (
    !(await completeIdempotentWithin(tx, claim, 200, body)) ||
    (binding &&
      !(await completeIdempotentWithin(tx, binding, 200, {
        seedResource: seedScopes(input).concrete.endpoint,
      })))
  )
    throw AppError.conflict('IDEMPOTENT_REQUEST_IN_FLIGHT', 'Replay claim changed; retry');
}

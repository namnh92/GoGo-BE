import { randomUUID } from 'node:crypto';
import { schema, type Db } from '@gogo/database';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type DomainEventInput = {
  eventType: string;
  resourceType: string;
  resourceId: string;
  /** Pseudonymous actor id — users.analytics_id or hashed guest id. Never a raw user id. */
  actorId?: string | undefined;
  correlationId?: string | undefined;
  payload: Record<string, unknown>;
  eventVersion?: number | undefined;
};

/**
 * Transactional outbox (api-contract rules): domain events are written in the
 * same transaction as the state change; the worker publishes them
 * at-least-once and consumers are idempotent on event id.
 */
export async function writeOutbox(db: Db | Tx, event: DomainEventInput): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.outboxEvents).values({
    id,
    eventType: event.eventType,
    eventVersion: event.eventVersion ?? 1,
    actorId: event.actorId,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    correlationId: event.correlationId,
    payloadSchemaVersion: 1,
    payload: event.payload,
  });
  return id;
}

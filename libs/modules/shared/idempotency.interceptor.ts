import {
  Inject,
  Injectable,
  SetMetadata,
  type CallHandler,
  type CustomDecorator,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { catchError, from, of, switchMap, throwError, type Observable } from 'rxjs';
import { schema, type Db } from '@gogo/database';
import { AppError } from './app-error';
import { DB } from './tokens';
import type { Tx } from './outbox';
import type { Actor } from '../identity/domain/actor';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_TTL_HOURS = 24;
const KEY_PATTERN = /^[\w-]{8,128}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export const MANUAL_IDEMPOTENCY_KEY = 'gogo:manual_idempotency';

/**
 * GoGo-BE#440 — a route that owns its own replay record.
 *
 * The interceptor below completes the record *after* the handler has returned,
 * which is after the handler's transaction has committed. A failure between the
 * two releases the key, and the client's retry then repeats a mutation that
 * already happened. A route that cannot afford that — creating a place is one —
 * writes the completion inside its own transaction instead, with
 * `completeIdempotentWithin`, and the interceptor stands aside.
 */
export const ManualIdempotency = (): CustomDecorator => SetMetadata(MANUAL_IDEMPOTENCY_KEY, true);

/**
 * GoGo-BE#440 — a route whose answer must never be stored for replay: a
 * provider preview may not be held across requests (ADR-0006 §9.5), and a
 * replay row is exactly that. The interceptor stands aside, the same as for
 * `ManualIdempotency`; the route is a read dressed as a POST, so re-running it
 * is the correct retry.
 */
export const NoIdempotencyReplay = (): CustomDecorator => SetMetadata(MANUAL_IDEMPOTENCY_KEY, true);

/** One replay record's identity: scoped per actor + method + route + client key. */
export type IdempotencyScope = {
  storedKey: string;
  actorScope: string;
  endpoint: string;
  requestHash: string;
};

export function idempotencyScope(
  req: FastifyRequest & { actor?: Actor },
  clientKey: string,
): IdempotencyScope {
  if (!KEY_PATTERN.test(clientKey)) {
    throw AppError.badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 chars', [
      { field: 'Idempotency-Key', code: 'invalid', message: 'expected [A-Za-z0-9_-]{8,128}' },
    ]);
  }
  const actorScope = req.actor ? `${req.actor.type}:${req.actor.id}` : `ip:${req.ip}`;
  const endpoint = `${req.method} ${req.routeOptions?.url ?? req.url}`;
  return {
    storedKey: sha256(`${actorScope}|${endpoint}|${clientKey}`),
    actorScope,
    endpoint,
    requestHash: sha256(JSON.stringify(req.body ?? null)),
  };
}

/**
 * A claim on one replay record. `claimedAt` is what makes it *this* claim:
 * once a key has expired and been reclaimed by someone else, the old holder's
 * release or completion matches nothing instead of touching the new claim.
 */
export type IdempotencyClaim = { storedKey: string; claimedAt: Date };

export type IdempotencyBegin =
  { kind: 'owned'; claim: IdempotencyClaim } | { kind: 'replay'; status: number; body: unknown };

const CLAIM_ATTEMPTS = 3;

/**
 * Claims the key, or answers with what the first execution stored. A changed
 * body is a 422 and a first execution still running is a 409.
 *
 * GoGo-BE#440 F-03 — the claim is one statement: insert, or take over a row
 * whose 24 hours have passed. The old shape (insert-or-nothing, then select)
 * had a gap: a row expired or released between the two answered "no row", and
 * the caller executed the mutation without owning any record — so two callers
 * could both mutate, and the completion matched nothing. A row that vanishes
 * between the claim and the read now sends the caller round again; it never
 * executes unclaimed.
 */
export async function beginIdempotent(db: Db, scope: IdempotencyScope): Promise<IdempotencyBegin> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    // Millisecond precision on purpose: the value round-trips through a JS
    // Date unchanged, so later matches on it are exact.
    const claimedAt = new Date();
    const claimed = await db
      .insert(schema.idempotencyKeys)
      .values({
        key: scope.storedKey,
        actorId: scope.actorScope,
        endpoint: scope.endpoint,
        requestHash: scope.requestHash,
        createdAt: claimedAt,
        expiresAt: new Date(claimedAt.getTime() + KEY_TTL_HOURS * 3600 * 1000),
      })
      .onConflictDoUpdate({
        target: schema.idempotencyKeys.key,
        set: {
          actorId: scope.actorScope,
          endpoint: scope.endpoint,
          requestHash: scope.requestHash,
          responseStatus: null,
          responseBody: null,
          createdAt: claimedAt,
          expiresAt: new Date(claimedAt.getTime() + KEY_TTL_HOURS * 3600 * 1000),
        },
        // Only an expired record may be taken over; a live one is answered below.
        setWhere: sql`${schema.idempotencyKeys.expiresAt} <= now()`,
      })
      .returning({ key: schema.idempotencyKeys.key });
    if (claimed.length > 0) {
      return { kind: 'owned', claim: { storedKey: scope.storedKey, claimedAt } };
    }

    const [existing] = await db
      .select()
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.key, scope.storedKey))
      .limit(1);
    if (!existing) continue; // released or purged since the claim — claim again
    if (existing.requestHash !== scope.requestHash) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already used with a different request body',
        422,
      );
    }
    if (existing.responseStatus === null) {
      // Original request still in flight — client should retry shortly.
      throw AppError.conflict(
        'IDEMPOTENT_REQUEST_IN_FLIGHT',
        'Original request is still processing',
      );
    }
    return { kind: 'replay', status: existing.responseStatus, body: existing.responseBody };
  }
  // The key kept changing hands under us; never execute without a claim.
  throw new AppError('IDEMPOTENT_REQUEST_IN_FLIGHT', 'Original request is still processing', 409, {
    retryable: true,
  });
}

const ownClaim = (claim: IdempotencyClaim) =>
  and(
    eq(schema.idempotencyKeys.key, claim.storedKey),
    eq(schema.idempotencyKeys.createdAt, claim.claimedAt),
    sql`${schema.idempotencyKeys.responseStatus} is null`,
  );

/** A failed mutation releases its own claim so the client can retry. */
export async function releaseIdempotent(db: Db, claim: IdempotencyClaim): Promise<void> {
  await db.delete(schema.idempotencyKeys).where(ownClaim(claim));
}

/**
 * Marks this claim complete and says whether it did. Given a transaction, the
 * completion commits or rolls back with the mutation it describes — which is
 * the only arrangement in which "the key is complete" and "the mutation
 * happened" cannot disagree. `false` means the claim is gone (expired and
 * reclaimed, or purged); a caller inside a transaction must then roll back
 * rather than commit a mutation no record can replay.
 */
export async function completeIdempotentWithin(
  db: Db | Tx,
  claim: IdempotencyClaim,
  status: number,
  body: unknown,
): Promise<boolean> {
  const done = await db
    .update(schema.idempotencyKeys)
    .set({ responseStatus: status, responseBody: body ?? null })
    .where(ownClaim(claim))
    .returning({ key: schema.idempotencyKeys.key });
  return done.length === 1;
}

/**
 * api-contract rule: retryable mutations accept `Idempotency-Key`. Repeating
 * a request with the same key replays the original response instead of
 * re-applying the mutation; the same key with a different body is a 422.
 *
 * Scope: key is namespaced per actor + method+route, so keys can never
 * collide across users or endpoints. Rows expire after 24h (purged by the
 * privacy/retention job).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<FastifyRequest & { actor?: Actor }>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const clientKey = req.headers['idempotency-key'];

    if (!MUTATING.has(req.method) || typeof clientKey !== 'string') {
      return next.handle();
    }
    if (this.reflector.get<boolean | undefined>(MANUAL_IDEMPOTENCY_KEY, context.getHandler())) {
      return next.handle();
    }

    const scope = idempotencyScope(req, clientKey);

    return from(beginIdempotent(this.db, scope)).pipe(
      switchMap((begun) => {
        if (begun.kind === 'replay') {
          void reply.status(begun.status);
          reply.header('x-idempotent-replay', 'true');
          return of(begun.body);
        }
        const { claim } = begun;
        return next.handle().pipe(
          // Completed after the handler's own commit, as before #440: a lost
          // claim here cannot undo a mutation that already committed, so the
          // body is still returned. Routes that cannot accept that gap use
          // `ManualIdempotency` and complete inside their transaction.
          switchMap((body) =>
            from(
              completeIdempotentWithin(this.db, claim, this.statusFor(req.method, reply), body),
            ).pipe(switchMap(() => of(body))),
          ),
          // A failed mutation releases the key so the client can retry.
          catchError((err) =>
            from(releaseIdempotent(this.db, claim)).pipe(switchMap(() => throwError(() => err))),
          ),
        );
      }),
    );
  }

  /**
   * The status the reply actually carries. Nest applies the route's status
   * (201 for POST, 200 otherwise, or `@HttpCode`) before interceptors run, and
   * a handler may change it. Mapping a POST 200 to 201 replayed a deliberate
   * "already exists" 200, and an `@HttpCode(200)` POST, as a creation
   * (GoGo-BE#662 F-02). The method default is only a fallback for a reply that
   * somehow carries no status.
   */
  private statusFor(method: string, reply: FastifyReply): number {
    if (reply.statusCode) return reply.statusCode;
    return method === 'POST' ? 201 : 200;
  }
}

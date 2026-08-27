import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { catchError, from, of, switchMap, throwError, type Observable } from 'rxjs';
import { schema, type Db } from '@gogo/database';
import { AppError } from './app-error';
import { DB } from './tokens';
import type { Actor } from '../identity/domain/actor';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_TTL_HOURS = 24;
const KEY_PATTERN = /^[\w-]{8,128}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
  constructor(@Inject(DB) private readonly db: Db) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<FastifyRequest & { actor?: Actor }>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const clientKey = req.headers['idempotency-key'];

    if (!MUTATING.has(req.method) || typeof clientKey !== 'string') {
      return next.handle();
    }
    if (!KEY_PATTERN.test(clientKey)) {
      throw AppError.badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 chars', [
        { field: 'Idempotency-Key', code: 'invalid', message: 'expected [A-Za-z0-9_-]{8,128}' },
      ]);
    }

    const actorScope = req.actor ? `${req.actor.type}:${req.actor.id}` : `ip:${req.ip}`;
    const endpoint = `${req.method} ${req.routeOptions?.url ?? req.url}`;
    const storedKey = sha256(`${actorScope}|${endpoint}|${clientKey}`);
    const requestHash = sha256(JSON.stringify(req.body ?? null));

    return from(this.begin(storedKey, actorScope, endpoint, requestHash)).pipe(
      switchMap((replayed) => {
        if (replayed) {
          void reply.status(replayed.status);
          reply.header('x-idempotent-replay', 'true');
          return of(replayed.body);
        }
        return next.handle().pipe(
          switchMap((body) =>
            from(this.finish(storedKey, this.statusFor(req.method, reply), body)).pipe(
              switchMap(() => of(body)),
            ),
          ),
          // A failed mutation releases the key so the client can retry.
          catchError((err) =>
            from(this.release(storedKey)).pipe(switchMap(() => throwError(() => err))),
          ),
        );
      }),
    );
  }

  private statusFor(method: string, reply: FastifyReply): number {
    if (reply.statusCode && reply.statusCode !== 200) return reply.statusCode;
    return method === 'POST' ? 201 : 200;
  }

  /** Returns the stored response when this is a replay; null for first run. */
  private async begin(
    storedKey: string,
    actorScope: string,
    endpoint: string,
    requestHash: string,
  ): Promise<{ status: number; body: unknown } | null> {
    const inserted = await this.db
      .insert(schema.idempotencyKeys)
      .values({
        key: storedKey,
        actorId: actorScope,
        endpoint,
        requestHash,
        expiresAt: new Date(Date.now() + KEY_TTL_HOURS * 3600 * 1000),
      })
      .onConflictDoNothing()
      .returning({ key: schema.idempotencyKeys.key });
    if (inserted.length > 0) return null; // we own the key — first execution

    const [existing] = await this.db
      .select()
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.key, storedKey))
      .limit(1);
    if (!existing) return null; // raced with expiry purge — treat as first run
    if (existing.requestHash !== requestHash) {
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
    return { status: existing.responseStatus, body: existing.responseBody };
  }

  private async release(storedKey: string): Promise<void> {
    await this.db
      .delete(schema.idempotencyKeys)
      .where(
        and(
          eq(schema.idempotencyKeys.key, storedKey),
          sql`${schema.idempotencyKeys.responseStatus} is null`,
        ),
      );
  }

  private async finish(storedKey: string, status: number, body: unknown): Promise<void> {
    await this.db
      .update(schema.idempotencyKeys)
      .set({ responseStatus: status, responseBody: body ?? null })
      .where(
        and(
          eq(schema.idempotencyKeys.key, storedKey),
          sql`${schema.idempotencyKeys.responseStatus} is null`,
        ),
      );
  }
}

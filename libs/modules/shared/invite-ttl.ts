import type { MetricsPort } from '@gogo/observability';
import { sql } from 'drizzle-orm';
import { AppError } from './app-error';
import type { Tx } from './outbox';

export type InviteKind = 'token' | 'code6';
export type InviteTtlFailure = 'missing' | 'invalid' | 'db_error';
export const MAX_INVITE_TTL_SECONDS = 2147483647;

export function isInviteTtlSeconds(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_INVITE_TTL_SECONDS
  );
}

/** Fixed reason only: never retain a native driver error/SQL/credential. */
export class InviteTtlSettingUnavailable extends AppError {
  constructor(readonly reason: InviteTtlFailure) {
    super('INVITE_TTL_SETTING_UNAVAILABLE', 'Invite lifetime setting is unavailable', 503, {
      retryable: reason === 'db_error',
    });
  }
}

/** Raised only by the setting reader, before the issuing transaction writes. */
export class InviteTtlReadUnavailable extends InviteTtlSettingUnavailable {}

/** Caller already holds/revalidated the room FOR UPDATE; no cache or own connection. */
export async function readInviteTtlWithin(tx: Tx, consumer: InviteKind, metrics: MetricsPort) {
  try {
    const setting = await tx.execute<{ ttl_seconds: unknown }>(
      sql`select ttl_seconds from room_invite_settings where id=1 for share`,
    );
    if (!setting.rows[0]) throw new InviteTtlReadUnavailable('missing');
    const ttlSeconds = setting.rows[0].ttl_seconds;
    if (!isInviteTtlSeconds(ttlSeconds)) throw new InviteTtlReadUnavailable('invalid');
    // Separate statement: this clock MUST run after waiting for the SHARE lock.
    const clock = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    const issuedAt = new Date(clock.rows[0]!.now);
    if (!Number.isFinite(issuedAt.getTime())) throw new InviteTtlReadUnavailable('db_error');
    metrics.increment('room_invite_ttl_read_total', { consumer, result: 'ok' });
    return { ttlSeconds, issuedAt };
  } catch (error) {
    const failure =
      error instanceof InviteTtlSettingUnavailable
        ? error
        : new InviteTtlReadUnavailable('db_error');
    metrics.increment('room_invite_ttl_read_total', { consumer, result: failure.reason });
    throw failure;
  }
}

/** Wrap the OUTERMOST transaction, including share/completion/audit writes, never an insert. */
export async function observeInviteIssuance<T>(
  metrics: MetricsPort,
  kind: InviteKind,
  transaction: () => Promise<T>,
): Promise<T> {
  try {
    const result = await transaction();
    metrics.increment('room_invite_issue_total', { kind, result: 'committed' });
    return result;
  } catch (error) {
    metrics.increment('room_invite_issue_total', { kind, result: 'rolled_back' });
    if (isTransientInviteStorageError(error)) throw new InviteTtlSettingUnavailable('db_error');
    throw error;
  }
}

export function isTransientInviteStorageError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; message?: unknown; cause?: unknown };
  return (
    Boolean(
      e.code &&
      (/^08/.test(e.code) ||
        [
          '55P03',
          '57014',
          '53300',
          '57P01',
          '57P02',
          '57P03',
          'ECONNRESET',
          'ECONNREFUSED',
          'ETIMEDOUT',
          'EPIPE',
          'EHOSTUNREACH',
          'ENETUNREACH',
        ].includes(e.code)),
    ) ||
    (typeof e.message === 'string' &&
      /^(timeout exceeded when trying to connect|connection terminated due to connection timeout|connection terminated unexpectedly|query read timeout)$/i.test(
        e.message,
      )) ||
    isTransientInviteStorageError(e.cause)
  );
}

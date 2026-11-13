import { Inject, Injectable } from '@nestjs/common';
import { METRICS, type MetricsPort } from '@gogo/observability';
import type { Db } from '@gogo/database';
import { sql } from 'drizzle-orm';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import {
  beginIdempotent,
  completeIdempotentWithin,
  releaseIdempotent,
  type IdempotencyScope,
  type IdempotencyClaim,
} from '../../shared/idempotency.interceptor';
import {
  InviteTtlSettingUnavailable,
  isInviteTtlSeconds,
  isTransientInviteStorageError,
  MAX_INVITE_TTL_SECONDS,
} from '../../shared/invite-ttl';
import { DB } from '../../shared/tokens';
import type { components } from '../../../../openapi/gogo.v1';

export type CmsRoomInviteSettings = components['schemas']['CmsRoomInviteSettings'];

type SettingRow = {
  ttl_seconds: unknown;
  version: string;
  updated_at: Date | string;
  updated_by_admin_id: string | null;
};

function toDto(row: SettingRow | undefined): CmsRoomInviteSettings {
  if (!row) throw new InviteTtlSettingUnavailable('missing');
  if (!isInviteTtlSeconds(row.ttl_seconds) || !/^[1-9]\d*$/.test(row.version))
    throw new InviteTtlSettingUnavailable('invalid');
  const updatedAt = new Date(row.updated_at);
  if (!Number.isFinite(updatedAt.getTime())) throw new InviteTtlSettingUnavailable('invalid');
  return {
    ttlSeconds: row.ttl_seconds,
    version: row.version,
    etag: `"room-invite-ttl-v1-r${row.version}"`,
    updatedAt: updatedAt.toISOString(),
    updatedByAdminId: row.updated_by_admin_id,
    minTtlSeconds: 1,
    maxTtlSeconds: MAX_INVITE_TTL_SECONDS,
    codeMaxTtlSeconds: 172800,
  };
}

async function readSetting(db: Pick<Db, 'execute'>, lock = false) {
  try {
    const result = await db.execute<SettingRow>(sql`
      select ttl_seconds, version::text, updated_at, updated_by_admin_id
      from room_invite_settings where id=1 ${lock ? sql`for update` : sql``}
    `);
    return toDto(result.rows[0]);
  } catch (error) {
    if (error instanceof InviteTtlSettingUnavailable) throw error;
    throw new InviteTtlSettingUnavailable('db_error');
  }
}

@Injectable()
export class CmsRoomInviteSettingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  async read(): Promise<CmsRoomInviteSettings> {
    return readSetting(this.db);
  }

  async update(
    adminId: string,
    ttlSeconds: number,
    ifMatch: string,
    scope: IdempotencyScope,
  ): Promise<{ body: CmsRoomInviteSettings; replayed: boolean }> {
    let claim: IdempotencyClaim | undefined;
    try {
      const begun = await beginIdempotent(this.db, scope);
      if (begun.kind === 'replay') {
        this.recordOutcome('replayed');
        return { body: begun.body as CmsRoomInviteSettings, replayed: true };
      }
      claim = begun.claim;
      const result = await this.db.transaction(
        async (tx) => {
          const before = await readSetting(tx, true);
          if (before.etag !== ifMatch)
            throw new AppError('PRECONDITION_FAILED', 'Invite lifetime setting changed', 412);
          const changed = before.ttlSeconds !== ttlSeconds;
          let after = before;
          if (changed) {
            // Separate statement takes the DB clock after the singleton lock wait.
            const clock = await tx.execute<{ now: Date | string }>(
              sql`select clock_timestamp() as now`,
            );
            const occurredAt = new Date(clock.rows[0]!.now);
            const updated = await tx.execute<SettingRow>(sql`
              update room_invite_settings
              set ttl_seconds=${ttlSeconds}, version=version+1,
                  updated_at=${occurredAt}, updated_by_admin_id=${adminId}::uuid
              where id=1
              returning ttl_seconds,version::text,updated_at,updated_by_admin_id
            `);
            after = toDto(updated.rows[0]);
            await writeAudit(tx, {
              actorType: 'admin',
              actorId: adminId,
              action: 'room_invite_ttl.updated',
              resourceType: 'room_invite_ttl',
              resourceId: 'global',
              occurredAt,
              diff: {
                before: { ttlSeconds: before.ttlSeconds, version: before.version },
                after: { ttlSeconds: after.ttlSeconds, version: after.version },
              },
            });
          }
          if (!(await completeIdempotentWithin(tx, begun.claim, 200, after)))
            throw new AppError(
              'IDEMPOTENT_REQUEST_IN_FLIGHT',
              'Original request is processing',
              409,
              { retryable: true },
            );
          return { body: after, changed };
        },
        { isolationLevel: 'read committed' },
      );
      this.recordOutcome(result.changed ? 'changed' : 'noop');
      return { body: result.body, replayed: false };
    } catch (error) {
      if (claim) await releaseIdempotent(this.db, claim).catch(() => undefined);
      this.recordOutcome(
        error instanceof AppError && [412, 409, 422].includes(error.httpStatus)
          ? 'conflict'
          : 'error',
      );
      if (isTransientInviteStorageError(error)) throw new InviteTtlSettingUnavailable('db_error');
      // The shared helper's in-flight response predates retryable metadata.
      if (error instanceof AppError && error.code === 'IDEMPOTENT_REQUEST_IN_FLIGHT')
        throw new AppError(error.code, error.message, 409, { retryable: true });
      throw error;
    }
  }

  private recordOutcome(result: 'changed' | 'noop' | 'replayed' | 'conflict' | 'error') {
    this.metrics.increment('cms_room_invite_ttl_update_total', { result });
  }
}

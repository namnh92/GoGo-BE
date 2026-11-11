import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import type { Actor } from '../../identity/domain/actor';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type PlatformConfig } from '../../shared/config';
import { flagEnvironmentOf, resolveBooleanFlag } from '../../shared/feature-flags';
import { DB } from '../../shared/tokens';
import {
  creditEntryFacts,
  decodeCreditCursor,
  encodeCreditCursor,
} from '../domain/credit-visibility';
import { AssistantCreditRepository } from '../infrastructure/assistant-credit.repository';

function integer(value: string | number | bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw AppError.internal('Credit total is outside the supported range');
  return result;
}

@Injectable()
export class AssistantCreditsService {
  constructor(
    private readonly repo: AssistantCreditRepository,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: PlatformConfig,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  private async subject(actor: Actor): Promise<string> {
    if (actor.type !== 'user') throw AppError.forbidden('USER_ONLY', 'Registered account required');
    if (
      !(await resolveBooleanFlag(this.db, 'assistant_credits.display_enabled', {
        environment: flagEnvironmentOf(this.config.APP_ENV),
      }))
    )
      throw AppError.notFound('CREDITS_DISPLAY_DISABLED', 'Credit visibility is unavailable');
    return actor.id;
  }

  async summary(actor: Actor) {
    const userId = await this.subject(actor);
    const row = await this.repo.summary(userId);
    if (!row) throw AppError.unauthorized('ACCOUNT_UNAVAILABLE', 'Account is not available');
    if (BigInt(row.balance) !== BigInt(row.earned) - BigInt(row.spent)) {
      this.metrics.increment('assistant_credit_account_mismatch_total');
    }
    if (BigInt(row.reserved) > BigInt(row.balance))
      throw AppError.internal('Credit hold invariant violation');
    return {
      balance: integer(row.balance),
      earned: integer(row.earned),
      spent: integer(row.spent),
      reserved: integer(row.reserved),
      availableBalance: integer(BigInt(row.balance) - BigInt(row.reserved)),
      asOf: row.as_of,
      policyKey: row.policy_key,
    };
  }

  async history(actor: Actor, query: { cursor?: string | undefined }) {
    const userId = await this.subject(actor);
    const rows = await this.repo.history(userId, decodeCreditCursor(query.cursor, userId));
    if (!rows.length)
      throw AppError.unauthorized('ACCOUNT_UNAVAILABLE', 'Account is not available');
    const ledger = rows.filter((row) => row.id !== null);
    const page = ledger.slice(0, 10);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id!,
        createdAt: row.created_at!,
        delta: row.delta!,
        ...creditEntryFacts(row.reason!, row.delta!, row.usage_linked === true),
        ...(row.event_id ? { eventId: row.event_id } : {}),
      })),
      nextCursor:
        ledger.length > 10 && last
          ? encodeCreditCursor(userId, { at: last.created_at!, id: last.id! })
          : null,
    };
  }
}

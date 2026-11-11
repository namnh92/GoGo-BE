import { verifiedCreditBound } from '../../shared/assistant-credit-bound';
import {
  AssistantCreditSpendRepository,
  type SpendControl,
  type FundingSnapshot,
} from '../infrastructure/assistant-credit-spend.repository';
import { reserveCredits } from '../domain/credit-cost';
import { creditBalance } from '../../shared/assistant-credits';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG } from '../../shared/config';
import { flagEnvironmentOf, resolveBooleanFlag } from '../../shared/feature-flags';
import { DB } from '../../shared/tokens';
import type { Tx } from '../../shared/outbox';
import {
  BURST_WINDOW_MS,
  decideAllowance,
  utcMonthStart,
  vnDayStart,
  vnNextReset,
  type AssistantLimits,
} from '../domain/limits';
import { AssistantRepository } from '../infrastructure/assistant.repository';
import type { AssistantConfig } from './assistant.config';

export type Readiness =
  | { ok: true; limits: AssistantLimits; monthlyBudgetUsd: number }
  | { ok: false; reason: 'kill_switch' | 'unconfigured' | 'budget_exhausted' | 'byok_unverified' };

/** After an `is_byok: false` Haiku answer, sends refuse this long (ADR-0036 §5). */
export const BYOK_QUARANTINE_MS = 10 * 60 * 1000;

/** What `readiness` needs to also run inside the send transaction. */
type Exec = Pick<Db, 'execute'>;

/**
 * GoGo-BE#713 — whether the assistant may take a new message, and how much of
 * the account's allowance is left. The status endpoint is a hint for the UI;
 * every send is checked again here. An unconfigured limit, budget or key
 * refuses — none of them ever means unlimited.
 */
@Injectable()
export class AssistantAvailabilityService {
  /** This process saw it first; the ledger tells every other replica. */
  private byokViolationAt: number | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AssistantConfig,
    private readonly repo: AssistantRepository,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
    @Optional()
    private readonly spend: AssistantCreditSpendRepository = new AssistantCreditSpendRepository(db),
  ) {}

  /**
   * `exec` is the caller's connection: inside the send transaction the flag is
   * read on the connection that holds the budget lock, never on a second pooled
   * one (A-R2-01: under load that second acquire starves the pool).
   */
  killSwitchOn(exec: Exec = this.db): Promise<boolean> {
    return resolveBooleanFlag(exec, 'assistant.enabled', {
      environment: flagEnvironmentOf(this.config.APP_ENV),
    });
  }

  /** The configured limits, or null when any of them is missing. */
  limits(): AssistantLimits | null {
    const daily = this.config.ASSISTANT_USER_DAILY_MAX_MESSAGES;
    const perMinute = this.config.ASSISTANT_USER_PER_MINUTE_MAX_MESSAGES;
    if (daily === undefined) return null;
    return { dailyMessageLimit: daily, messagesPerMinuteLimit: perMinute };
  }

  /** Haiku answered from OpenRouter shared credits instead of the BYOK key. */
  async recordByokViolation(ledgerId: string): Promise<void> {
    this.byokViolationAt = Date.now();
    await this.repo.markByokViolation(ledgerId);
  }

  private async byokQuarantined(exec: Exec, now: Date): Promise<boolean> {
    if (this.byokViolationAt !== null && now.getTime() - this.byokViolationAt < BYOK_QUARANTINE_MS)
      return true;
    // The ledger row is dated by its acceptance, which precedes the violation
    // by at most one reply: the window is widened by that much.
    const since = new Date(now.getTime() - BYOK_QUARANTINE_MS - this.config.ASSISTANT_REPLY_MAX_MS);
    return this.repo.byokViolationSince(exec, since);
  }

  async readiness(exec: Exec = this.db, now = new Date()): Promise<Readiness> {
    if (!(await this.killSwitchOn(exec))) return { ok: false, reason: 'kill_switch' };
    const limits = this.limits();
    const budget = this.config.ASSISTANT_MONTHLY_MAX_USD;
    // Both models' keys (GoGo-BE#731): Haiku's BYOK key and Jev's own key.
    const keys = this.config.OPENROUTER_ASSISTANT_API_KEY && this.config.OPENROUTER_API_KEY;
    if (!limits || budget === undefined || !keys) {
      return { ok: false, reason: 'unconfigured' };
    }
    if (await this.byokQuarantined(exec, now)) return { ok: false, reason: 'byok_unverified' };
    const spent = await this.repo.monthSpendUsd(
      exec,
      utcMonthStart(now),
      this.config.ASSISTANT_TURN_COST_CEILING_USD,
    );
    // The next turn must fit under the ceiling at its worst case.
    if (spent + this.config.ASSISTANT_TURN_COST_CEILING_USD > budget) {
      return { ok: false, reason: 'budget_exhausted' };
    }
    return { ok: true, limits, monthlyBudgetUsd: budget };
  }

  /**
   * Throws the contract's 503 for a send the environment cannot take. The send
   * calls it again inside its transaction under the budget lock (A-R-01), so
   * the check and the reservation cannot be split by another send.
   */
  async requireReady(exec: Exec = this.db, now = new Date()): Promise<AssistantLimits> {
    const r = await this.readiness(exec, now);
    if (!r.ok) {
      this.metrics.increment('assistant_admission_total', { outcome: r.reason });
      throw AppError.serviceUnavailable('ASSISTANT_DISABLED', 'Assistant is disabled', false);
    }
    return r.limits;
  }

  /** Inside the send transaction, under the account lock. */
  async requireAllowance(
    tx: Tx,
    userId: string,
    limits: AssistantLimits,
    now = new Date(),
  ): Promise<'daily' | 'credit'> {
    const usage = await this.repo.allowanceUsage(
      tx,
      userId,
      vnDayStart(now),
      new Date(now.getTime() - BURST_WINDOW_MS),
    );
    const decision = decideAllowance(
      limits,
      { acceptedToday: usage.acceptedToday, burstAcceptedAt: usage.burst },
      now,
    );
    if (decision.ok) return 'daily';
    if (decision.code === 'ASSISTANT_DAILY_LIMIT') {
      if ((await creditBalance(tx, userId)) > 0) return 'credit';
      this.metrics.increment('assistant_admission_total', { outcome: 'daily_limit' });
      throw new AppError('ASSISTANT_DAILY_LIMIT', 'Daily assistant message limit reached', 429, {
        retryable: false,
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
    this.metrics.increment('assistant_admission_total', { outcome: 'rate_limited' });
    throw AppError.tooManyRequests(
      'Too many assistant messages; slow down',
      decision.retryAfterSeconds,
    );
  }

  /** Binding must be installed by an audited D2 readiness operation. D1 never binds it. */
  async paidReadiness(exec: Exec, facts: FundingSnapshot): Promise<number | null> {
    const bound = this.config.ASSISTANT_CREDIT_BOUND_USD;
    const version = this.config.ASSISTANT_CREDIT_BOUND_VERSION;
    if (
      facts.policy_key !== 'free_then_actual_cost_v1' ||
      facts.quarantined ||
      !bound ||
      !version ||
      facts.bound_version !== version
    )
      return null;
    for (const key of [
      'assistant_credits.spend_enabled',
      'assistant_credits.settlement_enabled',
    ] as const) {
      if (
        !(await resolveBooleanFlag(exec, key, {
          environment: flagEnvironmentOf(this.config.APP_ENV),
        }))
      )
        return null;
    }
    try {
      if (!(await verifiedCreditBound(exec, this.config))) return null;
      return reserveCredits(bound);
    } catch {
      return null;
    }
  }

  async funding(tx: Tx, userId: string, limits: AssistantLimits, now: Date, control: SpendControl) {
    // Both the active subject and money facts are re-read after all admission locks.
    const facts = await this.spend.snapshot(tx, userId, vnDayStart(now));
    if (facts.policy_key !== control.policy_key || facts.epoch !== control.epoch)
      throw AppError.serviceUnavailable('ASSISTANT_DISABLED', 'Spend policy changed', false);
    if (control.policy_key === 'legacy_allowance_v1') {
      return {
        allowanceSource: await this.requireAllowance(tx, userId, limits, now),
        required: 0,
        boundVersion: null,
      };
    }
    const usage = await this.repo.allowanceUsage(
      tx,
      userId,
      vnDayStart(now),
      new Date(now.getTime() - BURST_WINDOW_MS),
    );
    const decision = decideAllowance(
      limits,
      { acceptedToday: facts.accepted_today, burstAcceptedAt: usage.burst },
      now,
    );
    if (!decision.ok && decision.code === 'RATE_LIMITED')
      throw AppError.tooManyRequests(
        'Too many assistant messages; slow down',
        decision.retryAfterSeconds,
      );
    if (decision.ok) return { allowanceSource: 'daily' as const, required: 0, boundVersion: null };
    const required = await this.paidReadiness(tx, facts);
    if (required === null)
      throw AppError.serviceUnavailable(
        'ASSISTANT_DISABLED',
        'Paid assistant sending is unavailable',
        false,
      );
    const reserved = Number(BigInt(facts.reserved));
    const available = Number(BigInt(facts.balance) - BigInt(facts.reserved));
    if (!Number.isSafeInteger(reserved) || available < 0)
      throw AppError.serviceUnavailable('ASSISTANT_DISABLED', 'Credit funding unavailable', false);
    if (available < required)
      throw new AppError('ASSISTANT_INSUFFICIENT_CREDIT', 'Insufficient assistant credit', 409, {
        retryable: false,
        details: {
          creditBalance: facts.balance,
          creditReserved: reserved,
          creditAvailable: available,
          requiredCredits: required,
          remainingToday: 0,
          resetsAt: vnNextReset(now).toISOString(),
        },
      });
    return { allowanceSource: 'credit' as const, required, boundVersion: control.bound_version };
  }

  async status(userId: string, now = new Date()) {
    return this.db.transaction(
      async (tx) => {
        const facts = await this.spend.snapshot(tx, userId, vnDayStart(now));
        const limits = this.limits();
        const readiness = await this.readiness(tx, now);
        const paidCreditsRequired = await this.paidReadiness(tx, facts);
        const reserved = Number(BigInt(facts.reserved));
        const available = Number(BigInt(facts.balance) - BigInt(facts.reserved));
        if (!Number.isSafeInteger(reserved) || available < 0)
          throw AppError.serviceUnavailable(
            'ASSISTANT_DISABLED',
            'Credit funding unavailable',
            false,
          );
        const remainingToday = Math.max(0, (limits?.dailyMessageLimit ?? 0) - facts.accepted_today);
        return {
          state: !readiness.ok
            ? 'disabled'
            : remainingToday > 0
              ? 'enabled'
              : facts.policy_key === 'legacy_allowance_v1'
                ? facts.balance > 0
                  ? 'enabled'
                  : 'limit_reached'
                : paidCreditsRequired === null
                  ? 'disabled'
                  : available < paidCreditsRequired
                    ? 'insufficient_credit'
                    : 'enabled',
          creditBalance: facts.balance,
          creditReserved: reserved,
          creditAvailable: available,
          creditPolicy: facts.policy_key,
          paidCreditsRequired,
          paidSendEnabled: paidCreditsRequired !== null,
          asOf: facts.as_of,
          dailyMessageLimit: limits?.dailyMessageLimit ?? 0,
          remainingToday,
          resetsAt: vnNextReset(now).toISOString(),
          messagesPerMinuteLimit: limits?.messagesPerMinuteLimit ?? 0,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}

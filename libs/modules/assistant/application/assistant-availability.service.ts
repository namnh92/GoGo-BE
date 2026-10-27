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

/**
 * GoGo-BE#713 — whether the assistant may take a new message, and how much of
 * the account's allowance is left. The status endpoint is a hint for the UI;
 * every send is checked again here. An unconfigured limit, budget or key
 * refuses — none of them ever means unlimited.
 */
@Injectable()
export class AssistantAvailabilityService {
  private byokViolationAt: number | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AssistantConfig,
    private readonly repo: AssistantRepository,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  killSwitchOn(): Promise<boolean> {
    return resolveBooleanFlag(this.db, 'assistant.enabled', {
      environment: flagEnvironmentOf(this.config.APP_ENV),
    });
  }

  /** The configured limits, or null when any of them is missing. */
  limits(): AssistantLimits | null {
    const daily = this.config.ASSISTANT_DAILY_MESSAGE_LIMIT;
    const perMinute = this.config.ASSISTANT_MESSAGES_PER_MINUTE_LIMIT;
    if (daily === undefined || perMinute === undefined) return null;
    return { dailyMessageLimit: daily, messagesPerMinuteLimit: perMinute };
  }

  /** Haiku answered from OpenRouter shared credits instead of the BYOK key. */
  recordByokViolation(): void {
    this.byokViolationAt = Date.now();
  }

  private byokQuarantined(): boolean {
    return this.byokViolationAt !== null && Date.now() - this.byokViolationAt < BYOK_QUARANTINE_MS;
  }

  async readiness(exec: Pick<Db, 'execute'> = this.db, now = new Date()): Promise<Readiness> {
    if (!(await this.killSwitchOn())) return { ok: false, reason: 'kill_switch' };
    const limits = this.limits();
    const budget = this.config.ASSISTANT_MONTHLY_BUDGET_USD;
    if (!limits || budget === undefined || !this.config.OPENROUTER_API_KEY) {
      return { ok: false, reason: 'unconfigured' };
    }
    if (this.byokQuarantined()) return { ok: false, reason: 'byok_unverified' };
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

  /** Throws the contract's 503 for a send the environment cannot take. */
  async requireReady(exec: Pick<Db, 'execute'> = this.db): Promise<AssistantLimits> {
    const r = await this.readiness(exec);
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
  ): Promise<void> {
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
    if (decision.ok) return;
    if (decision.code === 'ASSISTANT_DAILY_LIMIT') {
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

  async status(userId: string, now = new Date()) {
    const resetsAt = vnNextReset(now).toISOString();
    const limits = this.limits();
    const readiness = await this.readiness(this.db, now);
    if (!limits) {
      return {
        state: 'disabled',
        dailyMessageLimit: 0,
        remainingToday: 0,
        resetsAt,
        messagesPerMinuteLimit: 0,
      };
    }
    const usage = await this.repo.allowanceUsage(
      this.db,
      userId,
      vnDayStart(now),
      new Date(now.getTime() - BURST_WINDOW_MS),
    );
    const remainingToday = Math.max(0, limits.dailyMessageLimit - usage.acceptedToday);
    return {
      state: !readiness.ok ? 'disabled' : remainingToday === 0 ? 'limit_reached' : 'enabled',
      dailyMessageLimit: limits.dailyMessageLimit,
      remainingToday,
      resetsAt,
      messagesPerMinuteLimit: limits.messagesPerMinuteLimit,
    };
  }
}

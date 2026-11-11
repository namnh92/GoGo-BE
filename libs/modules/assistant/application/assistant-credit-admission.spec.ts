import {
  billingConfiguration,
  billingConfigurationHash,
} from '../../shared/assistant-credit-bound';
import type { AssistantConfig } from './assistant.config';
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AssistantAvailabilityService } from './assistant-availability.service';
import type { FundingSnapshot } from '../infrastructure/assistant-credit-spend.repository';
const now = new Date('2026-11-11T16:59:59Z');
const control = {
  policy_key: 'free_then_actual_cost_v1' as const,
  epoch: '1',
  bound_version: 'verified-test-artifact',
};
const dialect = new PgDialect();
function harness(
  input: Partial<FundingSnapshot> = {},
  flags: Record<string, boolean> = {},
  config: Record<string, unknown> = {},
) {
  const facts: FundingSnapshot = {
    ...control,
    balance: 0,
    reserved: '0',
    accepted_today: 0,
    as_of: now.toISOString(),
    quarantined: false,
    ...input,
  };
  const boundConfig = {
    APP_ENV: 'dev',
    ASSISTANT_CREDIT_BOUND_USD: '0.00012',
    ASSISTANT_CREDIT_BOUND_VERSION: 'verified-test-artifact',
    ASSISTANT_CREDIT_PRICING_REVISION: 'test-only-pricing',
    ...config,
  } as AssistantConfig;
  const execute = vi.fn(async (q) => {
    if (dialect.sqlToQuery(q).sql.includes('from assistant_credit_bound_artifacts'))
      return {
        rows: [
          {
            description: {
              schemaVersion: 1,
              configurationHash: billingConfigurationHash(boundConfig),
              configuration: billingConfiguration(boundConfig),
              pricingRevision: boundConfig.ASSISTANT_CREDIT_PRICING_REVISION,
              boundProofSha256: 'a'.repeat(64),
              finalityProofSha256: 'b'.repeat(64),
              coverage: {
                allAttempts: true,
                retries: true,
                parallelCalls: true,
                timeoutAbortBillability: true,
                maximumFees: true,
              },
            },
          },
        ],
      };
    const key = dialect.sqlToQuery(q).params[0] as string;
    return {
      rows:
        key in flags
          ? [{ environment: 'dev', platform: 'all', enabled: flags[key], payload: null }]
          : [],
    };
  });
  const repo = {
    allowanceUsage: vi.fn(async () => ({
      acceptedToday: facts.accepted_today,
      burst: [] as Date[],
    })),
  };
  const spend = { snapshot: vi.fn(async () => facts) };
  const service = new AssistantAvailabilityService(
    { execute } as never,
    boundConfig,
    repo as never,
    undefined,
    spend as never,
  );
  const funding = () =>
    service.funding(
      { execute } as never,
      'user',
      { dailyMessageLimit: 5, messagesPerMinuteLimit: 10 },
      now,
      control,
    );
  return { facts, repo, service, execute, funding };
}
describe('#851 D01/D04 free-first configured funding', () => {
  it.each([0, 50])(
    'five free slots regardless of %i balance or paid readiness',
    async (balance) => {
      const h = harness({ balance, accepted_today: 4, bound_version: null });
      expect(await h.funding()).toEqual({
        allowanceSource: 'daily',
        required: 0,
        boundVersion: null,
      });
      expect(h.execute).not.toHaveBeenCalled();
    },
  );
  it('exhaustion never falls back to legacy -1 or free when bound is unbound', async () => {
    const h = harness(
      { balance: 100, accepted_today: 5, bound_version: null },
      { 'assistant_credits.spend_enabled': true },
    );
    await expect(h.funding()).rejects.toMatchObject({
      code: 'ASSISTANT_DISABLED',
      httpStatus: 503,
      options: { retryable: false },
    });
  });
  it.each([
    [{}, {}],
    [
      { 'assistant_credits.spend_enabled': true, 'assistant_credits.settlement_enabled': false },
      {},
    ],
    [{ 'assistant_credits.spend_enabled': true }, { ASSISTANT_CREDIT_BOUND_USD: undefined }],
    [{ 'assistant_credits.spend_enabled': true }, { ASSISTANT_CREDIT_BOUND_VERSION: 'drift' }],
  ])(
    'missing flag/bound/version or paused settlement refuses paid admission',
    async (flags, config) => {
      await expect(
        harness({ balance: 100, accepted_today: 5 }, flags, config).funding(),
      ).rejects.toMatchObject({ code: 'ASSISTANT_DISABLED' });
    },
  );
  it('quarantine blocks new paid reservations', async () => {
    await expect(
      harness(
        { balance: 100, accepted_today: 5, quarantined: true },
        { 'assistant_credits.spend_enabled': true },
      ).funding(),
    ).rejects.toMatchObject({ code: 'ASSISTANT_DISABLED' });
  });
  it('R-1 refuses typed 409 using available, R succeeds', async () => {
    const h = harness(
      { balance: 20, reserved: '9', accepted_today: 5 },
      { 'assistant_credits.spend_enabled': true },
    );
    await expect(h.funding()).rejects.toMatchObject({
      code: 'ASSISTANT_INSUFFICIENT_CREDIT',
      httpStatus: 409,
      options: {
        retryable: false,
        details: {
          creditBalance: 20,
          creditReserved: 9,
          creditAvailable: 11,
          requiredCredits: 12,
          remainingToday: 0,
          resetsAt: '2026-11-11T17:00:00.000Z',
        },
      },
    });
    h.facts.reserved = '8';
    expect(await h.funding()).toMatchObject({ allowanceSource: 'credit', required: 12 });
  });
  it('burst still applies to genuine free allowance', async () => {
    const h = harness();
    h.repo.allowanceUsage.mockResolvedValueOnce({ acceptedToday: 0, burst: Array(10).fill(now) });
    await expect(h.funding()).rejects.toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429 });
  });
});

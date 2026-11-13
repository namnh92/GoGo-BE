import { describe, it, expect, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  billingConfiguration,
  billingConfigurationHash,
  validBoundDescription,
  verifiedCreditBound,
} from './assistant-credit-bound';
import type { AssistantConfig } from '../assistant/application/assistant.config';
const config = {
  APP_ENV: 'dev',
  ASSISTANT_JEV_MODEL: 'fixture/jev-v1',
  ASSISTANT_HAIKU_MODEL: 'fixture/haiku-v1',
  ASSISTANT_MAX_OUTPUT_TOKENS: 800,
  ASSISTANT_CREDIT_PRICING_REVISION: 'fixture-prices-v1',
  ASSISTANT_CREDIT_BOUND_USD: '0.0002',
  ASSISTANT_CREDIT_BOUND_VERSION: 'fixture-proof-v1',
} as AssistantConfig;
export function testBoundDescription(c: AssistantConfig) {
  return {
    schemaVersion: 1,
    configurationHash: billingConfigurationHash(c),
    configuration: billingConfiguration(c),
    pricingRevision: c.ASSISTANT_CREDIT_PRICING_REVISION,
    boundProofSha256: 'a'.repeat(64),
    finalityProofSha256: 'b'.repeat(64),
    coverage: {
      allAttempts: true,
      retries: true,
      parallelCalls: true,
      timeoutAbortBillability: true,
      maximumFees: true,
    },
  };
}
describe('#853 D08 billing artifact readiness', () => {
  it('calibration and a configured number alone fail', async () => {
    const execute = vi.fn(async (_q: SQL) => ({ rows: [] }));
    expect(
      await verifiedCreditBound({ execute } as never, {
        ...config,
        ASSISTANT_TURN_COST_CEILING_USD: 0.003904,
      }),
    ).toBe(false);
    expect(validBoundDescription({ calibratedCeiling: 0.003904 }, config)).toBe(false);
  });
  it('requires the live configuration and complete evidence description', () => {
    const d = testBoundDescription(config);
    expect(validBoundDescription(d, config)).toBe(true);
    for (const change of [
      { ASSISTANT_JEV_MODEL: 'drift/model' },
      { ASSISTANT_MAX_OUTPUT_TOKENS: 801 },
      { ASSISTANT_CREDIT_PRICING_REVISION: 'price-drift' },
    ])
      expect(validBoundDescription(d, { ...config, ...change })).toBe(false);
    expect(
      validBoundDescription(
        { ...d, coverage: { ...d.coverage, timeoutAbortBillability: false } },
        config,
      ),
    ).toBe(false);
    expect(validBoundDescription({ ...d, finalityProofSha256: '' }, config)).toBe(false);
  });
  it('missing, expired, revoked or foreign artifact fails; lookup is bound/environment/time scoped', async () => {
    const execute = vi.fn(async (_q: SQL) => ({ rows: [] }));
    expect(await verifiedCreditBound({ execute } as never, config)).toBe(false);
    const q = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(q.sql).toContain('expires_at>now()');
    expect(q.sql).toContain('revoked_at is null');
    expect(q.params).toEqual(['fixture-proof-v1', 'dev', '0.0002']);
  });
});

it('#905 fingerprints every byte/subfield cap and per-turn topology', () => {
  const configuration = billingConfiguration(config);
  expect(configuration.revision).toBe('assistant-905-request-bytes-v2');
  expect(configuration).toMatchObject({
    maxJevDecisionBytes: 32768,
    maxJevRelevanceBytes: 16384,
    maxHaikuRequestBytes: 49152,
    maxJevDecisionCallsPerTurn: 2,
    maxJevRelevanceCallsPerTurn: 1,
    maxHaikuCallsPerTurn: 1,
    maxIntentRequestBytes: 24576,
    maxResolvedBytes: 4096,
    maxRelevanceCandidates: 6,
    maxRelevanceDescriptionBytes: 1024,
    maxGroundingConstraintBytes: 4096,
    maxGroundingLabelBytes: 1024,
    maxGroundingPlaces: 3,
    maxGroundingGuideSections: 3,
  });
  const description = testBoundDescription(config);
  for (const key of Object.keys(configuration).filter((k) => k.startsWith('max'))) {
    const changed = { ...description, configuration: { ...description.configuration, [key]: -1 } };
    expect(validBoundDescription(changed, config), key).toBe(false);
  }
});

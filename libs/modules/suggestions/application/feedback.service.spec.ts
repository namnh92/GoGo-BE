import { describe, expect, it } from 'vitest';
import { ProviderQuotaExceededError, type FeedbackParserPort } from '@gogo/providers';
import { FeedbackService } from './feedback.service';
import type { FeedbackContext } from '../domain/feedback';

const context: FeedbackContext = {
  allowedPlaceIds: ['11111111-1111-4111-8111-111111111111'],
  knownCategoryKeys: ['cafe', 'bar'],
  knownDietaryKeys: ['vegetarian'],
  budgetAmount: 400_000,
  radiusM: 5000,
  currentStopCount: 4,
};

const input = {
  text: 'rẻ hơn và yên tĩnh hơn',
  allowedPlaceIds: context.allowedPlaceIds,
  facts: {
    budgetMode: 'per_person' as const,
    budgetAmount: 400_000,
    currency: 'VND',
    categoryKeys: ['cafe', 'bar'],
  },
};

const audit = { planId: 'p', roomId: 'r' };

/** Records what was audited without needing a database. */
function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        rows.push(v);
      },
    }),
  };
}

const parser = (impl: Partial<FeedbackParserPort>): FeedbackParserPort => ({
  modelVersion: 'test-model-v1',
  parse: async () => ({}),
  ...impl,
});

/**
 * SG-009 (#48) — acceptance is "provider failure falls back deterministically".
 * Every failure mode a provider has is one of these.
 */
describe('FeedbackService', () => {
  it('uses the deterministic parser when AI is switched off', async () => {
    const db = fakeDb();
    const service = new FeedbackService(db as never, undefined, false);
    const result = await service.interpret(input, context, audit);

    expect(result.outcome).toBe('disabled');
    expect(result.understood).toBe(true);
    expect(result.applied.budgetMaxAmount).toBe(300_000);
    // "yên tĩnh hơn" — bar is a known category here, so avoiding it lands.
    expect(result.applied.avoidCategoryKeys).toContain('bar');
  });

  it('accepts a provider proposal that survives validation', async () => {
    const db = fakeDb();
    const service = new FeedbackService(
      db as never,
      parser({ parse: async () => ({ avoidCategoryKeys: ['cafe'] }) }),
      true,
    );
    const result = await service.interpret(input, context, audit);

    expect(result.outcome).toBe('accepted');
    expect(result.modelVersion).toBe('test-model-v1');
    expect(result.applied.avoidCategoryKeys).toEqual(['cafe']);
  });

  it('falls back deterministically when the provider is down', async () => {
    const db = fakeDb();
    const service = new FeedbackService(
      db as never,
      parser({
        parse: async () => {
          throw new Error('connection refused');
        },
      }),
      true,
    );
    const result = await service.interpret(input, context, audit);

    expect(result.outcome).toBe('provider_error');
    // The user asked for a different plan, not for a report about a model.
    expect(result.understood).toBe(true);
    expect(result.applied.budgetMaxAmount).toBe(300_000);
  });

  it('falls back on quota exhaustion without retrying it', async () => {
    const db = fakeDb();
    let calls = 0;
    const service = new FeedbackService(
      db as never,
      parser({
        parse: async () => {
          calls += 1;
          throw new ProviderQuotaExceededError('ai');
        },
      }),
      true,
    );
    const result = await service.interpret(input, context, audit);

    expect(result.outcome).toBe('quota');
    expect(calls).toBe(1);
    expect(result.understood).toBe(true);
  });

  it('falls back when the provider hangs past the timeout', async () => {
    const db = fakeDb();
    const service = new FeedbackService(
      db as never,
      parser({
        parse: (_i, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
            // Nothing resolves it: only the abort ends this.
          }),
      }),
      true,
      undefined,
      // The real ceiling is 15s (the guardrail limit); 20ms here asserts the
      // behaviour rather than the clock.
      20,
    );

    const result = await service.interpret(input, context, audit);
    expect(result.outcome).toBe('timeout');
    // A hung model must not mean a hung regenerate.
    expect(result.understood).toBe(true);
    expect(result.applied.budgetMaxAmount).toBe(300_000);
  });

  it('never partially applies output that fails validation', async () => {
    const db = fakeDb();
    const service = new FeedbackService(
      db as never,
      // A hallucinated place id plus a budget it is not allowed to name.
      parser({
        parse: async () => ({
          excludePlaceIds: ['99999999-9999-4999-8999-999999999999'],
          setBudgetTo: 10_000_000,
        }),
      }),
      true,
    );
    const result = await service.interpret(input, context, audit);

    expect(result.outcome).toBe('rejected');
    expect(result.applied.excludePlaceIds).toEqual([]);
    // Fell back, so the deterministic reading of the same text still applies.
    expect(result.applied.budgetMaxAmount).toBe(300_000);
  });

  it('audits the run without storing the member’s words', async () => {
    const db = fakeDb();
    const service = new FeedbackService(db as never, undefined, false);
    await service.interpret(input, context, audit);

    const row = db.rows[0]!;
    expect(row['modelVersion']).toBe('keyword-v1');
    expect(row['outcome']).toBe('disabled');
    expect(row['inputLength']).toBe(input.text.length);
    // The text is the input; keeping arbitrary user words where nothing reads
    // them is not worth the risk.
    expect(JSON.stringify(row)).not.toContain('rẻ hơn');
  });

  it('an audit failure does not fail the regenerate it describes', async () => {
    const brokenDb = {
      insert: () => ({
        values: async () => {
          throw new Error('database unavailable');
        },
      }),
    };
    const service = new FeedbackService(brokenDb as never, undefined, false);
    await expect(service.interpret(input, context, audit)).resolves.toMatchObject({
      understood: true,
    });
  });
});

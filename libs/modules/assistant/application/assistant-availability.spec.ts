import { describe, expect, it } from 'vitest';
import { AssistantAvailabilityService } from './assistant-availability.service';

/**
 * GoGo-BE#717 A-R2-01 — inside the send transaction, admission runs every
 * query on the transaction's own connection: asking the pool for a second
 * one while holding the budget lock starves the pool under load.
 */
describe('admission stays on the caller connection (A-R2-01)', () => {
  it('requireReady(tx) never touches the pooled db', async () => {
    let pooled = 0;
    let onTx = 0;
    const db = {
      execute: async () => {
        pooled += 1;
        return { rows: [] };
      },
    };
    const tx = {
      execute: async () => {
        onTx += 1;
        return { rows: [{ hit: false, usd: 0 }] };
      },
    };
    const service = new AssistantAvailabilityService(
      db as never,
      {
        APP_ENV: 'dev',
        OPENROUTER_API_KEY: 'k',
        ASSISTANT_DAILY_MESSAGE_LIMIT: 30,
        ASSISTANT_MESSAGES_PER_MINUTE_LIMIT: 5,
        ASSISTANT_MONTHLY_BUDGET_USD: 10,
        ASSISTANT_TURN_COST_CEILING_USD: 0.005,
        ASSISTANT_REPLY_MAX_MS: 60_000,
      } as never,
      {
        byokViolationSince: async (exec: { execute: () => Promise<unknown> }) => {
          await exec.execute();
          return false;
        },
        monthSpendUsd: async (exec: { execute: () => Promise<unknown> }) => {
          await exec.execute();
          return 0;
        },
      } as never,
    );
    await service.requireReady(tx as never).catch(() => undefined);
    expect(onTx).toBeGreaterThan(0);
    expect(pooled).toBe(0);
  });
});

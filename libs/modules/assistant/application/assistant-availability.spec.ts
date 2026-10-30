import { describe, expect, it, vi } from 'vitest';
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
        OPENROUTER_ASSISTANT_API_KEY: 'k',
        OPENROUTER_API_KEY: 'j',
        ASSISTANT_USER_DAILY_MAX_MESSAGES: 30,
        ASSISTANT_USER_PER_MINUTE_MAX_MESSAGES: 5,
        ASSISTANT_MONTHLY_MAX_USD: 10,
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

/**
 * GoGo-BE#731 — the assistant needs both models' keys: Haiku's BYOK key
 * (OPENROUTER_ASSISTANT_API_KEY) and Jev's own (OPENROUTER_API_KEY). Missing
 * either one is `unconfigured`, never a half-working assistant.
 */
describe('readiness needs both OpenRouter keys (GoGo-BE#731)', () => {
  const tx = { execute: async () => ({ rows: [{ hit: false, usd: 0 }] }) };
  const make = (keys: { OPENROUTER_ASSISTANT_API_KEY: string; OPENROUTER_API_KEY: string }) =>
    new AssistantAvailabilityService(
      tx as never,
      {
        APP_ENV: 'dev',
        ...keys,
        ASSISTANT_USER_DAILY_MAX_MESSAGES: 30,
        ASSISTANT_USER_PER_MINUTE_MAX_MESSAGES: 5,
        ASSISTANT_MONTHLY_MAX_USD: 10,
        ASSISTANT_TURN_COST_CEILING_USD: 0.005,
        ASSISTANT_REPLY_MAX_MS: 60_000,
      } as never,
      { byokViolationSince: async () => false, monthSpendUsd: async () => 0 } as never,
    );

  it.each([
    ['no Jev key', { OPENROUTER_ASSISTANT_API_KEY: 'k', OPENROUTER_API_KEY: '' }],
    ['no Haiku key', { OPENROUTER_ASSISTANT_API_KEY: '', OPENROUTER_API_KEY: 'j' }],
  ])('%s → unconfigured', async (_name, keys) => {
    const service = make(keys);
    vi.spyOn(service, 'killSwitchOn').mockResolvedValue(true);
    expect(await service.readiness(tx as never)).toEqual({ ok: false, reason: 'unconfigured' });
  });

  it('both keys → ready', async () => {
    const service = make({ OPENROUTER_ASSISTANT_API_KEY: 'k', OPENROUTER_API_KEY: 'j' });
    vi.spyOn(service, 'killSwitchOn').mockResolvedValue(true);
    expect((await service.readiness(tx as never)).ok).toBe(true);
  });
});

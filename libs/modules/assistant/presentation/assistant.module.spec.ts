import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_LLM } from '@gogo/providers';
import { ASSISTANT_DECISION_PROVIDER } from '../application/assistant.config';
import { AssistantModule } from './assistant.module';

/**
 * GoGo-BE#731 (owner 2026-10-31, ADR-0036 §9) — two keys: Jev answers on
 * gogo_be_<env> (OPENROUTER_API_KEY, OpenRouter credits), Haiku on
 * gogo_ai_anthropic_<env> (OPENROUTER_ASSISTANT_API_KEY, the only key the
 * workspace's Anthropic BYOK key applies to). A swap would bill Jev to the BYOK
 * key's line, or send Haiku on a key Anthropic BYOK does not cover.
 */
type FactoryProvider = { provide: unknown; useFactory: (config: unknown) => unknown };

const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AssistantModule) as unknown[];
const factory = (token: unknown) =>
  (providers.find((p) => (p as FactoryProvider).provide === token) as FactoryProvider).useFactory;
const apiKeyOf = (instance: unknown) =>
  (instance as { options: { apiKey: string } } | null)?.options.apiKey ?? null;

const config = {
  OPENROUTER_ASSISTANT_API_KEY: 'haiku-byok-key',
  OPENROUTER_API_KEY: 'jev-key',
  ASSISTANT_JEV_MODEL: 'typesafe/jev-1.14',
  ASSISTANT_JEV_TIMEOUT_MS: 6_000,
  ASSISTANT_HAIKU_MODEL: 'anthropic/claude-haiku-5.5',
};

describe('assistant model keys (GoGo-BE#731)', () => {
  it('Jev uses OPENROUTER_API_KEY, Haiku uses OPENROUTER_ASSISTANT_API_KEY', () => {
    expect(apiKeyOf(factory(ASSISTANT_DECISION_PROVIDER)(config))).toBe('jev-key');
    expect(apiKeyOf(factory(ASSISTANT_LLM)(config))).toBe('haiku-byok-key');
  });

  it("each binding is absent without its own key, never borrowing the other's", () => {
    expect(factory(ASSISTANT_DECISION_PROVIDER)({ ...config, OPENROUTER_API_KEY: '' })).toBeNull();
    expect(factory(ASSISTANT_LLM)({ ...config, OPENROUTER_ASSISTANT_API_KEY: '' })).toBeNull();
  });
});

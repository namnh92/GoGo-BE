/** The configuration slice the assistant reads (validated in apps/api env.ts). */
export type AssistantConfig = {
  APP_ENV: 'dev' | 'staging' | 'prod' | 'production';
  OPENROUTER_API_KEY: string;
  ASSISTANT_DAILY_MESSAGE_LIMIT?: number | undefined;
  ASSISTANT_MESSAGES_PER_MINUTE_LIMIT?: number | undefined;
  ASSISTANT_MONTHLY_BUDGET_USD?: number | undefined;
  ASSISTANT_TURN_COST_CEILING_USD: number;
  ASSISTANT_FIRST_TEXT_TIMEOUT_MS: number;
  ASSISTANT_REPLY_MAX_MS: number;
  ASSISTANT_MAX_OUTPUT_TOKENS: number;
  ASSISTANT_JEV_MODEL: string;
  ASSISTANT_JEV_TIMEOUT_MS: number;
  ASSISTANT_HAIKU_MODEL: string;
};

/** Identifies this API process as a generation lease holder. */
export const ASSISTANT_INSTANCE_ID = Symbol('ASSISTANT_INSTANCE_ID');

/** The decision provider bound for the assistant (null when unconfigured). */
export const ASSISTANT_DECISION_PROVIDER = Symbol('ASSISTANT_DECISION_PROVIDER');

/** How long a generation lease lasts without renewal, and how often it renews. */
export const LEASE_MS = 90_000;
export const LEASE_RENEW_MS = 20_000;

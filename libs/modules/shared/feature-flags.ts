import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { AppError } from './app-error';

/**
 * BE-CMS-G3 (#221) — what an app flag is allowed to be.
 *
 * The contract was `enabled: boolean` plus an opaque `payload`, so anything
 * with a shape — a minimum app version, a result limit, a maintenance switch
 * that applies to iOS only — had to be smuggled through `payload` and
 * interpreted by whoever read it. That makes the client the place where the
 * meaning of a config value is defined, which is exactly backwards: a badly
 * formatted version string should be refused by the API, not tolerated by one
 * client and crashed on by another.
 *
 * So a flag has a declared type, and the value is validated against it on the
 * way in. Three rules follow from that:
 *
 * - **Keys are a closed registry.** Every key exists because some code reads
 *   it. A console that can invent keys is a JSON store with an audit log, and
 *   nothing would read what it wrote.
 * - **The type lives here, not in the row.** Storing it per row would let two
 *   rows for the same key disagree, and the code reading the flag has only one
 *   expectation.
 * - **The default lives here too.** A flag with no row is not "false" — it is
 *   "not configured", and the difference matters for a limit or a version.
 *
 * This is application configuration. It is never a place for a secret: values
 * are readable by every admin who can open the console and are written to the
 * audit log.
 */

export const FLAG_VALUE_TYPES = ['boolean', 'string', 'number', 'json', 'version'] as const;
export type FlagValueType = (typeof FLAG_VALUE_TYPES)[number];

/** `all` is the unscoped row every flag falls back to. */
export const FLAG_ENVIRONMENTS = ['all', 'dev', 'staging', 'production'] as const;
export type FlagEnvironment = (typeof FLAG_ENVIRONMENTS)[number];

export const FLAG_PLATFORMS = ['all', 'ios', 'android', 'web'] as const;
export type FlagPlatform = (typeof FLAG_PLATFORMS)[number];

export type FlagDefinition = {
  valueType: FlagValueType;
  /** What the code does when no row matches. Never null: "unset" is a value. */
  defaultValue: unknown;
  description: string;
  /**
   * Whether a per-platform override means anything for this key. A server-side
   * import rule has no platform; a minimum app version has nothing else.
   */
  platformScoped: boolean;
};

/**
 * Every key some code actually reads.
 *
 * Adding one is a code change on purpose — the reader and the key ship
 * together, so a key can never sit in the console with nothing behind it.
 */
export const FEATURE_FLAGS = {
  maintenance_mode: {
    valueType: 'boolean',
    defaultValue: false,
    description: 'Serve the maintenance screen instead of the app.',
    platformScoped: true,
  },
  minimum_app_version: {
    valueType: 'version',
    defaultValue: '0.0.0',
    description: 'Below this the client must update before it can continue.',
    platformScoped: true,
  },
  recommended_app_version: {
    valueType: 'version',
    defaultValue: '0.0.0',
    description: 'Below this the client suggests an update but keeps working.',
    platformScoped: true,
  },
  recommendation_limit: {
    valueType: 'number',
    defaultValue: 20,
    description: 'How many recommendations a surface asks for at once.',
    platformScoped: false,
  },
  feature_group_planning: {
    valueType: 'boolean',
    defaultValue: false,
    description: 'Group planning surfaces are available to clients.',
    platformScoped: true,
  },
  feature_ai_recommendation: {
    valueType: 'boolean',
    defaultValue: false,
    description:
      'AI refinement of suggestions. Off is the deterministic path, which is the source of truth either way.',
    platformScoped: false,
  },
  'place_import.autopublish': {
    valueType: 'boolean',
    defaultValue: false,
    description: 'Publish an imported place without an editor reviewing it.',
    platformScoped: false,
  },
  'place_import.rules': {
    valueType: 'json',
    defaultValue: { minReviews: 10, minRating: 3.5, autoPublish: false },
    description: 'Thresholds a community-imported place must clear.',
    platformScoped: false,
  },
  // #337 (PR4). Both default **on**: they are rollback switches for a change
  // that removes provider calls, so "no row" has to mean the new behaviour —
  // otherwise shipping the code would change nothing until somebody remembered
  // to insert a row, and the saving would be invisible.
  'place_resolution_attestation.enabled': {
    valueType: 'boolean',
    defaultValue: true,
    description:
      'Accept a short-lived signed resolution attestation on submit instead of re-fetching Google.',
    platformScoped: false,
  },
  'place_dbfirst.enabled': {
    valueType: 'boolean',
    defaultValue: true,
    description:
      'Answer from the canonical provider row when the Google Place ID is already known and fresh.',
    platformScoped: false,
  },
  // #340 (PR7). Default **off**, unlike the two above: those switch off spend,
  // this one switches on a scheduled spender. A job that starts calling Google
  // the moment its code is deployed is not a job anyone chose to run — the
  // deploy-time default is `FLAG_PLACE_REFRESH`, and this row is the switch an
  // operator can throw during an incident without a deploy.
  'place_refresh.enabled': {
    valueType: 'boolean',
    defaultValue: false,
    description: 'Run the periodic Google Place ID liveness refresh (IDs-Only, billed at $0).',
    platformScoped: false,
  },
} as const satisfies Record<string, FlagDefinition>;

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[];

export function isFeatureFlagKey(key: string): key is FeatureFlagKey {
  return Object.hasOwn(FEATURE_FLAGS, key);
}

export function flagDefinition(key: string): FlagDefinition {
  if (!isFeatureFlagKey(key)) {
    // Named keys, not a wildcard store: a key nothing reads is a value that
    // silently does nothing, which is worse than a rejection.
    throw AppError.notFound('FLAG_UNKNOWN', 'No such application flag');
  }
  return FEATURE_FLAGS[key];
}

/**
 * A boolean flag's value, with the registry default honoured when nothing is
 * stored.
 *
 * `resolveFlag` reports `enabled: false` for an unconfigured flag, which is the
 * right answer for a feature that has to be switched on deliberately and the
 * wrong one for a kill switch that ships on. #337's two switches are the second
 * kind: they turn *off* a behaviour that is meant to be the default, so an
 * empty `feature_flags` table must read as on.
 *
 * The difference is `isDefault`, which `resolveFlag` already reports — this
 * only stops every call site from re-deriving it.
 */
export async function resolveBooleanFlag(
  db: Pick<Db, 'execute'>,
  key: FeatureFlagKey,
  target: { environment: FlagEnvironment; platform?: FlagPlatform },
): Promise<boolean> {
  const definition = FEATURE_FLAGS[key];
  if (definition.valueType !== 'boolean') {
    throw new Error(`resolveBooleanFlag called for non-boolean flag ${key}`);
  }
  const resolved = await resolveFlag(db, key, target);
  return resolved.isDefault ? definition.defaultValue === true : resolved.enabled;
}

/**
 * Semver without build metadata. Loose enough for `1.2.3-beta.1`, strict
 * enough that `v1.2` and `1.2.3.4` are refused here rather than by whichever
 * client compares versions least carefully.
 */
export const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;

const MAX_STRING_LENGTH = 4096;

/**
 * Validates a value against its declared type, throwing the field error the
 * console can point at.
 *
 * `boolean` is deliberately absent: a boolean flag's value is `enabled`, the
 * column the kill switches already read. Carrying it twice would be two
 * sources of truth for the one thing that has to be right during an incident.
 */
export function validateFlagValue(key: string, value: unknown): unknown {
  const definition = flagDefinition(key);
  const reject = (message: string): never => {
    throw AppError.badRequest('INVALID_FLAG_VALUE', 'Flag value does not match its type', [
      { field: 'value', code: definition.valueType, message },
    ]);
  };

  switch (definition.valueType) {
    case 'boolean':
      if (value !== undefined && value !== null) {
        reject('a boolean flag is set through `enabled`; it carries no separate value');
      }
      return null;
    case 'string':
      if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH) {
        reject(`expected a string of at most ${MAX_STRING_LENGTH} characters`);
      }
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        reject('expected a finite number');
      }
      return value;
    case 'version':
      if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
        reject('expected a version like 1.2.3 or 1.2.3-beta.1');
      }
      return value;
    case 'json':
      if (value === null || typeof value !== 'object') {
        reject('expected a JSON object or array');
      }
      return value;
  }
}

/**
 * How specific a stored row is for a given environment and platform, or null
 * when it does not apply at all.
 *
 * Most specific wins, and `all` is a real fallback rather than a wildcard
 * match: a production override beats an unscoped one, and an iOS override
 * beats a production-wide one only when the environment also matches.
 */
export function overrideSpecificity(
  row: { environment: FlagEnvironment; platform: FlagPlatform },
  target: { environment: FlagEnvironment; platform: FlagPlatform },
): number | null {
  const environmentScore =
    row.environment === target.environment ? 2 : row.environment === 'all' ? 1 : 0;
  const platformScore = row.platform === target.platform ? 2 : row.platform === 'all' ? 1 : 0;
  if (environmentScore === 0 || platformScore === 0) return null;
  // Environment dominates: a production row is never overruled by an iOS row
  // belonging to a different environment.
  return environmentScore * 4 + platformScore;
}

/** Maps the runtime `APP_ENV` onto the flag environment it configures. */
export function flagEnvironmentOf(appEnv: string): FlagEnvironment {
  if (appEnv === 'prod' || appEnv === 'production') return 'production';
  if (appEnv === 'staging') return 'staging';
  return 'dev';
}

/**
 * The read side: what a flag is worth right now for this environment and
 * platform.
 *
 * Returns the registry default when nothing is stored, so a caller never has
 * to tell "no row" apart from "false" — the difference between unconfigured
 * and configured-off is real for a limit or a version, and it is resolved
 * here rather than at every call site.
 */
export async function resolveFlag(
  db: Pick<Db, 'execute'>,
  key: FeatureFlagKey,
  target: { environment: FlagEnvironment; platform?: FlagPlatform },
): Promise<{ enabled: boolean; value: unknown; isDefault: boolean }> {
  const definition = FEATURE_FLAGS[key];
  const platform = target.platform ?? 'all';

  const { rows } = await db.execute(sql`
    select environment, platform, enabled, payload
    from feature_flags where key = ${key}
  `);

  let best: { score: number; enabled: boolean; payload: unknown } | null = null;
  for (const raw of rows as {
    environment: FlagEnvironment;
    platform: FlagPlatform;
    enabled: boolean;
    payload: unknown;
  }[]) {
    const score = overrideSpecificity(raw, { environment: target.environment, platform });
    if (score === null || (best && score <= best.score)) continue;
    best = { score, enabled: raw.enabled, payload: raw.payload };
  }

  if (!best) return { enabled: false, value: definition.defaultValue, isDefault: true };
  if (definition.valueType === 'boolean') {
    return { enabled: best.enabled, value: best.enabled, isDefault: false };
  }
  // A disabled override is not a value of its own: the flag falls back to the
  // default the code ships with, which is what "turn it off" has to mean.
  if (!best.enabled || best.payload === null) {
    return { enabled: false, value: definition.defaultValue, isDefault: true };
  }
  return { enabled: true, value: best.payload, isDefault: false };
}

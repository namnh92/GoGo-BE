/**
 * PI-BE-021 — which ports fell back to a fake, and what would have prevented it.
 *
 * The API module and the worker each decide this independently (one from the
 * validated config, one from `process.env`), and both decided it silently. A
 * missing key therefore looked like working software right up to the point an
 * editor was told their spreadsheet did not exist.
 *
 * This does not choose the adapters — the two processes construct different
 * ones and inject them differently. It answers the one question they share:
 * after choosing, is anything pretending?
 *
 * TRAVEL_TIME_PROVIDER is reported only when FLAG_ROUTES_API is on. With the
 * flag off, the straight-line estimate is the product's answer and not a
 * stand-in, so warning about it would train operators to ignore these lines.
 * With the flag on and no key, someone asked for real travel times and is
 * silently getting estimates — which is the same defect as the others here.
 */
export type FakedProvider = {
  /** Port that ended up bound to a fake. */
  port: string;
  /** The one variable that would have bound the real adapter. */
  envVar: string;
  /** What the fake does instead — the operator-facing consequence. */
  effect: string;
};

export type ProviderKeys = {
  GOOGLE_PLACES_API_KEY: string;
  GOOGLE_SHEETS_API_KEY: string;
  GOOGLE_ROUTES_API_KEY: string;
  /** Routes is opt-in; without the flag its absence is not a fault. */
  FLAG_ROUTES_API: boolean;
  /** #279 — resolved place-provider mode, when the caller knows it. */
  PLACE_PROVIDER_MODE?: PlaceProviderMode;
  /** #193 — resolved push-provider mode, when the caller knows it. */
  PUSH_PROVIDER_MODE?: PushProviderMode;
};

/**
 * #279 — what this process is *meant* to be running, decided before anyone
 * looks at whether a credential is present.
 *
 * That order is the whole point. Deciding from the credential means a missing
 * secret and a deliberate fake are the same state, and the system cannot tell
 * an operator which one it is in.
 */
export type PlaceProviderMode = 'google' | 'fake';

/**
 * Explicit setting wins. Otherwise the build decides: every deployed
 * environment runs `NODE_ENV=production` (written by GoGo-Infra's
 * `render-env.sh`), a developer's machine and the test suite do not.
 *
 * Keyed on NODE_ENV rather than APP_ENV because APP_ENV defaults to `dev`,
 * which is both a developer's laptop and a deployed environment — the
 * ambiguity that #215/#216 already had to unpick once.
 */
export function resolvePlaceProviderMode(input: {
  PLACE_PROVIDER_MODE?: PlaceProviderMode | undefined;
  NODE_ENV: string;
}): PlaceProviderMode {
  if (input.PLACE_PROVIDER_MODE) return input.PLACE_PROVIDER_MODE;
  return input.NODE_ENV === 'production' ? 'google' : 'fake';
}

/**
 * The non-secret operational signal: what got bound, whether it can work, and
 * why not.
 *
 * `ready: false` is deliberately not fatal at boot. Catalog search, rooms and
 * plans over existing places do not touch this port, and refusing to start
 * would turn one broken feature into an outage. It is a degraded state that
 * has to be *visible* — which is what was missing.
 */
export type PlaceProviderStatus = {
  mode: PlaceProviderMode;
  /** What was actually constructed. */
  provider: 'google' | 'fake' | 'unconfigured';
  ready: boolean;
  reason?: 'MISSING_CREDENTIAL';
};

export function placeProviderStatus(input: {
  PLACE_PROVIDER_MODE?: PlaceProviderMode | undefined;
  NODE_ENV: string;
  GOOGLE_PLACES_API_KEY: string;
}): PlaceProviderStatus {
  const mode = resolvePlaceProviderMode(input);
  if (mode === 'fake') return { mode, provider: 'fake', ready: true };
  if (input.GOOGLE_PLACES_API_KEY) return { mode, provider: 'google', ready: true };
  return { mode, provider: 'unconfigured', ready: false, reason: 'MISSING_CREDENTIAL' };
}

export function fakedProviders(keys: ProviderKeys): FakedProvider[] {
  const faked: FakedProvider[] = [];

  // #193: same shape as the place provider. In `onesignal` mode a missing key
  // binds `UnconfiguredPushProvider`, reported by `pushProviderStatus` as
  // not-ready; only the deliberate fake is "pretending".
  if (keys.PUSH_PROVIDER_MODE === 'fake') {
    faked.push({
      port: 'PUSH_PROVIDER',
      envVar: 'ONESIGNAL_REST_API_KEY',
      effect: 'push sends are recorded in memory and reach no device',
    });
  }

  // One variable per port, because one key per Google API. There used to be a
  // fallback chain here, and a chain means a warning has to explain which of
  // several names it wanted — the operator's next question after reading it.
  //
  // #279: in `google` mode a missing key no longer binds the fake at all, so
  // the effect sentence would be a lie. That case is reported by
  // `placeProviderStatus` instead, as not-ready rather than as pretending.
  const placeMode = keys.PLACE_PROVIDER_MODE ?? 'fake';
  if (!keys.GOOGLE_PLACES_API_KEY && placeMode === 'fake') {
    faked.push({
      port: 'PLACE_PROVIDER',
      envVar: 'GOOGLE_PLACES_API_KEY',
      effect: 'place lookup and resolution answer from a fixed in-memory set',
    });
    faked.push({
      port: 'AREA_AUTOCOMPLETE',
      envVar: 'GOOGLE_PLACES_API_KEY',
      effect: 'area suggestions answer from a fixed in-memory set',
    });
  }

  if (!keys.GOOGLE_SHEETS_API_KEY) {
    faked.push({
      port: 'SHEETS_PROVIDER',
      envVar: 'GOOGLE_SHEETS_API_KEY',
      effect: 'every CMS Google Sheet import fails with SHEET_PROVIDER_NOT_CONFIGURED',
    });
  }

  if (keys.FLAG_ROUTES_API && !keys.GOOGLE_ROUTES_API_KEY) {
    faked.push({
      port: 'TRAVEL_TIME_PROVIDER',
      envVar: 'GOOGLE_ROUTES_API_KEY',
      effect: 'travel times are straight-line estimates despite FLAG_ROUTES_API being on',
    });
  }

  return faked;
}

/**
 * Log one warn line per faked port at startup.
 *
 * Not gated on the environment. `APP_ENV` has no value that means "a fake is
 * expected here" — a developer without keys is the normal case and a warn is
 * the right weight for it, while the same line in a deployed environment is the
 * whole point. Silence was the bug.
 *
 * Never logs a key, present or absent: the env var *names* are the actionable
 * part, and a length or a prefix is still a fact about a credential.
 */
export function warnFakedProviders(
  keys: ProviderKeys,
  warn: (meta: Record<string, unknown>, message: string) => void,
): FakedProvider[] {
  const faked = fakedProviders(keys);
  for (const provider of faked) {
    warn(
      { port: provider.port, missing_env: provider.envVar, effect: provider.effect },
      'provider not configured — bound to a fake',
    );
  }
  return faked;
}

/**
 * NTF-BE-002 (#193) — which push provider this process is meant to be running.
 *
 * Same rule as `resolvePlaceProviderMode`, for the same reason: DEV is
 * mini-production and runs the production build, so a deployed environment is
 * on OneSignal unless it says otherwise; a laptop and the test suite are on the
 * fake unless they say otherwise. Presence of a credential never decides.
 */
export type PushProviderMode = 'onesignal' | 'fake';

export function resolvePushProviderMode(input: {
  PUSH_PROVIDER_MODE?: PushProviderMode | undefined;
  NODE_ENV: string;
}): PushProviderMode {
  if (input.PUSH_PROVIDER_MODE) return input.PUSH_PROVIDER_MODE;
  return input.NODE_ENV === 'production' ? 'onesignal' : 'fake';
}

/** OneSignal app ids are UUIDs; anything else is a paste error, not a config. */
export const ONESIGNAL_APP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PushProviderStatus = {
  mode: PushProviderMode;
  /** What was actually constructed. */
  provider: 'onesignal' | 'fake' | 'unconfigured';
  ready: boolean;
  reason?: 'MISSING_CREDENTIAL' | 'INVALID_APP_ID';
};

/**
 * `ready: false` is not fatal at boot (spec §48): push is an asynchronous
 * dependency, and a worker refusing to start over it would also stop imports
 * and privacy jobs. It is a degraded state that has to be visible — the boot
 * log names it, and every send fails with a counted configuration fault.
 */
export function pushProviderStatus(input: {
  PUSH_PROVIDER_MODE?: PushProviderMode | undefined;
  NODE_ENV: string;
  ONESIGNAL_APP_ID: string;
  ONESIGNAL_REST_API_KEY: string;
}): PushProviderStatus {
  const mode = resolvePushProviderMode(input);
  if (mode === 'fake') return { mode, provider: 'fake', ready: true };
  if (!input.ONESIGNAL_APP_ID || !input.ONESIGNAL_REST_API_KEY) {
    return { mode, provider: 'unconfigured', ready: false, reason: 'MISSING_CREDENTIAL' };
  }
  if (!ONESIGNAL_APP_ID_PATTERN.test(input.ONESIGNAL_APP_ID)) {
    return { mode, provider: 'unconfigured', ready: false, reason: 'INVALID_APP_ID' };
  }
  return { mode, provider: 'onesignal', ready: true };
}

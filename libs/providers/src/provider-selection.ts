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
 */
export type FakedProvider = {
  /** Port that ended up bound to a fake. */
  port: string;
  /** Any one of these, non-empty, would have bound the real adapter. */
  envVars: readonly string[];
  /** What the fake does instead — the operator-facing consequence. */
  effect: string;
};

export type ProviderKeys = {
  GOOGLE_MAPS_API_KEY: string;
  GOOGLE_SHEETS_API_KEY: string;
};

export function fakedProviders(keys: ProviderKeys): FakedProvider[] {
  const faked: FakedProvider[] = [];

  if (!keys.GOOGLE_MAPS_API_KEY) {
    faked.push({
      port: 'PLACE_PROVIDER',
      envVars: ['GOOGLE_MAPS_API_KEY'],
      effect: 'place lookup and resolution answer from a fixed in-memory set',
    });
    faked.push({
      port: 'AREA_AUTOCOMPLETE',
      envVars: ['GOOGLE_MAPS_API_KEY'],
      effect: 'area suggestions answer from a fixed in-memory set',
    });
  }

  if (!keys.GOOGLE_SHEETS_API_KEY && !keys.GOOGLE_MAPS_API_KEY) {
    faked.push({
      port: 'SHEETS_PROVIDER',
      envVars: ['GOOGLE_SHEETS_API_KEY', 'GOOGLE_MAPS_API_KEY'],
      effect: 'every CMS Google Sheet import fails with SHEET_PROVIDER_NOT_CONFIGURED',
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
      { port: provider.port, missing_env: provider.envVars, effect: provider.effect },
      'provider not configured — bound to a fake',
    );
  }
  return faked;
}

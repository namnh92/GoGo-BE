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
 * TRAVEL_TIME_PROVIDER is deliberately absent. Its fallback is a deliberate
 * product choice behind FLAG_ROUTES_API — a straight-line estimate is a real
 * answer, not a stand-in — so warning about it would train operators to ignore
 * these lines.
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
};

export function fakedProviders(keys: ProviderKeys): FakedProvider[] {
  const faked: FakedProvider[] = [];

  // One variable per port, because one key per Google API. There used to be a
  // fallback chain here, and a chain means a warning has to explain which of
  // several names it wanted — the operator's next question after reading it.
  if (!keys.GOOGLE_PLACES_API_KEY) {
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

/** Explicit per-run spend bound. Suggested small first-run cap: 100. */
export const SUGGESTED_MAX_GOOGLE_CALLS = 100;

export function parseAddressBackfillArgs(argv: string[]): {
  dryRun: boolean;
  maxGoogleCalls: number;
} {
  let dryRun = true;
  let modeSeen = false;
  let maxGoogleCalls: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute' || arg === '--dry-run') {
      if (modeSeen) throw new Error('Supply only one mode flag');
      modeSeen = true;
      dryRun = arg !== '--execute';
    } else if (arg === '--max-google-calls') {
      const value = argv[++i];
      if (maxGoogleCalls !== undefined || !value || !/^[1-9]\d*$/.test(value)) {
        throw new Error('--max-google-calls requires one positive safe integer');
      }
      maxGoogleCalls = Number(value);
      if (!Number.isSafeInteger(maxGoogleCalls)) throw new Error('Invalid Google call cap');
    } else {
      throw new Error('Unknown address-backfill argument');
    }
  }
  if (maxGoogleCalls === undefined) {
    throw new Error(`--max-google-calls is required (suggested: ${SUGGESTED_MAX_GOOGLE_CALLS})`);
  }
  return { dryRun, maxGoogleCalls };
}

/** Explicit mode and bounded candidate count, as the address backfill CLI. */
export function parseProviderPhotoBackfillArgs(argv: string[]): {
  dryRun: boolean;
  probe: boolean;
  limit: number;
} {
  let dryRun = true;
  let modeSeen = false;
  let probe = false;
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply' || arg === '--dry-run') {
      if (modeSeen) throw new Error('Supply only one mode flag');
      modeSeen = true;
      dryRun = arg !== '--apply';
    } else if (arg === '--probe') {
      if (probe) throw new Error('Duplicate probe');
      probe = true;
    } else if (arg === '--limit') {
      const value = argv[++i];
      if (limit !== undefined || !value || !/^[1-9]\d*$/.test(value))
        throw new Error('--limit requires one positive safe integer');
      limit = Number(value);
      if (!Number.isSafeInteger(limit)) throw new Error('Invalid limit');
    } else throw new Error('Unknown photo-backfill argument');
  }
  if (limit === undefined) throw new Error('--limit is required (suggested: 100)');
  if (probe && !dryRun) throw new Error('--probe requires dry-run');
  return { dryRun, probe, limit };
}

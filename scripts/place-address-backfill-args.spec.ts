import { describe, expect, it } from 'vitest';
import { parseAddressBackfillArgs } from './place-address-backfill-args';

describe('address backfill arguments', () => {
  it('defaults to dry-run with an explicit cap', () => {
    expect(parseAddressBackfillArgs(['--max-google-calls', '100'])).toEqual({
      dryRun: true,
      maxGoogleCalls: 100,
    });
    expect(parseAddressBackfillArgs(['--execute', '--max-google-calls', '1']).dryRun).toBe(false);
    expect(parseAddressBackfillArgs(['--dry-run', '--max-google-calls', '1']).dryRun).toBe(true);
  });

  it.each(
    [
      [],
      ['--execute'],
      ['--max-google-calls'],
      ['--max-google-calls', '0'],
      ['--max-google-calls', '-1'],
      ['--max-google-calls', '1.5'],
      ['--max-google-calls', 'NaN'],
      ['--max-google-calls', '9007199254740992'],
      ['--max-google-calls', '1', '--max-google-calls', '2'],
      ['--max-google-calls', '1', '--execute', '--dry-run'],
      ['--max-google-calls', '1', '--typo'],
    ].map((argv) => ({ argv })),
  )('rejects unsafe invocation $argv before I/O', ({ argv }) => {
    expect(() => parseAddressBackfillArgs(argv)).toThrow();
  });
});

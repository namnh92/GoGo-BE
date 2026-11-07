import { describe, expect, it } from 'vitest';
import { parseProviderPhotoBackfillArgs as parse } from './place-provider-photo-backfill-args';

describe('provider photo CLI args', () => {
  it('defaults to bounded dry-run and allows explicit probe/apply', () => {
    expect(parse(['--limit', '10'])).toEqual({ dryRun: true, probe: false, limit: 10 });
    expect(parse(['--dry-run', '--probe', '--limit', '1']).probe).toBe(true);
    expect(parse(['--apply', '--limit', '1']).dryRun).toBe(false);
  });
  it.each([
    [],
    ['--limit', '0'],
    ['--limit', '-1'],
    ['--limit', '1.5'],
    ['--limit', '9007199254740992'],
    ['--limit'],
    ['--limit', '1', '--limit', '2'],
    ['--apply', '--dry-run', '--limit', '1'],
    ['--apply', '--probe', '--limit', '1'],
    ['--probe', '--probe', '--limit', '1'],
    ['--unknown'],
  ])('rejects malformed/conflicting input %j', (...args) => {
    expect(() => parse(args as string[])).toThrow();
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PinnedSnapshotReader } from './pinned-snapshot.reader';

/**
 * #611 — every number the manifest pins is a number somebody can check.
 *
 * `bytes` sits beside `sha256` in the block that says "this is what was
 * pinned", and for `historical-units` it was wrong for months: 2451968 where
 * the decompressed file is 2500493 bytes. Nothing read it — the reader verifies
 * the sha256 only — and the two tests that did assert `bytes` covered two other
 * roles. A wrong figure in that block teaches a reader that the manifest's
 * figures are decorative, in the one file whose whole purpose is that they are
 * not. So every vendored role is checked here, both figures, against the bytes
 * on disk — and a role added later is covered without anyone remembering to.
 */
describe('the pinned manifest', () => {
  const reader = new PinnedSnapshotReader();
  const manifest = reader.manifest();

  // `vendoredAs` is the on-disk name for every role, including the one the
  // loader fetches and caches; what separates the two is a fetch URL.
  const vendored = manifest.sources.filter((source) => !source.fetchUrl);
  const fetched = manifest.sources.filter((source) => source.fetchUrl);

  it('vendors at least the units, the history, the mapping and the fixture', () => {
    expect(vendored.map((s) => s.role)).toEqual(
      expect.arrayContaining([
        'current-units',
        'historical-units',
        'change-mapping',
        'boundaries-fixture',
      ]),
    );
  });

  it.each(vendored.map((source) => [source.role, source] as const))(
    'pins %s by the sha256 and the byte count of the decompressed file',
    (_role, source) => {
      // `read` throws SnapshotChecksumError on a sha256 mismatch, so getting
      // content back is the checksum assertion; the length is the one it skips.
      const content = reader.read(source);
      expect(createHash('sha256').update(content).digest('hex')).toBe(source.sha256);
      expect(content.byteLength).toBe(source.bytes);
    },
  );

  it.each(fetched.map((source) => [source.role, source] as const))(
    'pins %s, which is not vendored, by an immutable URL and a checksum',
    (_role, source) => {
      // The one input too large to commit still has to be identified exactly:
      // a commit-addressed URL (a tag can be re-pointed) and the checksum the
      // loader verifies before reading a single entry.
      expect(source.fetchUrl).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.+\/[0-9a-f]{40}\//);
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(source.bytes).toBeGreaterThan(0);
    },
  );
});

import { describe, expect, it } from 'vitest';
import {
  combinedChecksum,
  combinedDatasetVersion,
  type DatasetComponents,
} from './combined-version';

const base: DatasetComponents = {
  currentSourceVersion: 'v5.0.0',
  currentChecksum: 'b2af4329be6bbbb68bb53217d26edc8d4ff0a24aea5ad5569e72232cf6275ac3',
  historicalSourceVersion: 'v2.4.1',
  historicalChecksum: '86c1e097b1b8b63cf5f8b7aa71d90e3bd97f2e75412af67d5dede4d9c0e91899',
  mappingSourceCommit: '7fac8c45805aad9916b17237c54baf4502303b93',
  mappingChecksum: '93d53e6f53d2094a0bfa4a17fba18f772eab36106737962b00fe1749ca7bbb1d',
  boundarySourceVersion: null,
  boundaryChecksum: null,
  overrideRevision: 0,
};

describe('the identity of a dataset is the whole tuple', () => {
  it('is stable for unchanged inputs — which is what makes duplicate import detectable', () => {
    expect(combinedChecksum(base)).toBe(combinedChecksum({ ...base }));
    expect(combinedDatasetVersion(base)).toBe('v5.0.0+v2.4.1+7fac8c45+none+r0');
  });

  it.each([
    ['a new current release', { currentSourceVersion: 'v5.1.0', currentChecksum: 'other' }],
    ['a new historical pin', { historicalSourceVersion: 'v2.4.2', historicalChecksum: 'other' }],
    ['a new mapping commit', { mappingSourceCommit: 'deadbeef', mappingChecksum: 'other' }],
    ['a boundary set arriving', { boundarySourceVersion: 'gis-v4.0.0', boundaryChecksum: 'b' }],
    ['a reviewer approving one override', { overrideRevision: 1 }],
  ])('changes when %s', (_label, over) => {
    const next = { ...base, ...over };
    expect(combinedChecksum(next)).not.toBe(combinedChecksum(base));
    expect(combinedDatasetVersion(next)).not.toBe(combinedDatasetVersion(base));
  });

  it('separates the components rather than concatenating them', () => {
    // Without a separator, moving a character between two components would
    // hash the same. The canonical form is structured, so it cannot.
    const a = { ...base, currentSourceVersion: 'v5.0', historicalSourceVersion: '.0v2.4.1' };
    expect(combinedChecksum(a)).not.toBe(combinedChecksum(base));
  });
});

import { describe, expect, it } from 'vitest';
import { detectIdentityChange, type IdentitySnapshot } from './identity-change';

const base: IdentitySnapshot = {
  name: 'Cà Phê Sài Gòn',
  ratingCount: 500,
  primaryType: 'cafe',
  businessStatus: 'OPERATIONAL',
};

const after = (over: Partial<IdentitySnapshot>): IdentitySnapshot => ({ ...base, ...over });

describe('detectIdentityChange', () => {
  it('lets an ordinary rename through', () => {
    const v = detectIdentityChange(base, after({ name: 'Cafe Sài Gòn' }));
    expect(v.changed).toBe(false);
  });

  it('lets a branch suffix through', () => {
    const v = detectIdentityChange(
      { ...base, name: 'FIGHT STATION' },
      after({ name: 'FIGHT STATION Bình Thạnh' }),
    );
    expect(v.changed).toBe(false);
  });

  it('catches the owner change that name similarity alone misses', () => {
    // 0.60 similarity — a name-only gate at 0.5 would wave this through, but
    // the review count resetting says the business is new.
    const v = detectIdentityChange(
      { ...base, name: 'Highlands Coffee Nguyễn Huệ', ratingCount: 800 },
      after({ name: 'The Coffee House Nguyễn Huệ', ratingCount: 14 }),
    );
    expect(v.changed).toBe(true);
    expect(v.reasons).toContain('RATING_COUNT_RESET');
    expect(v.nameSimilarity).toBeGreaterThan(0.5);
  });

  it('catches a restaurant becoming a karaoke bar under the same name', () => {
    const v = detectIdentityChange(
      { ...base, name: 'Nhà Hàng Sen Việt', primaryType: 'restaurant' },
      after({ name: 'Karaoke Sen Việt', primaryType: 'karaoke' }),
    );
    expect(v.changed).toBe(true);
    expect(v.reasons).toContain('PRIMARY_TYPE_CHANGED');
  });

  it('does not report a change it cannot actually see', () => {
    // An unmapped provider type means "cannot tell", not "changed".
    const v = detectIdentityChange(
      { ...base, primaryType: 'point_of_interest' },
      after({ primaryType: 'establishment' }),
    );
    expect(v.reasons).not.toContain('PRIMARY_TYPE_CHANGED');
  });

  it('ignores a review drop on a place with too few reviews to judge', () => {
    const v = detectIdentityChange({ ...base, ratingCount: 8 }, after({ ratingCount: 2 }));
    expect(v.reasons).not.toContain('RATING_COUNT_RESET');
  });

  it('flags a permanently closed business', () => {
    const v = detectIdentityChange(base, after({ businessStatus: 'CLOSED_PERMANENTLY' }));
    expect(v.reasons).toContain('BUSINESS_CLOSED_PERMANENTLY');
  });

  it('flags a name with nothing left in common', () => {
    const v = detectIdentityChange(
      { ...base, name: 'Quán Nướng Ngõ 12' },
      after({ name: 'Nhà Hàng Hải Sản Biển Đông' }),
    );
    expect(v.reasons).toContain('NAME_UNRECOGNISABLE');
  });

  it('a same-owner rebrand still lands in the queue — false positives are cheap', () => {
    // Vietnamese → English scores 0.00. An editor glances and approves; the
    // opposite mistake ships a record that lies.
    const v = detectIdentityChange(base, after({ name: 'Saigon Coffee House' }));
    expect(v.changed).toBe(true);
    expect(v.reasons).toEqual(['NAME_UNRECOGNISABLE']);
  });
});

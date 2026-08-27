import { describe, expect, it, vi } from 'vitest';
import { expandShortLink, isAllowedMapsHost, parseMapsUrl } from './maps-url';
import { decideMatch, exactProviderMatch, nameSimilarity, scoreMatch } from './match-score';
import { adjustedRating, compositeQualityScore, providerScore } from './quality-score';
import { mapLegacyHeader, parseAudiences, parsePrice, parseVibes } from './normalize-row';

describe('maps URL parsing + SSRF guard (PI-BE-003, FR-INGEST-002)', () => {
  it('extracts provider id straight from the URL', () => {
    const r = parseMapsUrl('https://www.google.com/maps?place_id=ChIJabc123def');
    expect(r.ok && r.value.providerPlaceId).toBe('ChIJabc123def');
    expect(r.ok && r.value.needsExpansion).toBe(false);
  });

  it('extracts name + coordinates from a canonical place URL', () => {
    const r = parseMapsUrl('https://www.google.com/maps/place/FIGHT+STATION/@10.8012,106.7109,17z');
    expect(r.ok && r.value.query).toBe('FIGHT STATION');
    expect(r.ok && r.value.lat).toBeCloseTo(10.8012);
  });

  it('flags short links as needing expansion', () => {
    const r = parseMapsUrl('https://maps.app.goo.gl/abc123');
    expect(r.ok && r.value.needsExpansion).toBe(true);
  });

  it('rejects hostname spoofs and non-Google hosts', () => {
    for (const url of [
      'https://google.com.evil.tld/maps/place/X',
      'https://notgoogle.com/maps?place_id=ChIJ1',
      'https://maps.google.com.attacker.io/maps',
    ]) {
      const r = parseMapsUrl(url);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reasonCode).toBe('HOST_NOT_ALLOWED');
    }
    expect(isAllowedMapsHost('google.com.evil.tld')).toBe(false);
    expect(isAllowedMapsHost('maps.app.goo.gl')).toBe(true);
  });

  it('blocks private/loopback targets (SSRF)', () => {
    for (const url of [
      'http://127.0.0.1/maps',
      'http://localhost:3000/maps',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/maps',
      'http://[::1]/maps',
      'http://192.168.1.10/maps',
    ]) {
      const r = parseMapsUrl(url);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reasonCode).toBe('UNSAFE_TARGET');
    }
  });

  it('re-validates every redirect hop — open redirect cannot pivot internal', async () => {
    const fetcher = vi.fn(async () => ({
      status: 302,
      headers: { get: (): string | null => 'http://169.254.169.254/latest/meta-data' },
    }));
    const r = await expandShortLink('https://maps.app.goo.gl/abc', fetcher as never);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasonCode).toBe('UNSAFE_TARGET');
  });

  it('follows an allowed redirect to the canonical URL', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('goo.gl')) {
        return {
          status: 302,
          headers: {
            get: (): string | null => 'https://www.google.com/maps?place_id=ChIJexpanded',
          },
        };
      }
      return { status: 200, headers: { get: (): string | null => null }, url };
    });
    const r = await expandShortLink('https://maps.app.goo.gl/abc', fetcher as never);
    expect(r.ok && r.value.providerPlaceId).toBe('ChIJexpanded');
  });

  it('gives up after the redirect budget', async () => {
    const fetcher = vi.fn(async () => ({
      status: 302,
      headers: { get: (): string | null => 'https://maps.app.goo.gl/next' },
    }));
    const r = await expandShortLink('https://maps.app.goo.gl/a', fetcher as never, 3);
    expect(r.ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4); // initial + 3 hops
  });
});

describe('match scoring (PI-BE-005, FR-INGEST-003/004)', () => {
  const target = {
    googlePlaceId: 'ChIJ1',
    name: 'FIGHT STATION',
    address: '123 Đường ABC, Bình Thạnh, Hồ Chí Minh',
    lat: 10.8,
    lng: 106.71,
    primaryType: 'cafe',
  };

  it('name similarity ignores accents and word order', () => {
    expect(nameSimilarity('Cà phê Đỗ Phủ', 'do phu ca phe')).toBe(1);
    expect(nameSimilarity('Highlands', 'Starbucks')).toBe(0);
  });

  it('exact name + city scores auto-resolve', () => {
    const s = scoreMatch(
      { name: 'FIGHT STATION', city: 'Hồ Chí Minh', district: 'Bình Thạnh' },
      target,
    );
    expect(s.confidence).toBeGreaterThanOrEqual(0.9);
    expect(s.reasons).toContain('EXACT_NAME_CITY');
  });

  it('district/city/type mismatches emit reason codes and drop confidence', () => {
    const s = scoreMatch(
      { name: 'FIGHT STATION', city: 'Hà Nội', district: 'Cầu Giấy', categoryKey: 'park' },
      target,
    );
    expect(s.reasons).toEqual(
      expect.arrayContaining(['CITY_MISMATCH', 'DISTRICT_MISMATCH', 'TYPE_MISMATCH']),
    );
    expect(s.confidence).toBeLessThan(0.7);
  });

  it('two near-equal branches never auto-resolve (MULTIPLE_BRANCHES)', () => {
    const branchA = { ...target, googlePlaceId: 'ChIJA', address: '1 Lê Lợi, Quận 1, Hồ Chí Minh' };
    const branchB = { ...target, googlePlaceId: 'ChIJB', address: '2 Lê Lợi, Quận 1, Hồ Chí Minh' };
    const d = decideMatch({ name: 'FIGHT STATION', city: 'Hồ Chí Minh', district: 'Quận 1' }, [
      branchA,
      branchB,
    ]);
    expect(d.outcome).toBe('NEEDS_CONFIRMATION');
    expect(d.reasons).toContain('MULTIPLE_BRANCHES');
    expect(d.candidates).toHaveLength(2);
  });

  it('no candidates → UNRESOLVED; provider id → EXACT_PROVIDER_ID', () => {
    expect(decideMatch({ name: 'X' }, []).outcome).toBe('UNRESOLVED');
    const e = exactProviderMatch(target);
    expect(e.outcome).toBe('RESOLVED_AUTOMATICALLY');
    expect(e.best?.confidence).toBe(1);
  });

  it('is deterministic for the same input', () => {
    const input = { name: 'FIGHT STATION', city: 'Hồ Chí Minh' };
    const a = decideMatch(input, [target]);
    const b = decideMatch(input, [target]);
    expect(a.best?.confidence).toBe(b.best?.confidence);
  });
});

describe('Bayesian quality score (PI-BE-008, FR-INGEST-006)', () => {
  const priors = { global: 4.0, city: 4.1, categoryCity: 4.2 };

  it('few reviews stay near the prior; many reviews trust the rating', () => {
    const few = adjustedRating(5, 2, priors);
    const many = adjustedRating(5, 5000, priors);
    expect(few).toBeLessThan(4.5);
    expect(many).toBeGreaterThan(4.9);
  });

  it('falls back category-city → city → global', () => {
    expect(adjustedRating(null, null, priors)).toBe(4.2);
    expect(adjustedRating(null, null, { global: 4.0, city: 4.1 })).toBe(4.1);
    expect(adjustedRating(null, null, { global: 4.0 })).toBe(4.0);
  });

  it('provider score is 0..100', () => {
    expect(providerScore(4.5, 1000, priors)).toBeGreaterThan(85);
    expect(providerScore(4.5, 1000, priors)).toBeLessThanOrEqual(100);
  });

  it('GoGo weight caps at 0.7 and keeps sources separate', () => {
    const { gogoWeight } = compositeQualityScore({
      gogoScore: 90,
      gogoReviewCount: 10_000,
      providerScore: 70,
    });
    expect(gogoWeight).toBe(0.7);
    const none = compositeQualityScore({ gogoScore: null, gogoReviewCount: 0, providerScore: 70 });
    expect(none.composite).toBe(70);
  });
});

describe('VN row normalization (PI-BE-014, spec §4.4)', () => {
  it('parses the legacy price formats', () => {
    expect(parsePrice('45 - 75k')).toMatchObject({ min: 45_000, max: 75_000, unit: 'per_person' });
    expect(parsePrice('250k - 800k/món')).toMatchObject({
      min: 250_000,
      max: 800_000,
      unit: 'per_item',
    });
    expect(parsePrice('Miễn phí')).toMatchObject({ min: 0, max: 0, unit: 'free' });
    expect(parsePrice('~100k')).toMatchObject({ min: 100_000, max: 100_000 });
    expect(parsePrice('1tr - 2tr')).toMatchObject({ min: 1_000_000, max: 2_000_000 });
    expect(parsePrice('200.000')).toMatchObject({ min: 200_000 });
    expect(parsePrice('')).toMatchObject({ min: null, max: null, unit: 'unknown' });
  });

  it('maps audiences/vibes and reports unknown tokens instead of inventing keys', () => {
    expect(parseAudiences('Cặp đôi|Nhóm bạn').keys).toEqual(['couple', 'group']);
    expect(parseVibes('Yên tĩnh, Lãng mạn').keys).toEqual(['quiet', 'romantic']);
    const odd = parseVibes('Chill|xyzzy');
    expect(odd.keys).toEqual(['chill']);
    expect(odd.unknown).toEqual(['xyzzy']);
  });

  it('maps legacy sheet headers', () => {
    expect(mapLegacyHeader('Tên địa điểm')).toBe('name');
    expect(mapLegacyHeader('Khoảng giá/người')).toBe('price_raw');
    expect(mapLegacyHeader('Vibe/Bầu không khí')).toBe('vibes_raw');
    expect(mapLegacyHeader('Cột lạ')).toBeUndefined();
  });
});

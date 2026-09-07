import { describe, expect, it, beforeEach } from 'vitest';
import { FakePlaceProvider } from '@gogo/providers';
import { type Db } from '@gogo/database';
import { PlaceResolverService } from './place-resolver.service';

/**
 * #311 — Mobile add-by-link, end to end through the resolver.
 *
 * On 2026-09-01, with Google answering correctly on DEV, a `?api=1&query=…`
 * link for a real café came back `UNRESOLVED / LOW_CONFIDENCE`: the free-text
 * query was scored as if it were the place's name, and only the first provider
 * hit was ever considered. These cases pin both halves.
 *
 * `resolveFromUrl` never touches the database, so the stub below is enough.
 */
describe('resolveFromUrl on a shared link (PI-BE-025)', () => {
  let provider: FakePlaceProvider;
  let resolver: PlaceResolverService;

  beforeEach(() => {
    provider = new FakePlaceProvider();
    resolver = new PlaceResolverService(provider, {} as Db);
    provider.seed({
      providerPlaceId: 'ChIJ-lacaph-space',
      name: 'Lacàph Coffee Experiences Space 🇻🇳☕️',
      addressText: 'Tầng 1, 220 Nguyễn Công Trứ, Bến Thành, Hồ Chí Minh, Vietnam',
      lat: 10.7679,
      lng: 106.7004,
    });
    provider.seed({
      providerPlaceId: 'ChIJ-lacaph-bar',
      name: 'Lacàph Coffee Bar 🇻🇳☕️',
      addressText: 'Lầu 1, 151 Đồng Khởi, Sài Gòn, Hồ Chí Minh, Vietnam',
      lat: 10.7776,
      lng: 106.703,
    });
  });

  const link = (q: string, extra = '') =>
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}${extra}`;

  it('resolves the branch the link names, keeping the other on the decision', async () => {
    const out = await resolver.resolveFromUrl(
      link('Lacaph Coffee Experiences Space Ho Chi Minh City'),
      'quality',
    );

    // #311's guarantee holds: never UNRESOLVED for a link Google answered, and
    // the alternative stays on the decision. #473 lets it finish the job — the
    // query names this branch in full, and "Lacàph Coffee Bar" is a different
    // place rather than a branch wearing the same name.
    expect(out.status).toBe('RESOLVED');
    if (out.status !== 'RESOLVED') return;
    expect(out.decision.candidates).toHaveLength(2);
    expect(out.decision.best?.target.googlePlaceId).toBe('ChIJ-lacaph-space');
  });

  it('takes query_place_id as authoritative and skips the search', async () => {
    const out = await resolver.resolveFromUrl(
      link('Lacaph Coffee', '&query_place_id=ChIJ-lacaph-bar'),
      'quality',
    );

    expect(out.status).toBe('RESOLVED');
    if (out.status !== 'RESOLVED') return;
    // The id in the URL wins even though the query ranks the other branch first.
    expect(out.details.providerPlaceId).toBe('ChIJ-lacaph-bar');
    expect(out.decision.reasons).toContain('EXACT_PROVIDER_ID');
  });

  it('a query naming nothing in the catalogue is NOT_FOUND, not a bad match', async () => {
    const out = await resolver.resolveFromUrl(
      link('Trung Nguyen Legend Ho Chi Minh City'),
      'quality',
    );

    expect(out.status).toBe('UNRESOLVED');
    if (out.status !== 'UNRESOLVED') return;
    expect(out.reasonCode).toBe('NOT_FOUND');
  });

  it('scores at most CANDIDATE_LIMIT hits, however many the provider returns', async () => {
    for (let i = 0; i < 6; i += 1) {
      provider.seed({ providerPlaceId: `ChIJ-lacaph-${i}`, name: `Lacàph Branch ${i}` });
    }

    const out = await resolver.resolveFromUrl(link('Lacaph'), 'quality');

    if (out.status === 'UNRESOLVED') {
      expect(out.decision?.candidates.length ?? 0).toBeLessThanOrEqual(3);
      return;
    }
    if (out.status === 'NEEDS_CONFIRMATION') {
      expect(out.decision.candidates.length).toBeLessThanOrEqual(3);
    }
  });

  it('a URL with no query at all is NO_QUERY', async () => {
    const out = await resolver.resolveFromUrl('https://www.google.com/maps', 'quality');

    expect(out.status).toBe('UNRESOLVED');
    if (out.status !== 'UNRESOLVED') return;
    expect(out.reasonCode).toBe('NO_QUERY');
  });

  it('a provider outage is an unresolved link, not a crash', async () => {
    provider.failing = true;

    const out = await resolver.resolveFromUrl(link('Lacaph Coffee Experiences Space'), 'quality');

    expect(out.status).toBe('UNRESOLVED');
  });
});

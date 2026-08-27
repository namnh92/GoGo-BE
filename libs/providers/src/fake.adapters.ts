import type {
  AreaAutocompletePort,
  AreaPrediction,
  PlaceProviderPort,
  PushPort,
  ResolvedProviderPlace,
  StoragePort,
} from './ports';

/**
 * Fakes bound whenever real provider credentials are absent (dev/test) and in
 * contract tests (BE-BFF-011 acceptance: contract fake + failure injection).
 * Behavior is deterministic and controllable via the seeded registry.
 */

const defaultHours = Array.from({ length: 7 }, (_, day) => ({
  dayOfWeek: day,
  openMinute: 8 * 60,
  closeMinute: 22 * 60,
  isOvernight: false,
}));

export class FakePlaceProvider implements PlaceProviderPort {
  readonly registry = new Map<string, ResolvedProviderPlace>();
  /** Set to simulate provider outage. */
  failing = false;

  seed(place: Partial<ResolvedProviderPlace> & { providerPlaceId: string }): void {
    this.registry.set(place.providerPlaceId, {
      name: 'Fake Place',
      addressText: '1 Fake St, HCMC',
      lat: 10.776,
      lng: 106.7,
      rating: 4.4,
      ratingCount: 250,
      businessStatus: 'OPERATIONAL',
      hours: defaultHours,
      priceLevel: 2,
      attribution: 'Data © Fake Provider',
      raw: {},
      ...place,
    });
  }

  async resolveUrl(url: string): Promise<string | null> {
    if (this.failing) throw new Error('fake provider down');
    // Fake convention: any URL containing place_id=XYZ or /fake/XYZ resolves.
    const byParam = /[?&]place_id=([\w-]+)/.exec(url);
    if (byParam) return byParam[1]!;
    const byPath = /\/fake\/([\w-]+)/.exec(url);
    if (byPath) return byPath[1]!;
    return null;
  }

  async details(providerPlaceId: string): Promise<ResolvedProviderPlace | null> {
    if (this.failing) throw new Error('fake provider down');
    return this.registry.get(providerPlaceId) ?? null;
  }
}

export class FakeAreaAutocomplete implements AreaAutocompletePort {
  failing = false;
  predictions: AreaPrediction[] = [
    { key: 'hcm_q1', description: 'Quận 1, TP.HCM', lat: 10.7769, lng: 106.7009 },
    { key: 'hcm_q3', description: 'Quận 3, TP.HCM', lat: 10.7843, lng: 106.6844 },
    { key: 'hn_hoankiem', description: 'Hoàn Kiếm, Hà Nội', lat: 21.0285, lng: 105.8542 },
  ];

  async suggest(query: string, _sessionToken: string): Promise<AreaPrediction[]> {
    if (this.failing) throw new Error('fake autocomplete down');
    const q = query.toLowerCase();
    return this.predictions.filter((p) => p.description.toLowerCase().includes(q));
  }
}

export class FakePush implements PushPort {
  readonly sent: { deviceToken: string; title: string; body: string }[] = [];
  async send(deviceToken: string, payload: { title: string; body: string }): Promise<void> {
    this.sent.push({ deviceToken, title: payload.title, body: payload.body });
  }
}

export class FakeStorage implements StoragePort {
  async presignUpload(key: string): Promise<{ url: string; expiresInSeconds: number }> {
    return {
      url: `https://fake-storage.local/upload/${encodeURIComponent(key)}`,
      expiresInSeconds: 900,
    };
  }
}

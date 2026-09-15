import {
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  SheetAccessError,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
} from './ports';
import type {
  AcquisitionLinkInput,
  AcquisitionLinkPort,
  AreaAutocompletePort,
  AreaPrediction,
  CachePurgePort,
  PlaceDescriptionTier,
  PlaceFetchTier,
  NotificationProviderPort,
  PlaceProviderPort,
  PlaceSearchOptions,
  ProviderCandidateIdentity,
  ProviderPlaceIdentity,
  PushSendResult,
  ResolvedProviderPlace,
  SheetTab,
  SheetsPort,
  StoragePort,
  UserNotification,
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
  /** Tiers requested, in order — lets a test assert what a flow would be billed. */
  readonly tiersRequested: PlaceFetchTier[] = [];
  /**
   * Old id → the id Google answers with, for a place that moved or merged.
   * `details(old)` then returns the successor's row and says which id was
   * asked for, which is what #334's mismatch reporting keys on.
   */
  readonly movedTo = new Map<string, string>();
  /** Set to simulate provider outage. */
  failing = false;
  /** Every search this provider was asked for, with the bias it was given. */
  readonly searches: { query: string; bias?: PlaceSearchOptions['bias'] }[] = [];
  /** Paid Text Search Pro calls, kept apart from the free IDs-only ones. */
  readonly identitySearches: { query: string; bias?: PlaceSearchOptions['bias'] }[] = [];
  /** PI-QA-001: the two failure modes callers must handle differently — */
  /** quota parks a bulk job, a timeout is just an unresolved row. */
  quotaExhausted = false;
  timingOut = false;

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
      primaryType: 'cafe',
      // Shaped like Google's: the primary type, its narrower siblings, and the
      // generic parents that hang off almost every commercial place.
      types: ['cafe', 'coffee_shop', 'food', 'point_of_interest', 'establishment'],
      googleMapsUri: `https://maps.google.com/?cid=${place.providerPlaceId}`,
      photos: [],
      fetchTier: 'quality',
      attribution: 'Data © Fake Provider',
      raw: {},
      ...place,
    });
  }

  async resolveUrl(url: string): Promise<string | null> {
    this.guard();
    if (this.failing) throw new Error('fake provider down');
    // Fake convention: any URL containing place_id=XYZ or /fake/XYZ resolves.
    const byParam = /[?&]place_id=([\w-]+)/.exec(url);
    if (byParam) return byParam[1]!;
    const byPath = /\/fake\/([\w-]+)/.exec(url);
    if (byPath) return byPath[1]!;
    return null;
  }

  /**
   * Seeded places whose name shares a token with the query, best first.
   *
   * With a `bias`, nearest-first — which is what Google does with
   * `locationBias` and what #505's link resolution depends on: the branch a
   * share link points at is often not in an unbiased answer at all.
   */
  async searchCandidates(
    query: string,
    limit: number,
    options?: PlaceSearchOptions | undefined,
  ): Promise<string[]> {
    this.guard();
    if (this.failing) throw new Error('fake provider down');
    this.searches.push({ query, ...(options?.bias ? { bias: options.bias } : {}) });
    const wanted = query.toLowerCase().split(/\s+/).filter(Boolean);
    const bias = options?.bias;
    const hits = [...this.registry.entries()].filter(([, place]) =>
      wanted.some((w) => place.name.toLowerCase().includes(w)),
    );
    if (bias) {
      const d2 = (p: ResolvedProviderPlace) => (p.lat - bias.lat) ** 2 + (p.lng - bias.lng) ** 2;
      hits.sort(([, a], [, b]) => d2(a) - d2(b));
    }
    return hits.slice(0, limit).map(([id]) => id);
  }

  /**
   * The same ranking, with each hit's `googleMapsUri` — the paid Text Search
   * the resolver uses when it holds a CID to compare against. Recorded
   * separately so a test can assert which of the two SKUs was bought.
   */
  async searchCandidateIdentities(
    query: string,
    limit: number,
    options?: PlaceSearchOptions | undefined,
  ): Promise<ProviderCandidateIdentity[]> {
    const ids = await this.searchCandidates(query, limit, options);
    this.identitySearches.push(this.searches.pop()!);
    return ids.map((id) => ({
      providerPlaceId: id,
      googleMapsUri: this.registry.get(id)?.googleMapsUri ?? null,
    }));
  }

  async details(providerPlaceId: string, tier: 'liveness'): Promise<ProviderPlaceIdentity | null>;
  async details(
    providerPlaceId: string,
    tier: PlaceDescriptionTier,
  ): Promise<ResolvedProviderPlace | null>;
  async details(
    providerPlaceId: string,
    tier: PlaceFetchTier,
  ): Promise<ResolvedProviderPlace | ProviderPlaceIdentity | null> {
    this.guard();
    this.tiersRequested.push(tier);
    if (this.failing) throw new Error('fake provider down');
    const resolvedId = this.movedTo.get(providerPlaceId) ?? providerPlaceId;
    const stored = this.registry.get(resolvedId);
    if (!stored) return null;
    const moved = resolvedId !== providerPlaceId;
    // Liveness answers the identity question and refuses the rest, exactly as
    // the IDs-Only mask does. A fake that returned a whole place here would let
    // a caller read a rating it never paid for and never noticed it had lost.
    //
    // `movedTo` models a place whose id Google now redirects, so the fake
    // reports both signals the real mask can carry: the successor named
    // outright, and the answer arriving under a different id than was asked
    // for. Google can send either alone; a caller that handles both handles
    // every move it will meet.
    if (tier === 'liveness') {
      return {
        providerPlaceId: resolvedId,
        ...(moved ? { requestedProviderPlaceId: providerPlaceId, movedPlaceId: resolvedId } : {}),
        fetchTier: 'liveness',
      };
    }
    const place: ResolvedProviderPlace = moved
      ? { ...stored, requestedProviderPlaceId: providerPlaceId }
      : stored;
    // A `core` fetch cannot return quality fields, and a fake that hands them
    // over anyway teaches a test that the cheap tier is as good as the dear one.
    if (tier === 'core') {
      return {
        ...place,
        rating: null,
        ratingCount: 0,
        hours: [],
        priceLevel: null,
        fetchTier: tier,
      };
    }
    return { ...place, fetchTier: tier };
  }

  /** Mirrors what the real adapter throws after `withResilience` gives up. */
  private guard(): void {
    if (this.quotaExhausted) throw new ProviderQuotaExceededError('fake.places');
    if (this.timingOut) throw new ProviderUnavailableError('fake.places', 'timeout');
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

/**
 * NTF-BE-002 (#193) — in-memory stand-in for the user-targeted push port.
 *
 * One entry per provider call: a send to five people is one entry carrying
 * five ids, exactly the shape the real adapter puts on the wire. Tests that
 * want "how many people were pushed" flatten `userIds`.
 */
export class FakePush implements NotificationProviderPort {
  readonly sent: {
    userIds: string[];
    title: string;
    body: string;
    /** Every locale the call carried, so a test can read what a phone would pick. */
    headings: UserNotification['headings'];
    contents: UserNotification['contents'];
    data?: Record<string, string>;
    idempotencyKey?: string;
  }[] = [];
  /** Ids the fake reports back as unknown to the provider (never logged in). */
  readonly unknownUserIds = new Set<string>();
  /** Set to simulate the resilience wrapper giving up on a transient outage. */
  unavailable = false;

  sendToUser(userId: string, notification: UserNotification): Promise<PushSendResult> {
    return this.sendToUsers([userId], notification);
  }

  async sendToUsers(
    userIds: readonly string[],
    notification: UserNotification,
  ): Promise<PushSendResult> {
    if (this.unavailable) throw new ProviderUnavailableError('fake.push', 'simulated outage');
    const ids = [...userIds];
    this.sent.push({
      userIds: ids,
      title: notification.headings.en,
      body: notification.contents.en,
      headings: notification.headings,
      contents: notification.contents,
      ...(notification.data ? { data: notification.data } : {}),
      ...(notification.idempotencyKey ? { idempotencyKey: notification.idempotencyKey } : {}),
    });
    const unknown = ids.filter((id) => this.unknownUserIds.has(id));
    // Like the provider: a request whose every target is unknown creates no
    // message — an empty response, not a send.
    const id = unknown.length === ids.length ? null : `fake-${this.sent.length}`;
    return {
      providerMessageId: id,
      providerMessageIds: id ? [id] : [],
      emptyResponses: id ? 0 : 1,
      unknownUserIds: unknown,
    };
  }
}

/**
 * An in-memory bucket. A test seeds the bytes a phone would have PUT through
 * the presigned URL, the avatar pipeline reads, processes and writes them,
 * and the test inspects what landed in the public instance.
 */
export class FakeStorage implements StoragePort {
  readonly objects = new Map<
    string,
    { body: Uint8Array; contentType: string; cacheControl?: string | undefined }
  >();
  readonly deleted: string[] = [];
  /** Set to make every write or delete fail, for the cleanup-queue paths. */
  failWrites = false;

  async presignUpload(key: string): Promise<{ url: string; expiresInSeconds: number }> {
    return {
      url: `https://fake-storage.local/upload/${encodeURIComponent(key)}`,
      expiresInSeconds: 900,
    };
  }

  /** What a client PUT through the presigned URL; the API never sees that hop. */
  seed(key: string, body: Uint8Array, contentType: string): void {
    this.objects.set(key, { body, contentType });
  }

  async getObject(
    key: string,
    options: { maxBytes?: number } = {},
  ): Promise<{ body: Uint8Array; contentType: string | null; contentLength: number }> {
    const found = this.objects.get(key);
    if (!found) throw new StorageObjectNotFoundError(key);
    if (options.maxBytes !== undefined && found.body.byteLength > options.maxBytes) {
      throw new StorageObjectTooLargeError(key, options.maxBytes);
    }
    return {
      body: found.body,
      contentType: found.contentType,
      contentLength: found.body.byteLength,
    };
  }

  async putObject(
    key: string,
    body: Uint8Array,
    contentType: string,
    options: { cacheControl?: string } = {},
  ): Promise<void> {
    if (this.failWrites) throw new ProviderUnavailableError('fake-storage', 'failWrites');
    this.objects.set(key, { body, contentType, cacheControl: options.cacheControl });
  }

  async deleteObject(key: string): Promise<void> {
    if (this.failWrites) throw new ProviderUnavailableError('fake-storage', 'failWrites');
    this.objects.delete(key);
    this.deleted.push(key);
  }
}

/** Records what would have been purged at the edge. */
export class FakeCachePurge implements CachePurgePort {
  readonly purged: string[] = [];
  failPurges = false;

  async purgeUrls(urls: string[]): Promise<void> {
    if (this.failPurges) throw new ProviderUnavailableError('fake-cache', 'failPurges');
    this.purged.push(...urls);
  }
}

/**
 * PI-BE-012 — in-memory Sheets source. Bound whenever no Sheets credential is
 * configured, so the whole import pipeline is exercisable without Google.
 *
 * PI-BE-021: an id this fake was never seeded with is not a missing sheet. The
 * fake has no backing store to miss it in — it is standing in for a Google it
 * cannot reach. Reporting SHEET_NOT_FOUND sent an editor to check the sharing
 * settings of a document that was fine, eight times, while the actual fault was
 * an empty GOOGLE_SHEETS_API_KEY. Say whose fault it is.
 */
export class FakeSheets implements SheetsPort {
  readonly books = new Map<string, Map<string, string[][]>>();
  /** Set to simulate a sheet the service account cannot read. */
  denied = new Set<string>();
  quotaExhausted = false;

  seed(spreadsheetId: string, title: string, rows: string[][]): void {
    const book = this.books.get(spreadsheetId) ?? new Map<string, string[][]>();
    book.set(title, rows);
    this.books.set(spreadsheetId, book);
  }

  async listTabs(spreadsheetId: string): Promise<SheetTab[]> {
    const book = this.require(spreadsheetId);
    return [...book.keys()].map((title, index) => ({ title, index }));
  }

  async readTab(spreadsheetId: string, title: string, maxRows: number): Promise<string[][]> {
    const book = this.require(spreadsheetId);
    const rows = book.get(title);
    if (!rows) throw new SheetAccessError('SHEET_TAB_NOT_FOUND', `Tab ${title} không tồn tại`);
    return rows.slice(0, maxRows + 1).map((r) => [...r]);
  }

  private require(spreadsheetId: string): Map<string, string[][]> {
    if (this.quotaExhausted) throw new ProviderQuotaExceededError('fake.sheets');
    if (this.denied.has(spreadsheetId)) {
      throw new SheetAccessError('SHEET_PERMISSION_DENIED', 'Không có quyền đọc Google Sheet này');
    }
    const book = this.books.get(spreadsheetId);
    if (!book) {
      throw new SheetAccessError(
        'SHEET_PROVIDER_NOT_CONFIGURED',
        'GoGo chưa cấu hình kết nối Google Sheets',
      );
    }
    return book;
  }
}

/**
 * #247 — a queue inspector for environments with no Redis (tests, a boot
 * without a worker). Returns the queues it was given, or none.
 *
 * It reports nothing rather than inventing plausible depths: a fake that
 * fabricates a backlog teaches a dashboard test to pass against numbers no
 * deployment will ever produce.
 */

/**
 * LNK-BE-003 (#206) — records what the link service hands an attribution
 * vendor, so a test can prove the payload carries the canonical URL and
 * nothing personal, and can make the vendor fail to prove the canonical link
 * survives it.
 */
export class FakeAcquisitionLinkProvider implements AcquisitionLinkPort {
  readonly requests: AcquisitionLinkInput[] = [];
  failing = false;

  async createTrackingUrl(input: AcquisitionLinkInput): Promise<string> {
    this.requests.push(input);
    if (this.failing) throw new ProviderUnavailableError('fake.link', 'simulated outage');
    return `https://track.fake.test/click?deeplink_url=${encodeURIComponent(input.canonicalUrl)}`;
  }
}

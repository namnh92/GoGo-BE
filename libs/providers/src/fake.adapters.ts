import type { QueueStats, QueueStatsPort } from './ports';
import { ProviderQuotaExceededError, ProviderUnavailableError, SheetAccessError } from './ports';
import type {
  AreaAutocompletePort,
  AreaPrediction,
  PlaceProviderPort,
  PushPort,
  ResolvedProviderPlace,
  SheetTab,
  SheetsPort,
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

  async details(providerPlaceId: string): Promise<ResolvedProviderPlace | null> {
    this.guard();
    if (this.failing) throw new Error('fake provider down');
    return this.registry.get(providerPlaceId) ?? null;
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

/**
 * PI-BE-012 — in-memory Sheets source. Bound whenever no Sheets credential is
 * configured, so the whole import pipeline is exercisable without Google.
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
    if (!book) throw new SheetAccessError('SHEET_NOT_FOUND', 'Không tìm thấy Google Sheet');
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
export class FakeQueueStats implements QueueStatsPort {
  /** No broker behind this. Anything derived from Redis stays `unknown`. */
  readonly backend = 'none' as const;

  constructor(private readonly queues: QueueStats[] = []) {}

  async list(): Promise<QueueStats[]> {
    return this.queues.map((q) => ({ ...q }));
  }
}

/**
 * BE-BFF-011 — provider ports. Domain and BFF code depend only on these
 * interfaces; concrete adapters (Google, R2, FCM/APNs) and fakes are bound by
 * the app based on configuration. No SDK types leak past this file.
 */

/**
 * ADR-0006 §2 — how much of a place to pay for.
 *
 * `core` identifies a place, `quality` adds the facts a preview or a catalog
 * row needs, `detail` adds reviews and is never requested by a bulk job. The
 * tier a snapshot was taken at is recorded on `place_provider_sources`, so a
 * row always says which fields it could legitimately have.
 */
export type PlaceFetchTier = 'core' | 'quality' | 'detail';

/**
 * A photo the provider holds, **not** an image.
 *
 * `reference` is an opaque provider handle; turning it into bytes is a second,
 * separately billed call (Google: `places/*\/photos/*\/media`). Nothing in GoGo
 * stores provider images yet, so these are carried through the boundary and
 * left for whoever builds that stage — see `docs/place-import.md`.
 */
export type ProviderPhotoRef = {
  reference: string;
  widthPx: number | null;
  heightPx: number | null;
  /** Licence obligation: rendering a photo means rendering these with it. */
  attributions: string[];
};

export type ResolvedProviderPlace = {
  providerPlaceId: string;
  name: string;
  addressText: string;
  lat: number;
  lng: number;
  rating: number | null;
  ratingCount: number;
  businessStatus: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';
  /** Weekly hours, minutes-of-day, local place time. */
  hours: { dayOfWeek: number; openMinute: number; closeMinute: number; isOvernight: boolean }[];
  priceLevel: number | null;
  /**
   * Provider's primary category (`restaurant`, `karaoke`, …). Stored because a
   * change here is the clearest sign a place changed hands: a name can be
   * rewritten by the same owner, a restaurant turning into a karaoke bar cannot.
   */
  primaryType: string | null;
  /**
   * Every type the provider assigns, `primaryType` included. Google mixes
   * specific types with generic parents (`cafe`, `coffee_shop`, `food`,
   * `point_of_interest`) and does not promise an order, so a reader must pick
   * deterministically rather than trust position — see
   * `ingestion/domain/google-types.ts`.
   */
  types: string[];
  /** Provider's own canonical link to the place, when it published one. */
  googleMapsUri: string | null;
  photos: ProviderPhotoRef[];
  /** The tier this snapshot was fetched at; fields outside it are absent. */
  fetchTier: PlaceFetchTier;
  attribution: string;
  raw: unknown;
};

export interface PlaceProviderPort {
  /** Resolve a shared maps URL to a provider place id, or null when invalid. */
  resolveUrl(url: string): Promise<string | null>;
  /**
   * Fetch canonical details; null when the place does not exist.
   *
   * `tier` decides how much is asked for, and therefore what it costs
   * (ADR-0006 §2). It defaults to `quality` because every current caller
   * resolves a place in order to keep it: asking for `core` first would mean
   * two billed calls for one row, which is the opposite of what the tiers are
   * for.
   */
  details(providerPlaceId: string, tier?: PlaceFetchTier): Promise<ResolvedProviderPlace | null>;
}

export type AreaPrediction = {
  key: string;
  description: string;
  lat?: number | undefined;
  lng?: number | undefined;
};

export interface AreaAutocompletePort {
  /** sessionToken groups keystrokes for provider billing (FR-PLACE-007). */
  suggest(query: string, sessionToken: string): Promise<AreaPrediction[]>;
}

export interface PushPort {
  send(
    deviceToken: string,
    payload: { title: string; body: string; data?: Record<string, string> },
  ): Promise<void>;
}

/**
 * SG-009 (#48) — natural-language feedback into structured constraints.
 *
 * The only thing AI is allowed to do here. It does not choose places, it does
 * not score, and its output is a *proposal* that the deterministic validator
 * then accepts or throws away. `raw` is whatever the provider returned, before
 * any of that: parsing it is the caller's job, precisely so a malformed
 * response is a rejection rather than an exception in the middle of a plan.
 */
export type FeedbackParseInput = {
  /** The member's own words. Never accompanied by who wrote them. */
  text: string;
  /** Verified candidate ids the proposal may reference, and nothing else. */
  allowedPlaceIds: string[];
  /** Structured facts only — no free text from the room, no identities. */
  facts: {
    budgetMode: 'total' | 'per_person';
    budgetAmount: number;
    currency: string;
    categoryKeys: string[];
  };
};

export interface FeedbackParserPort {
  /** Provider name + version, recorded on every run for audit and A/B. */
  readonly modelVersion: string;
  parse(input: FeedbackParseInput, signal?: AbortSignal): Promise<unknown>;
}

export const FEEDBACK_PARSER = Symbol('FEEDBACK_PARSER');

export interface StoragePort {
  presignUpload(
    key: string,
    contentType: string,
  ): Promise<{ url: string; expiresInSeconds: number }>;
}

export class ProviderUnavailableError extends Error {
  constructor(provider: string, cause?: unknown) {
    super(`provider ${provider} unavailable`, { cause });
    this.name = 'ProviderUnavailableError';
  }
}

export const PLACE_PROVIDER = Symbol('PLACE_PROVIDER');
export const AREA_AUTOCOMPLETE = Symbol('AREA_AUTOCOMPLETE');
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export type SheetTab = { title: string; index: number };

export class SheetAccessError extends Error {
  constructor(
    readonly code:
      | 'SHEET_URL_INVALID'
      | 'SHEET_NOT_FOUND'
      | 'SHEET_PERMISSION_DENIED'
      | 'SHEET_TAB_NOT_FOUND'
      | 'SHEET_TOO_LARGE'
      | 'SHEET_UNAVAILABLE'
      // PI-BE-021: GoGo has no working Sheets credential — nothing about the
      // caller's spreadsheet is known, and nothing they do to it will help.
      // Distinct from SHEET_NOT_FOUND and SHEET_PERMISSION_DENIED, which are
      // both statements about their document.
      | 'SHEET_PROVIDER_NOT_CONFIGURED',
    message: string,
    /**
     * PI-BE-022 — the provider's own machine-readable reason, when it gave one
     * (Google: `error.details[].reason` on a `google.rpc.ErrorInfo`).
     *
     * Diagnostic only. `message` is what a caller may read; this is what an
     * operator needs to tell SERVICE_DISABLED from a sheet nobody shared, and
     * it rides the 5xx log through AppError's cause. Never a credential, and
     * never merged into `message`.
     */
    readonly providerReason?: string,
  ) {
    super(message);
    this.name = 'SheetAccessError';
  }
}

/**
 * PI-BE-012 — Google Sheets as an import source. Values only, bounded reads,
 * and credentials never leave the adapter (spec §10.2, §12).
 */
export interface SheetsPort {
  listTabs(spreadsheetId: string): Promise<SheetTab[]>;
  /** Rows of raw cell text, capped at `maxRows` data rows plus the header. */
  readTab(spreadsheetId: string, title: string, maxRows: number): Promise<string[][]>;
}

/** Raised when the provider refuses further calls (quota/rate limit). */
export class ProviderQuotaExceededError extends Error {
  constructor(provider: string, cause?: unknown) {
    super(`provider ${provider} quota exceeded`, { cause });
    this.name = 'ProviderQuotaExceededError';
  }
}

export const SHEETS_PROVIDER = Symbol('SHEETS_PROVIDER');

export type LatLng = { lat: number; lng: number };

/** One leg. `null` when the provider could not route this pair. */
export type TravelLeg = { minutes: number; distanceM: number };

/**
 * ADR-0007 — travel time between two points.
 *
 * Shaped as one origin to many destinations because that is what the itinerary
 * optimizer asks for: it picks stops greedily, so at each step it needs the
 * legs from the stop just chosen to every remaining candidate. Batching per
 * step keeps four provider calls per plan instead of thirty-four, without
 * paying for the full origins × destinations rectangle a matrix prefetch would
 * bill for.
 */
export interface TravelTimePort {
  matrix(origin: LatLng, destinations: LatLng[]): Promise<(TravelLeg | null)[]>;
}

export const TRAVEL_TIME_PROVIDER = Symbol('TRAVEL_TIME_PROVIDER');

/**
 * #247 — what one background queue looks like from outside it.
 *
 * `null` where the number is genuinely unknown rather than zero. An empty
 * queue and a queue nobody could measure are different facts, and a dashboard
 * that renders both as `0` is worse than one that renders nothing: it reports
 * calm during an outage.
 */
export type QueueStats = {
  name: string;
  /** Where the numbers came from, so the console can say so. */
  /** `bullmq` is retained in the contract for older clients; nothing emits it since GoGo-BE#265. */
  source: 'bullmq' | 'database';
  pending: number;
  running: number;
  /** Failures finished within the last 24 hours. */
  failed24h: number;
  /**
   * True when the failed scan hit its cap, so `failed24h` is a floor rather
   * than a count. A truncated number that does not say it is truncated is the
   * kind of thing an incident review discovers afterwards.
   */
  failed24hTruncated: boolean;
  /** Jobs that will not be retried again. */
  deadLetter: number;
  /** Age of the oldest thing still waiting; `null` when nothing waits. */
  oldestPendingSeconds: number | null;
  /** Consumers currently connected. Zero on a queue with work is the alarm. */
  workers: number | null;
};

// ─── GEO-001 — multi-provider geo ────────────────────────────────────────────
//
// Everything below exists because `PlaceProviderPort` above was shaped around
// one provider that answers two questions (resolve a URL, fetch details), and
// the alternative-maps POC needs providers that also search, autocomplete and
// reverse-geocode. See `gogo-alternative-maps-integration-poc-spec.md` §7–§8,
// §18.
//
// Deliberately *not* a separate `geo` module: adapters live beside the ones
// they replace, so the day a provider is swapped there is one place to look.

/**
 * Who answered. Stored on candidates and on `place_provider_sources.provider`,
 * so the value is a wire/DB identifier — renaming one is a migration.
 *
 * `google_places` is here for the rows that already exist. Spec §7.3 forbids
 * *adding* Google as a place-metadata provider in this POC; it does not
 * un-write the catalog GoGo already imported through it.
 */
export type PlaceProviderId = 'google_places' | 'vietmap' | 'foursquare';

/**
 * Spec §7.3 lists only `vietmap`, which is true of what the POC *adds*. The
 * other two are what production answers with today — `haversine` included,
 * because a straight-line estimate is a real answer this system gives and
 * metrics that pretend otherwise would under-count the fallback path.
 */
export type RouteProviderId = 'vietmap' | 'google_routes' | 'haversine';

/**
 * One provider's opinion about a place, normalized. Not a GoGo place: nothing
 * here is canonical until the resolver has scored it (`match-score.ts`).
 *
 * Every field past `providerPlaceId` is optional because providers disagree
 * about what a search result contains — VIETMAP Search v4 routinely omits
 * coordinates, which is why `getDetails` exists as a second, separately billed
 * step (spec §10.1, §27).
 */
export type ProviderPlaceCandidate = {
  provider: PlaceProviderId;
  providerPlaceId: string;
  name: string;
  formattedAddress?: string | undefined;
  location?: LatLng | undefined;
  categories?: { id?: string | undefined; name: string }[] | undefined;
  /** Provider's own distance from the search focus, when it computed one. */
  distanceMeters?: number | undefined;
  /** Provider's own relevance number. Not comparable across providers. */
  providerScore?: number | undefined;
  /**
   * Dev/debug only (spec §8). Never serialized into a `/v1` response, never
   * persisted by default, and never contains a credential — the adapter strips
   * the request before it gets here.
   */
  raw?: unknown;
};

/** Details are the same shape; the difference is what the provider was paid for. */
export type ProviderPlaceDetails = ProviderPlaceCandidate;

export type PlaceSearchInput = {
  text: string;
  /** Biases ranking toward a point; not a hard filter. */
  focus?: LatLng | undefined;
  radiusMeters?: number | undefined;
  limit?: number | undefined;
};

export type PlaceAutocompleteInput = {
  text: string;
  focus?: LatLng | undefined;
  limit?: number | undefined;
};

export type ReverseGeocodeInput = LatLng & { limit?: number | undefined };

/**
 * Search-capable place provider.
 *
 * The three methods are optional rather than required, and that is the whole
 * design: `GooglePlacesAdapter` implements none of them and must stay a valid
 * `PlaceProviderPort`, because the POC is not allowed to change what production
 * does while `FLAG_ALT_MAPS_POC` is off. A caller asks `supportsSearch()` and
 * gets a truthful answer instead of a method that throws.
 */
export interface GeoPlaceProviderPort extends PlaceProviderPort {
  readonly providerId: PlaceProviderId;
  search?(input: PlaceSearchInput, signal?: AbortSignal): Promise<ProviderPlaceCandidate[]>;
  autocomplete?(
    input: PlaceAutocompleteInput,
    signal?: AbortSignal,
  ): Promise<ProviderPlaceCandidate[]>;
  reverse?(input: ReverseGeocodeInput, signal?: AbortSignal): Promise<ProviderPlaceCandidate[]>;
}

export type SearchCapableProvider = GeoPlaceProviderPort &
  Required<Pick<GeoPlaceProviderPort, 'search'>>;

export function supportsSearch(p: GeoPlaceProviderPort): p is SearchCapableProvider {
  return typeof p.search === 'function';
}

export const GEO_PLACE_PROVIDERS = Symbol('GEO_PLACE_PROVIDERS');

/** Spec §18 — every provider failure becomes one of these, or it is a bug. */
export type GeoProviderErrorCode =
  | 'INVALID_REQUEST'
  | 'AUTH_FAILED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'BAD_UPSTREAM_RESPONSE';

/**
 * Which failures are worth asking about again (spec §17).
 *
 * `BAD_UPSTREAM_RESPONSE` is not retryable on purpose: a body that did not
 * parse will not parse on the second attempt either, and retrying it turns one
 * provider bug into two billed calls.
 */
const RETRYABLE: ReadonlySet<GeoProviderErrorCode> = new Set([
  'RATE_LIMITED',
  'TIMEOUT',
  'UPSTREAM_UNAVAILABLE',
]);

export function isRetryableGeoCode(code: GeoProviderErrorCode): boolean {
  return RETRYABLE.has(code);
}

/**
 * HTTP status → error code, per spec §17's retry table.
 *
 * 408/429/5xx retry; 400/401/403/404 never do. Anything else in the 4xx range
 * is the caller's fault by elimination, so it is `INVALID_REQUEST` and stays
 * un-retried — the alternative is hammering a provider over a request it has
 * already told us it will not accept.
 */
export function geoErrorCodeForStatus(status: number): GeoProviderErrorCode {
  if (status === 400) return 'INVALID_REQUEST';
  if (status === 401) return 'AUTH_FAILED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 408) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_UNAVAILABLE';
  if (status >= 400) return 'INVALID_REQUEST';
  return 'BAD_UPSTREAM_RESPONSE';
}

/**
 * A provider failure, already classified.
 *
 * `message` is deliberately built from the code and the provider name only. The
 * upstream body never reaches it: spec §18 forbids leaking provider responses
 * to public clients, and an error message is the easiest place for one to
 * escape. Whatever the upstream said travels as `cause`, for logs.
 */
export class GeoProviderError extends Error {
  readonly provider: PlaceProviderId | RouteProviderId;
  readonly code: GeoProviderErrorCode;
  readonly upstreamStatus: number | undefined;
  readonly retryable: boolean;
  /** From `Retry-After`, when the provider said how long to wait. */
  readonly retryAfterMs: number | undefined;

  constructor(
    provider: PlaceProviderId | RouteProviderId,
    code: GeoProviderErrorCode,
    options: { upstreamStatus?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(`geo provider ${provider} failed: ${code}`, { cause: options.cause });
    this.name = 'GeoProviderError';
    this.provider = provider;
    this.code = code;
    this.upstreamStatus = options.upstreamStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = isRetryableGeoCode(code);
  }

  static fromStatus(
    provider: PlaceProviderId | RouteProviderId,
    status: number,
    options: { retryAfterMs?: number; cause?: unknown } = {},
  ): GeoProviderError {
    return new GeoProviderError(provider, geoErrorCodeForStatus(status), {
      upstreamStatus: status,
      ...options,
    });
  }
}

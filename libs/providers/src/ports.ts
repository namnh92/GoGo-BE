/**
 * BE-BFF-011 — provider ports. Domain and BFF code depend only on these
 * interfaces; concrete adapters (Google, R2, FCM/APNs) and fakes are bound by
 * the app based on configuration. No SDK types leak past this file.
 */

/**
 * ADR-0006 §2 / plan §2.4 — how much of a place to pay for.
 *
 * `liveness` asks only *which id this is now* and is billed at Google's
 * IDs-Only SKU, which is free; `core` identifies a place (Pro); `quality` adds
 * the facts a preview or a catalog row needs (Enterprise); `detail` adds
 * reviews (Enterprise + Atmosphere) and is never requested by a bulk job. The
 * tier a snapshot was taken at is recorded on `place_provider_sources`, so a
 * row always says which fields it could legitimately have.
 *
 * The gap between `liveness` and `core` is a factor of infinity, and between
 * `core` and `quality` a factor of 20/17 on every single call. There is no
 * cheaper tier hiding between them: `businessStatus` is a Pro field, so a
 * "just tell me if it is open" tier would be billed exactly as `core` is.
 */
export type PlaceFetchTier = 'liveness' | 'core' | 'quality' | 'detail';

/**
 * The tiers that actually describe a place.
 *
 * `liveness` is deliberately outside this union. A liveness answer carries no
 * name, no coordinates and no status, so anything that stores, scores or shows
 * a place must ask for a tier that can supply those — and the compiler, not a
 * reviewer, is what says so. It is also the type `place_provider_sources`
 * persists: a row fetched at `liveness` has nothing to persist.
 */
export type PlaceDescriptionTier = Exclude<PlaceFetchTier, 'liveness'>;

/**
 * All a `liveness` fetch can tell you: this id still resolves, and where the
 * provider has moved it to.
 *
 * A separate type rather than a mostly-empty `ResolvedProviderPlace`, because
 * the alternative is a `ratingCount: 0` on a place whose rating was never
 * requested — "unknown" written as "zero", which is the exact failure the tier
 * system exists to make impossible.
 *
 * Two independent signals for a move, and PR7 wants both. `movedPlaceId` is
 * Google saying so outright; `requestedProviderPlaceId` is Google answering
 * about a successor without saying so, which is what #334 detects by comparing
 * ids. A place can present either, and treating one as a substitute for the
 * other would miss half the moves.
 */
export type ProviderPlaceIdentity = {
  providerPlaceId: string;
  /** Set only when the provider answered about a different id — see below. */
  requestedProviderPlaceId?: string;
  /**
   * The successor the provider names for this id, when it names one.
   *
   * `movedPlaceId` is a Place Details Essentials IDs-Only field, so asking for
   * it costs nothing — it does not lift the request off the free SKU. Nothing
   * repoints a GoGo place on it: PR7 records it as `moved_to_external_id`,
   * marks the source `moved` and routes the place to review (plan §2.5).
   */
  movedPlaceId?: string;
  fetchTier: 'liveness';
};

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
  /**
   * The id that was asked for, when it differs from the one that came back.
   *
   * Details follows a place that moved or was merged to its successor, so the
   * provider can legitimately answer about a different id than the request
   * named. Callers must be able to see that: silently storing the new id
   * repoints a GoGo place on Google's say-so, and silently keeping the old one
   * stores an identity the provider no longer serves. Absent when the two
   * agree, which is the ordinary case (#334).
   */
  requestedProviderPlaceId?: string;
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
  fetchTier: PlaceDescriptionTier;
  attribution: string;
  raw: unknown;
};

export interface PlaceProviderPort {
  /** Resolve a shared maps URL to a provider place id, or null when invalid. */
  resolveUrl(url: string): Promise<string | null>;
  /**
   * Top provider ids for a free-text query, best first.
   *
   * Distinct from `resolveUrl` because the two callers want different things:
   * a bulk import row wants one answer, a shared link wants the alternatives to
   * offer when the match is ambiguous. Collapsing them to `places[0]` made
   * `MULTIPLE_BRANCHES` unreachable from a link and handed the user whichever
   * branch Google ranked first, silently (spec §6.2 steps 7/9, #311).
   */
  searchCandidates(query: string, limit: number): Promise<string[]>;
  /**
   * Fetch canonical details; null when the place does not exist.
   *
   * `tier` decides how much is asked for, and therefore what it costs
   * (ADR-0006 §2, plan §2.4). It has **no default** on purpose (#338): the
   * default used to be `quality`, so every caller that never thought about
   * cost silently bought Google's most expensive Details SKU — including the
   * bulk resolver, which reads a name, an address, a coordinate and a type and
   * throws the rating away. A required argument is what turns "which tier does
   * this path need?" from a question a reviewer might ask into one the
   * compiler always asks.
   *
   * The return type narrows with the tier, so a `liveness` caller cannot read
   * a rating that was never fetched.
   */
  details(providerPlaceId: string, tier: 'liveness'): Promise<ProviderPlaceIdentity | null>;
  details(
    providerPlaceId: string,
    tier: PlaceDescriptionTier,
  ): Promise<ResolvedProviderPlace | null>;
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

/**
 * #273 — the provider cannot be used, and no amount of waiting or retrying
 * changes that: the API is not enabled on our project, the key is invalid, or
 * its restrictions forbid this call.
 *
 * Distinct from `ProviderUnavailableError`, which says "upstream is having a
 * bad time, try later" — the sentence a runbook acts on by waiting. Reporting
 * a configuration fault as an outage is how an API nobody enabled turns into a
 * breaker that opens and closes forever with no one asking why.
 *
 * Never carries the credential. `providerReason` is Google's own reason code
 * (`SERVICE_DISABLED`, `API_KEY_SERVICE_BLOCKED`, …) — a fact about our
 * console, safe to log, and the only thing that tells an operator which
 * console page to open.
 */
/**
 * The provider understood the request and rejected it: the input is wrong, and
 * it will be just as wrong on the next attempt.
 *
 * #314 — a place id Google answers `INVALID_ARGUMENT` to used to become a bare
 * `Error`, which `withResilience` retried twice and then wrapped as an outage.
 * A link a user pasted wrong was reported to them as GoGo being down, burned
 * three Google calls doing it, and raised an operational alert about a fault
 * on our side that did not exist.
 *
 * Deliberately not a subclass of the operational errors: the whole point is
 * that this one is *not* an outage. Callers turn it into a business result.
 */
/**
 * Reading metrics back out of the time-series store (#315).
 *
 * The mirror of `ProviderMetrics`: that writes samples, this asks questions
 * about samples already written. Separate ports because they are separate
 * credentials with separate scopes — the collector holds `metrics:write` and
 * cannot read, GoGo-BE holds `metrics:read` and cannot write.
 *
 * A port rather than a Grafana client passed around directly, so the CMS
 * service can be tested against fixtures and so swapping Mimir for anything
 * else that speaks the Prometheus HTTP API is a binding change.
 */
export type PromSample = { labels: Record<string, string>; value: number };
export type PromPoint = { t: number; v: number };
export type PromSeries = { labels: Record<string, string>; points: PromPoint[] };

export interface MetricsQueryPort {
  /** Instant query. One value per matching series. */
  query(promql: string): Promise<PromSample[]>;
  /** Range query over `[start, end]` at `stepSeconds`. */
  queryRange(promql: string, start: Date, end: Date, stepSeconds: number): Promise<PromSeries[]>;
}

/**
 * The store answered, but not with something usable — bad status, unparseable
 * body, a Prometheus-level `status: "error"`.
 *
 * Distinct from `ProviderUnavailableError` so the CMS layer can tell "the
 * monitoring backend is down" from "the monitoring backend rejected our
 * query", and so neither ever reaches a browser as raw text.
 */
export const METRICS_QUERY = Symbol('METRICS_QUERY');

export class MetricsQueryError extends Error {
  constructor(
    /** Bounded: a short classification, never the store's own message. */
    readonly reason: 'unauthorized' | 'bad_request' | 'upstream' | 'malformed',
    cause?: unknown,
  ) {
    super(`metrics query failed (${reason})`, { cause });
    this.name = 'MetricsQueryError';
  }
}

/**
 * The slice of `MetricsPort` an adapter needs.
 *
 * Structural, not imported: `libs/providers` deliberately depends on no
 * `@gogo/*` package, so an adapter states the shape it wants and any
 * conforming object satisfies it. Declared once here because the same literal
 * had already been written out twice, and a third copy was about to appear.
 */
export type ProviderMetrics = {
  increment(name: string, labels?: Record<string, string | number | undefined>, by?: number): void;
  observe(name: string, value: number, labels?: Record<string, string | number | undefined>): void;
};

/** Default for every adapter: measure nothing rather than require a sink. */
export const NO_PROVIDER_METRICS: ProviderMetrics = {
  increment: () => undefined,
  observe: () => undefined,
};

export class ProviderInvalidRequestError extends Error {
  constructor(
    readonly provider: string,
    /** Google's canonical status — `INVALID_ARGUMENT` or `NOT_FOUND`. */
    readonly canonicalStatus: string,
    cause?: unknown,
  ) {
    super(`provider ${provider} rejected the request (${canonicalStatus})`, { cause });
    this.name = 'ProviderInvalidRequestError';
  }
}

export class ProviderConfigurationError extends Error {
  constructor(
    readonly provider: string,
    /** Normalized for the ops signal; `providerReason` keeps the detail. */
    readonly faultCode: 'MISSING_CREDENTIAL' | 'AUTH_FAILED',
    readonly providerReason?: string,
    cause?: unknown,
  ) {
    super(`provider ${provider} misconfigured (${faultCode})`, { cause });
    this.name = 'ProviderConfigurationError';
  }
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

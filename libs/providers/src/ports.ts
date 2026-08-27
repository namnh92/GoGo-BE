/**
 * BE-BFF-011 — provider ports. Domain and BFF code depend only on these
 * interfaces; concrete adapters (Google, R2, FCM/APNs) and fakes are bound by
 * the app based on configuration. No SDK types leak past this file.
 */

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
  attribution: string;
  raw: unknown;
};

export interface PlaceProviderPort {
  /** Resolve a shared maps URL to a provider place id, or null when invalid. */
  resolveUrl(url: string): Promise<string | null>;
  /** Fetch canonical details; null when the place does not exist. */
  details(providerPlaceId: string): Promise<ResolvedProviderPlace | null>;
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
      | 'SHEET_UNAVAILABLE',
    message: string,
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

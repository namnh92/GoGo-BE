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

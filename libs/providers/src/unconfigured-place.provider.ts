import {
  ProviderConfigurationError,
  type AreaAutocompletePort,
  type AreaPrediction,
  type PlaceProviderPort,
  type ResolvedProviderPlace,
} from './ports';

/**
 * #279 — bound when this process is supposed to be talking to Google and has
 * no credential to do it with.
 *
 * The alternative, and what shipped before, was to bind `FakePlaceProvider`.
 * That fake answers a real Google Maps link with "no such place", so a missing
 * secret arrived at a user as a statement about the place they pasted. The
 * fake is a perfectly good stand-in for a Google we are *not meant* to be
 * calling; it is a liar about a Google we are.
 *
 * So this one refuses instead of inventing, and refuses in the vocabulary the
 * HTTP layer already knows how to turn into `503 PLACE_PROVIDER_UNAVAILABLE`.
 * Boot is not blocked: the rest of the product — catalog search, rooms, plans
 * on existing places — has nothing to do with this port, and taking the whole
 * API down over it would turn one broken feature into an outage.
 */
export class UnconfiguredPlaceProvider implements PlaceProviderPort, AreaAutocompletePort {
  constructor(private readonly provider = 'google.places') {}

  private refuse(): never {
    throw new ProviderConfigurationError(this.provider, 'MISSING_CREDENTIAL');
  }

  async resolveUrl(_url: string): Promise<string | null> {
    this.refuse();
  }

  async details(_providerPlaceId: string): Promise<ResolvedProviderPlace | null> {
    this.refuse();
  }

  async suggest(_query: string, _sessionToken: string): Promise<AreaPrediction[]> {
    this.refuse();
  }
}

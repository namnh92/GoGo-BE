import { describe, expect, it } from 'vitest';
import {
  ProviderConfigurationError,
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  UnconfiguredPlaceProvider,
  type PlaceProviderPort,
  type ResolvedProviderPlace,
} from '@gogo/providers';
import type { Db } from '@gogo/database';
import { PlaceResolverService } from './place-resolver.service';
import { placeProviderUnavailable } from './place-submission.service';
import { AppError } from '../../shared/app-error';

/** The resolver only touches the db in scoring, which these cases never reach. */
const db = {} as Db;

/** The exact link from the Mobile Add Place report that started #279. */
const LACAPH =
  'https://www.google.com/maps/search/?api=1&query=Lacaph+Coffee+Experiences+Space+Ho+Chi+Minh+City';

function providerThat(behaviour: Partial<PlaceProviderPort>): PlaceProviderPort {
  return {
    resolveUrl: async () => null,
    details: async () => null,
    ...behaviour,
  } as PlaceProviderPort;
}

const A_REAL_PLACE: ResolvedProviderPlace = {
  providerPlaceId: 'ChIJlacaph',
  name: 'Lacaph Coffee Experiences Space',
  addressText: '5 Nguyễn Thiệp, Bến Nghé, Quận 1',
  lat: 10.7756,
  lng: 106.7038,
  rating: 4.7,
  ratingCount: 412,
  businessStatus: 'OPERATIONAL',
  hours: [],
  priceLevel: 2,
  primaryType: 'cafe',
  types: ['cafe', 'coffee_shop', 'food', 'point_of_interest', 'establishment'],
  googleMapsUri: 'https://maps.google.com/?cid=ChIJlacaph',
  photos: [],
  fetchTier: 'quality',
  attribution: 'Data © Google',
  raw: {},
};

describe('#279 — a provider that cannot answer is not a place that does not exist', () => {
  it('still reports a genuine miss as UNRESOLVED / NOT_FOUND', async () => {
    // Google answered, and the answer was "nothing here". Unchanged contract.
    const resolver = new PlaceResolverService(providerThat({ resolveUrl: async () => null }), db);

    await expect(resolver.resolveFromUrl(LACAPH)).resolves.toMatchObject({
      status: 'UNRESOLVED',
      reasonCode: 'NOT_FOUND',
    });
  });

  it('resolves normally when the provider works', async () => {
    const resolver = new PlaceResolverService(
      providerThat({
        resolveUrl: async () => 'ChIJlacaph',
        details: async () => A_REAL_PLACE,
      }),
      db,
    );

    const outcome = await resolver.resolveFromUrl(LACAPH, { name: A_REAL_PLACE.name });
    expect(outcome.status).not.toBe('UNRESOLVED');
  });

  it('does not turn a disabled API into NOT_FOUND', async () => {
    const resolver = new PlaceResolverService(
      providerThat({
        resolveUrl: async () => {
          throw new ProviderConfigurationError('google.places', 'AUTH_FAILED', 'SERVICE_DISABLED');
        },
      }),
      db,
    );

    // The regression this whole issue is about: this used to resolve to
    // UNRESOLVED/NOT_FOUND with a 201, and Mobile printed it as a fact about
    // the user's place.
    await expect(resolver.resolveFromUrl(LACAPH)).rejects.toBeInstanceOf(
      ProviderConfigurationError,
    );
  });

  it('does not turn a missing credential into NOT_FOUND', async () => {
    const resolver = new PlaceResolverService(new UnconfiguredPlaceProvider(), db);

    await expect(resolver.resolveFromUrl(LACAPH)).rejects.toMatchObject({
      faultCode: 'MISSING_CREDENTIAL',
    });
  });

  it('does not turn an upstream outage into NOT_FOUND', async () => {
    const resolver = new PlaceResolverService(
      providerThat({
        resolveUrl: async () => {
          throw new ProviderUnavailableError('google.places');
        },
      }),
      db,
    );

    await expect(resolver.resolveFromUrl(LACAPH)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('still propagates quota, as it always did', async () => {
    const resolver = new PlaceResolverService(
      providerThat({
        resolveUrl: async () => {
          throw new ProviderQuotaExceededError('google.places');
        },
      }),
      db,
    );

    await expect(resolver.resolveFromUrl(LACAPH)).rejects.toBeInstanceOf(
      ProviderQuotaExceededError,
    );
  });

  it('a provider that resolves but cannot fetch details is still not a miss', async () => {
    const resolver = new PlaceResolverService(
      providerThat({
        resolveUrl: async () => 'ChIJlacaph',
        details: async () => {
          throw new ProviderConfigurationError('google.places', 'AUTH_FAILED', 'SERVICE_DISABLED');
        },
      }),
      db,
    );

    await expect(resolver.resolveFromUrl(LACAPH)).rejects.toBeInstanceOf(
      ProviderConfigurationError,
    );
  });
});

describe('#279 — the HTTP answer for an operational failure', () => {
  const cases = [
    [
      'configuration',
      new ProviderConfigurationError('google.places', 'AUTH_FAILED', 'SERVICE_DISABLED'),
    ],
    ['missing credential', new ProviderConfigurationError('google.places', 'MISSING_CREDENTIAL')],
    ['quota', new ProviderQuotaExceededError('google.places')],
    ['upstream', new ProviderUnavailableError('google.places')],
  ] as const;

  it.each(cases)('maps a %s fault to 503 PLACE_PROVIDER_UNAVAILABLE', (_label, err) => {
    const mapped = placeProviderUnavailable(err);

    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.httpStatus).toBe(503);
    expect(mapped.code).toBe('PLACE_PROVIDER_UNAVAILABLE');
    expect(mapped.options.retryable).toBe(true);
  });

  it('tells the client nothing about which provider or secret failed', () => {
    const mapped = placeProviderUnavailable(
      new ProviderConfigurationError('google.places', 'AUTH_FAILED', 'SERVICE_DISABLED'),
    );

    // The envelope is built from code + message. Neither may name Google, the
    // adapter, the variable, or the reason — those ride `cause` into the log.
    const envelope = `${mapped.code} ${mapped.message}`;
    expect(envelope).not.toMatch(/google|SERVICE_DISABLED|API_KEY|places\./i);
    expect(mapped.options.cause).toBeInstanceOf(ProviderConfigurationError);
  });

  it('leaves a non-provider failure alone', () => {
    const original = AppError.badRequest('SOMETHING_ELSE', 'not a provider problem');

    expect(placeProviderUnavailable(original)).toBe(original);
  });
});

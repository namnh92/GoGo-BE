import {
  ProviderConfigurationError,
  ProviderInvalidRequestError,
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  type LatLng,
  type TravelLeg,
  type TravelTimePort,
} from './ports';
import { googleFailure, readGoogleError } from './google-error';
import { withResilience } from './resilience';

const RESILIENCE = {
  timeoutMs: 8000,
  retries: 1,
  breakerThreshold: 5,
  breakerCooldownMs: 30_000,
};

type MatrixElement = {
  originIndex?: number;
  destinationIndex?: number;
  duration?: string;
  distanceMeters?: number;
  condition?: string;
};

/**
 * ADR-0007 — Google Routes, Compute Route Matrix.
 *
 * Billed per element (`origins × destinations`), so the caller batches one
 * origin against the remaining candidates rather than asking for a full
 * rectangle it will not use.
 *
 * `routingPreference` is deliberately left unset: `TRAFFIC_AWARE` moves the
 * request into the Pro tier with a smaller free cap, and at MVP road travel
 * time alone already removes most of the error against a straight line.
 * Turning it on is a budget decision, recorded as an amendment when real usage
 * says it is worth it.
 */
export class GoogleRoutesAdapter implements TravelTimePort {
  constructor(
    private readonly apiKey: string,
    private readonly metrics: {
      increment(
        name: string,
        labels?: Record<string, string | number | undefined>,
        by?: number,
      ): void;
      observe(
        name: string,
        value: number,
        labels?: Record<string, string | number | undefined>,
      ): void;
    } = { increment: () => undefined, observe: () => undefined },
  ) {}

  async matrix(origin: LatLng, destinations: LatLng[]): Promise<(TravelLeg | null)[]> {
    if (destinations.length === 0) return [];

    const body = {
      origins: [waypoint(origin)],
      destinations: destinations.map(waypoint),
      travelMode: 'DRIVE',
    };

    const elements = await withResilience(
      { name: 'google.routeMatrix', ...RESILIENCE },
      async (signal) => {
        const started = Date.now();
        const res = await fetch(
          'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
          {
            method: 'POST',
            body: JSON.stringify(body),
            signal,
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': this.apiKey,
              'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition',
            },
          },
        );
        this.metrics.increment('places_provider_requests_total', {
          method: 'google.routeMatrix',
          status: res.status,
        });
        this.metrics.observe('place_provider_request_duration_ms', Date.now() - started, {
          method: 'google.routeMatrix',
          status: res.status,
        });
        // Elements, not requests, are the billed unit — count what we are
        // actually charged for, or the cost metric lies as batches grow.
        //
        // #313: the element count is the amount to add, not a label. As a label
        // it did neither job — the counter still moved by one per call, so it
        // counted requests and not elements exactly as the comment warns
        // against, and it split into a separate series per batch size.
        if (res.ok) {
          this.metrics.increment(
            'places_provider_cost_units',
            { sku: 'routes.computeRouteMatrix' },
            destinations.length,
          );
        }
        if (res.ok) return (await res.json()) as MatrixElement[];

        // #273: Routes not being enabled on the project is a permanent answer.
        // Presented as an outage it produced a breaker that opened and closed
        // on a cycle while the itinerary silently used straight-line estimates.
        const info = await readGoogleError(res);
        const fault = googleFailure('google.routes', res.status, info);

        // #314: a rejected request is not Google failing to serve us.
        if (fault instanceof ProviderInvalidRequestError) {
          this.metrics.increment('places_provider_rejected_total', {
            method: 'google.routeMatrix',
            canonical_status: fault.canonicalStatus,
          });
          throw fault;
        }

        this.metrics.increment('places_provider_failures_total', {
          method: 'google.routeMatrix',
          status: res.status,
          reason: info.reason ?? 'unknown',
        });
        if (fault) throw fault;
        throw new Error(`routes ${res.status}`);
      },
    ).catch((err: unknown) => {
      if (err instanceof ProviderQuotaExceededError) throw err;
      if (err instanceof ProviderConfigurationError) throw err;
      if (err instanceof ProviderInvalidRequestError) throw err;
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof ProviderQuotaExceededError) throw cause;
      if (cause instanceof ProviderConfigurationError) throw cause;
      if (cause instanceof ProviderInvalidRequestError) throw cause;
      throw err instanceof ProviderUnavailableError
        ? err
        : new ProviderUnavailableError('google.routes', err);
    });

    // The API may return elements out of order and may omit unroutable pairs,
    // so results are placed by index rather than by arrival order.
    const legs: (TravelLeg | null)[] = destinations.map(() => null);
    for (const element of elements) {
      const index = element.destinationIndex;
      if (index === undefined || index < 0 || index >= legs.length) continue;
      if (element.condition && element.condition !== 'ROUTE_EXISTS') continue;
      const seconds = Number.parseInt(element.duration ?? '', 10);
      if (Number.isNaN(seconds)) continue;
      legs[index] = {
        minutes: Math.ceil(seconds / 60),
        distanceM: element.distanceMeters ?? 0,
      };
    }
    return legs;
  }
}

function waypoint(point: LatLng) {
  return { waypoint: { location: { latLng: { latitude: point.lat, longitude: point.lng } } } };
}

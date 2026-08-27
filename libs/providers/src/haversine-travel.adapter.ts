import type { LatLng, TravelLeg, TravelTimePort } from './ports';

const TRAVEL_SPEED_M_PER_MIN = 400; // ~24 km/h urban incl. parking buffer
const TRAVEL_BUFFER_MIN = 10;
const EARTH_RADIUS_M = 6_371_000;

function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * ADR-0007 — straight-line estimate behind the travel port.
 *
 * This is both the default (the Routes flag starts off) and the permanent
 * fallback for quota exhaustion and provider outages, so it stays in the code
 * for good rather than being replaced. Callers must present its output as an
 * estimate: in Ho Chi Minh City traffic a straight line understates real travel
 * badly, and core rule #8 forbids showing an uncertain number as a fact.
 */
export class HaversineTravelTime implements TravelTimePort {
  async matrix(origin: LatLng, destinations: LatLng[]): Promise<(TravelLeg | null)[]> {
    return destinations.map((to) => {
      const distanceM = Math.round(haversineMeters(origin, to));
      return {
        minutes: Math.ceil(distanceM / TRAVEL_SPEED_M_PER_MIN) + TRAVEL_BUFFER_MIN,
        distanceM,
      };
    });
  }
}

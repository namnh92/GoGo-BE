import { budgetPerPerson } from '../../rooms/domain/budget';
import type { Candidate, RoomSnapshot } from './types';

export type HardFilterResult = { ok: true } | { ok: false; reasonCodes: string[] };

const KM_PER_DEG_LAT = 111.32;

export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
void KM_PER_DEG_LAT;

function openDuringWindow(candidate: Candidate, startAt: Date, endAt: Date): boolean {
  // A candidate is usable when its opening hours overlap the room's window on
  // the window's (VN-local) day. Conservative: checks the start day only.
  const vnStart = new Date(startAt.getTime() + 7 * 3600 * 1000);
  const dow = vnStart.getUTCDay();
  const startMin = vnStart.getUTCHours() * 60 + vnStart.getUTCMinutes();
  const winMinutes = Math.min((endAt.getTime() - startAt.getTime()) / 60000, 24 * 60);
  const endMin = startMin + winMinutes;
  return candidate.hours.some((h) => {
    if (h.dayOfWeek !== dow) return false;
    const close = h.isOvernight ? h.closeMinute + 24 * 60 : h.closeMinute;
    // overlap between [open, close] and [startMin, endMin]
    return h.openMinute < endMin && close > startMin;
  });
}

/**
 * SG-003 — hard constraints. AI or scoring can never resurrect a candidate
 * rejected here (core rule: AI never overrides hard constraints).
 */
export function hardFilter(candidate: Candidate, snapshot: RoomSnapshot): HardFilterResult {
  const reasons: string[] = [];

  if (snapshot.origin && snapshot.radiusM) {
    const d = haversineMeters(snapshot.origin, { lat: candidate.lat, lng: candidate.lng });
    if (d > snapshot.radiusM) reasons.push('OUT_OF_AREA');
  }

  const perPerson = budgetPerPerson(
    {
      mode: snapshot.budget.mode,
      amount: snapshot.budget.amount,
      currency: snapshot.budget.currency,
    },
    snapshot.participantCount,
  );
  if (candidate.pricePerPersonMin !== null && candidate.pricePerPersonMin > perPerson) {
    reasons.push('OUT_OF_BUDGET');
  }

  if (snapshot.timeWindow.startAt && snapshot.timeWindow.endAt) {
    const start = new Date(snapshot.timeWindow.startAt);
    const end = new Date(snapshot.timeWindow.endAt);
    if (!openDuringWindow(candidate, start, end)) reasons.push('CLOSED_DURING_WINDOW');
  }

  for (const key of snapshot.dietaryKeys) {
    if (!(candidate.taxonomyKeys['dietary'] ?? []).includes(key)) {
      reasons.push('DIETARY_UNMET');
      break;
    }
  }
  for (const key of snapshot.accessibilityKeys) {
    if (!(candidate.taxonomyKeys['accessibility'] ?? []).includes(key)) {
      reasons.push('ACCESSIBILITY_UNMET');
      break;
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasonCodes: reasons };
}

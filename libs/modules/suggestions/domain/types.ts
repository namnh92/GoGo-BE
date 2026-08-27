/** SG-002 — immutable room snapshot every run is computed from. */
export type RoomSnapshot = {
  roomId: string;
  constraintVersion: number;
  type: 'couple' | 'group';
  decisionMode: 'match' | 'vote' | 'host';
  participantCount: number;
  budget: { mode: 'total' | 'per_person'; amount: number; currency: string };
  timeWindow: { startAt: string | null; endAt: string | null };
  origin: { lat: number; lng: number } | null;
  radiusM: number | null;
  dietaryKeys: string[];
  accessibilityKeys: string[];
  memberPreferences: {
    memberId: string;
    selections: Record<string, string[]>;
    weights: Record<string, number> | null;
  }[];
  seedPlaceIds: string[];
};

/** Verified candidate facts — never AI output (core rule #8). */
export type Candidate = {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  taxonomyKeys: Record<string, string[]>; // kind -> keys
  suitability: Record<string, number> | null;
  pricePerPersonMin: number | null;
  pricePerPersonMax: number | null;
  avgVisitMinutes: number | null;
  rating: number | null;
  ratingCount: number;
  confidence: number;
  freshnessDays: number | null;
  hours: {
    dayOfWeek: number;
    openMinute: number;
    closeMinute: number;
    isOvernight: boolean;
  }[];
  isSeed: boolean;
};

export type ScoredCandidate = {
  candidate: Candidate;
  score: number; // 0..1
  components: Record<string, number>;
  reasonCodes: string[];
  /** memberId -> 0..1 satisfaction, drives group fairness (SG-005). */
  memberSatisfaction: Record<string, number>;
};

export type ScoringWeights = {
  preference: number;
  consensus: number;
  distance: number;
  budget: number;
  quality: number;
  freshness: number;
  seedBoost: number;
};

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  preference: 0.3,
  consensus: 0.15,
  distance: 0.15,
  budget: 0.15,
  quality: 0.15,
  freshness: 0.05,
  seedBoost: 0.05,
};

/** SG-001: weight bounds — configs outside these are rejected. */
export const SCORING_WEIGHT_BOUNDS: Record<keyof ScoringWeights, { min: number; max: number }> = {
  preference: { min: 0.1, max: 0.5 },
  consensus: { min: 0, max: 0.3 },
  distance: { min: 0, max: 0.3 },
  budget: { min: 0.05, max: 0.3 },
  quality: { min: 0.05, max: 0.3 },
  freshness: { min: 0, max: 0.15 },
  seedBoost: { min: 0, max: 0.15 },
};

export const ENGINE_VERSION = 'sg-1.0.0';

export type PlanStopDraft = {
  placeId: string;
  name: string;
  position: number;
  arriveAt: Date | null;
  departAt: Date | null;
  durationMinutes: number;
  travelMinutesFromPrev: number | null;
  travelDistanceMFromPrev: number | null;
  costMin: number | null;
  costMax: number | null;
  isLocked: boolean;
};

export type PlanTotalsDraft = {
  costMin: number;
  costMax: number;
  currency: string;
  durationMinutes: number;
  travelDistanceM: number;
  overBudget: boolean;
  uncertain: boolean;
};

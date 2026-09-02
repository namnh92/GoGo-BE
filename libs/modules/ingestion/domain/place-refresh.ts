/**
 * PR7 / COST-BE-007 (#340) — the refresh state machine, as a pure function.
 *
 * Phase 1 asks Google one question per row: *does this Place ID still resolve,
 * and has it moved?* That is the IDs-Only mask (`id,movedPlaceId`), which
 * Google bills at $0 — the tier exists in `PlaceProviderPort.details(id,
 * 'liveness')` since PR5 and this is its first production caller.
 *
 * The transitions live here, apart from the job, for two reasons. The job owns
 * a database, a provider, a budget and a clock, so a test of "what should
 * happen when Google says NOT_FOUND for the third time" would otherwise need
 * all four. And the plan's §2.5 is a state machine written in prose: keeping it
 * as one function is what lets the prose and the code be compared line by line.
 *
 * What phase 1 must never do (plan §0.2 C8, §7, ADR-0006 §9.5):
 *
 * - fetch a richer tier — no name, address, rating, hours, photos, reviews;
 * - write provider content anywhere. The only Google-derived value it stores is
 *   a **Place ID** (`moved_to_external_id`), which SST §3 permits indefinitely;
 * - decide a place is shut. `liveness` carries no `businessStatus`, so refresh
 *   cannot conclude closure and never writes `closed` / `temporarily_closed`.
 *   An id that stops resolving becomes `unknown` — "we do not know" — and a
 *   person decides, which is also why `FUTURE_OPENING` cannot reach storage
 *   through this path: the answer it would come from is never requested.
 */

/** Every terminal answer one liveness call can produce. */
export type RefreshAnswer =
  /** The id still resolves and is still itself. */
  | { kind: 'alive' }
  /**
   * The provider named a successor, or answered about a different id.
   *
   * Two independent signals, both carried by the IDs-Only mask and neither
   * derived from the other (`ports.ts`): `moved_place_id` is Google saying so
   * outright, `answered_as` is Google quietly answering as the successor. A
   * row can present either and treating one as a substitute for the other
   * would miss half the moves (#334).
   */
  | { kind: 'moved'; movedToExternalId: string; signal: 'moved_place_id' | 'answered_as' }
  /** Google rejected the id: `NOT_FOUND`, `INVALID_ARGUMENT`, or an empty answer. */
  | { kind: 'invalid_identity'; errorCode: string }
  /** Our side or Google's: quota, outage, disabled API, bad credential. */
  | { kind: 'provider_error'; errorCode: string };

/** What the row should look like after the answer is applied. */
export type RefreshSchedule =
  | { state: 'alive'; refreshAfter: Date; attempts: 0; errorCode: null }
  | { state: 'moved'; refreshAfter: null; attempts: 0; errorCode: null }
  | { state: 'retry'; refreshAfter: Date; attempts: number; errorCode: string }
  | { state: 'dormant'; refreshAfter: null; attempts: number; errorCode: string }
  /**
   * The provider failed, so the row learned nothing and is pushed out of the
   * way for a while. `attempts` is untouched — a quota error is not evidence
   * about a Place ID — and `transientFailures` counts separately.
   */
  | { state: 'deferred'; refreshAfter: Date; transientFailures: number; errorCode: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Plan §2.5 / D7: one flat cadence at MVP, no adaptive ladder. */
export const REFRESH_INTERVAL_DAYS = 30;

/** First backoff step. Doubles per attempt: 7d, 14d, then dormant. */
export const BACKOFF_BASE_DAYS = 7;

/**
 * How many times an id may be rejected before the job stops asking.
 *
 * Dormancy is not deletion and not closure — it is the job admitting it cannot
 * settle this row and handing it to a person. `refresh_after = null` takes the
 * row out of the due query (the index is partial on exactly that), and
 * `source_status = 'unknown'` is the one status a DB-first read declines to
 * answer from, so the next human-driven path re-asks Google instead of
 * trusting a fact we failed to verify.
 */
export const MAX_REFRESH_ATTEMPTS = 3;

/**
 * How long a row waits after a failure that was not its fault.
 *
 * Without this the tick is a spinner. A provider outage stops the tick at its
 * first call, and every row it was going to ask about is still due — so the
 * next tick asks the same first row, fails the same way, and the only thing
 * that moves is the budget: reservations are never refunded, so an outage that
 * lasts an afternoon can spend a day's ceiling on a handful of actual calls.
 * Pushing the row out by a bounded, doubling interval means an outage costs one
 * call per row per backoff step instead of one per tick.
 *
 * 30m, 1h, 2h, 4h, then capped at 6h — short enough that a blip does not delay
 * a 30-day cadence in any way that matters, long enough that a sustained outage
 * stops being expensive.
 */
export const TRANSIENT_BASE_MINUTES = 30;
export const TRANSIENT_MAX_MINUTES = 6 * 60;

/**
 * Classify one liveness answer.
 *
 * `identity` is what the port returned (`null` = no usable answer), `error` the
 * canonical status when it threw. Both absent cannot happen; a caller that
 * passes neither gets `invalid_identity`, which is the safe direction — it
 * costs a backoff, never a wrong status.
 */
export function classifyLiveness(input: {
  requestedExternalId: string;
  identity: {
    providerPlaceId: string;
    requestedProviderPlaceId?: string;
    movedPlaceId?: string;
  } | null;
  rejectedWith?: string;
  unavailableWith?: string;
}): RefreshAnswer {
  if (input.unavailableWith) {
    return { kind: 'provider_error', errorCode: input.unavailableWith };
  }
  if (input.rejectedWith) {
    return { kind: 'invalid_identity', errorCode: input.rejectedWith };
  }
  if (!input.identity) {
    // The port answers `null` when the body carried no id at all. Nothing was
    // rejected and nothing resolved, so it is the same outcome as a rejection
    // for scheduling — and it is recorded under its own code so the two are
    // still tellable apart in the ledger.
    return { kind: 'invalid_identity', errorCode: 'EMPTY_ANSWER' };
  }
  if (input.identity.movedPlaceId) {
    return {
      kind: 'moved',
      movedToExternalId: input.identity.movedPlaceId,
      signal: 'moved_place_id',
    };
  }
  if (input.identity.providerPlaceId !== input.requestedExternalId) {
    return {
      kind: 'moved',
      movedToExternalId: input.identity.providerPlaceId,
      signal: 'answered_as',
    };
  }
  return { kind: 'alive' };
}

/**
 * Turn an answer into the row's next state.
 *
 * `attemptsBefore` is what the row carried when the call was made. A successful
 * answer resets it, because the failures it counted were about an id that is
 * now known to resolve.
 */
export function scheduleFor(
  answer: RefreshAnswer,
  before: { attempts: number; transientFailures: number },
  now: Date,
): RefreshSchedule {
  const attemptsBefore = before.attempts;
  switch (answer.kind) {
    case 'alive':
      return {
        state: 'alive',
        refreshAfter: new Date(now.getTime() + REFRESH_INTERVAL_DAYS * DAY_MS),
        attempts: 0,
        errorCode: null,
      };

    case 'moved':
      // Deliberately dormant rather than due again in 30 days. A moved row is
      // waiting on a person — the place is in review and nothing here repoints
      // it — and leaving it due would spend the daily call ceiling re-asking a
      // question already answered, starving rows that still have one.
      return { state: 'moved', refreshAfter: null, attempts: 0, errorCode: null };

    case 'invalid_identity': {
      const attempts = attemptsBefore + 1;
      if (attempts >= MAX_REFRESH_ATTEMPTS) {
        return { state: 'dormant', refreshAfter: null, attempts, errorCode: answer.errorCode };
      }
      // 7d, then 14d. Exponent counts from the attempt just recorded, so the
      // first failure waits one base interval rather than two.
      const waitDays = BACKOFF_BASE_DAYS * 2 ** (attempts - 1);
      return {
        state: 'retry',
        refreshAfter: new Date(now.getTime() + waitDays * DAY_MS),
        attempts,
        errorCode: answer.errorCode,
      };
    }

    case 'provider_error': {
      // Not the row's fault, so the row does not pay for it in the currency
      // that matters: `refresh_attempts` is untouched and `source_status` is
      // left exactly as it was. This is the difference between "Google is
      // down" and "this place is gone", and conflating them is how an outage
      // would quietly mark a whole catalogue unverifiable.
      //
      // It does still move `refresh_after`, and that is the point: a row that
      // stays due is a row the next tick pays to ask about again.
      const transientFailures = before.transientFailures + 1;
      const waitMinutes = Math.min(
        TRANSIENT_BASE_MINUTES * 2 ** (transientFailures - 1),
        TRANSIENT_MAX_MINUTES,
      );
      return {
        state: 'deferred',
        refreshAfter: new Date(now.getTime() + waitMinutes * MINUTE_MS),
        transientFailures,
        errorCode: answer.errorCode,
      };
    }
  }
}

/** Outcomes the job reports, as a closed set. Metric label values, so bounded. */
export const REFRESH_OUTCOMES = [
  'attempted',
  'succeeded',
  'moved',
  'invalid_identity',
  'dormant',
  'deferred_not_due',
  'refused_budget',
  'disabled',
  'provider_error',
  'deadline',
] as const;

export type RefreshOutcome = (typeof REFRESH_OUTCOMES)[number];

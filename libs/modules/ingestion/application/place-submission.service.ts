import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import {
  ProviderConfigurationError,
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  type ResolvedProviderPlace,
} from '@gogo/providers';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import {
  APP_CONFIG,
  type PlatformConfig,
  type ResolutionAttestationConfig,
} from '../../shared/config';
import { flagEnvironmentOf, resolveBooleanFlag } from '../../shared/feature-flags';
import { normalizeGoogleAttribution } from '../../shared/attribution';
import { writeOutbox } from '../../shared/outbox';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import {
  signResolutionAttestation,
  verifyResolutionAttestation,
} from '../domain/resolution-attestation';
import { PlaceDedupService, type DedupVerdict } from './place-dedup.service';
import { PlaceResolverService } from './place-resolver.service';
import { writeAudit } from '../../shared/audit';

export type ResolveLinkResponse = {
  status: 'RESOLVED' | 'ALREADY_EXISTS' | 'CANDIDATE_SELECTION' | 'UNRESOLVED';
  matchConfidence?: number | undefined;
  reasonCodes: string[];
  existingPlaceId?: string | undefined;
  /**
   * #337 — proof that this request verified the Place ID with Google, for the
   * submit that usually follows. Opaque, short-lived, carries no Google
   * content, and is minted only for a place Google called `OPERATIONAL`.
   * Absent whenever the answer did not come from a live provider check.
   */
  resolutionToken?: string | undefined;
  candidate?: {
    googlePlaceId: string;
    name: string;
    address: string;
    location: { lat: number; lng: number };
    googleRating: number | null;
    googleRatingCount: number;
    googleScore: number | null;
    businessStatus: string;
    source: 'google_places';
    fetchedAt: string;
    attributions: string[];
  };
  candidates?:
    { googlePlaceId: string; name: string; address: string; confidence: number }[] | undefined;
};

/**
 * Every outcome that is not one identified place, in the shape `/v1` promises.
 *
 * Shared by both doors of `resolveLink` (#469). `NEEDS_CONFIRMATION` from a
 * chosen Place ID should not happen — `resolveByProviderId` matches on the id
 * itself — but the type admits it, and turning an unexpected outcome into a
 * candidate list the client already knows how to render beats asserting it away
 * and throwing on the day it happens.
 */
function undecided(outcome: {
  status: 'UNRESOLVED' | 'NEEDS_CONFIRMATION';
  reasonCode?: string;
  decision?: {
    reasons: string[];
    best?: { confidence: number } | undefined;
    candidates: {
      target: { googlePlaceId: string; name: string; address: string };
      confidence: number;
    }[];
  };
}): ResolveLinkResponse {
  if (outcome.status === 'UNRESOLVED') {
    return { status: 'UNRESOLVED', reasonCodes: [outcome.reasonCode ?? 'LOW_CONFIDENCE'] };
  }
  const decision = outcome.decision;
  return {
    status: 'CANDIDATE_SELECTION',
    reasonCodes: decision?.reasons ?? [],
    matchConfidence: decision?.best?.confidence,
    candidates: (decision?.candidates ?? []).map((c) => ({
      googlePlaceId: c.target.googlePlaceId,
      name: c.target.name,
      address: c.target.address,
      confidence: c.confidence,
    })),
  };
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function encodeSubmissionCursor(createdAt: Date | string, id: string): string {
  const raw = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  return Buffer.from(JSON.stringify([raw, id])).toString('base64url');
}

export function decodeSubmissionCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [
      string,
      string,
    ];
    if (typeof createdAt !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('bad');
    return { createdAt, id };
  } catch {
    throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid');
  }
}

/**
 * PI-BE-018/019/020 — Mobile add-by-link. Resolve is preview-only; submitting
 * creates at most one pending proposal per provider place (FR-INGEST-010/012)
 * and never publishes to the catalog.
 */
@Injectable()
export class PlaceSubmissionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly resolver: PlaceResolverService,
    private readonly dedup: PlaceDedupService,
    @Inject(APP_CONFIG)
    private readonly config: PlatformConfig & ResolutionAttestationConfig,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  private async dbFirstEnabled(): Promise<boolean> {
    return resolveBooleanFlag(this.db, 'place_dbfirst.enabled', {
      environment: flagEnvironmentOf(this.config.APP_ENV),
    });
  }

  private async attestationEnabled(): Promise<boolean> {
    return resolveBooleanFlag(this.db, 'place_resolution_attestation.enabled', {
      environment: flagEnvironmentOf(this.config.APP_ENV),
    });
  }

  /**
   * #469 — the second door.
   *
   * `CANDIDATE_SELECTION` hands a client three real Google Place IDs and, until
   * this, no way to act on one. That answer is usually right: three places
   * inside one tower are three places, and `decideMatch` deliberately refuses
   * to auto-pick between candidates within 0.05 of each other. But the spec has
   * always said a person picks (§11.3 step 5, §11.8), and picking is a
   * resolution — so it resolves through here rather than through a second
   * endpoint that would drift from this one.
   *
   * Exactly one of `url` and `googlePlaceId`; the controller rejects both and
   * neither.
   */
  async resolveLink(input: {
    url?: string | undefined;
    googlePlaceId?: string | undefined;
    cityHint?: string | undefined;
  }): Promise<ResolveLinkResponse> {
    if (input.googlePlaceId !== undefined) {
      const known = await this.knownIdAnswer(input.googlePlaceId);
      if (known) return known;

      const chosen = await this.resolver
        .resolveByProviderId(input.googlePlaceId, 'quality')
        .catch((err: unknown) => {
          throw placeProviderUnavailable(err);
        });
      if (chosen.status !== 'RESOLVED') return undecided(chosen);
      return this.finishResolution(chosen.details, chosen.decision, input.cityHint);
    }

    // Learn which place the link names before deciding whether to pay for it.
    // A short link still costs its one redirect hop — that hop *is* how the id
    // is learned — but no Places request has happened yet (#337, plan §4 C).
    const identified = await this.resolver.identifyUrl(input.url!).catch((err: unknown) => {
      throw placeProviderUnavailable(err);
    });
    if (!identified.ok) {
      return { status: 'UNRESOLVED', reasonCodes: [identified.reasonCode] };
    }

    const knownId = identified.value.providerPlaceId;
    if (knownId) {
      const known = await this.knownIdAnswer(knownId);
      if (known) return known;
    }

    // `quality`, and this is the one preview path that earns Enterprise (#338).
    // The candidate this returns is rendered: `toCandidate` publishes
    // `googleRating`, `googleRatingCount` and the score derived from them, and
    // the mobile client drops the whole rating row when the rating is absent
    // (`import.view.tsx`). Fetching `core` here would not degrade the preview,
    // it would silently delete from it the single fact a submitter uses to
    // decide whether the place is worth adding — while `googleRatingCount: 0`
    // said "no reviews" about a place nobody asked about. ADR-0006 §2 puts
    // "preview shown" on the `quality` row for exactly this reason.
    const outcome = await this.resolver
      .resolveIdentified(identified.value, 'quality', { city: input.cityHint })
      .catch((err: unknown) => {
        throw placeProviderUnavailable(err);
      });

    if (outcome.status !== 'RESOLVED') return undecided(outcome);

    return this.finishResolution(outcome.details, outcome.decision, input.cityHint);
  }

  /**
   * Everything after Google has answered about one specific place: the moved-id
   * report, the dedup verdict, the score and the envelope.
   *
   * One copy, because the two doors must agree. A branch the editor picked and
   * a link that named the same place outright have to produce the same answer —
   * the same `ALREADY_EXISTS`, the same conflict refusal, the same token.
   */
  private async finishResolution(
    details: ResolvedProviderPlace,
    decision: { best?: { confidence: number } | undefined; reasons: string[] },
    cityHint: string | undefined,
  ): Promise<ResolveLinkResponse> {
    // #334 — Google can answer about the successor of a place that moved.
    this.dedup.reportIdMismatch(details, 'submission');
    const verdict = await this.dedup.check(details);
    const score = await this.resolver.scoreFor(details, cityHint ?? null, null);
    const candidate = this.toCandidate(details, score);

    if (verdict.kind === 'IDENTITY_CONFLICT') {
      // #334 — two places claim this Google ID and the conflict is still open.
      // `ALREADY_EXISTS` would send the user to whichever place the query
      // happened to return first, and `RESOLVED` would invite them to submit a
      // third. Neither is true, so the honest preview answer is that we cannot
      // resolve it yet. The `/v1` enum is unchanged; the reason code says why.
      return { status: 'UNRESOLVED', reasonCodes: ['PLACE_IDENTITY_CONFLICT'] };
    }
    if (verdict.kind === 'LINKED_EXISTING') {
      // Existing place opens Place Detail instead of creating a duplicate.
      return {
        status: 'ALREADY_EXISTS',
        existingPlaceId: verdict.placeId,
        matchConfidence: decision.best?.confidence,
        reasonCodes: decision.reasons,
        candidate,
      };
    }
    return {
      status: 'RESOLVED',
      matchConfidence: decision.best?.confidence,
      reasonCodes: decision.reasons,
      candidate,
      ...(verdict.kind === 'MERGE_CANDIDATE' ? { existingPlaceId: verdict.placeId } : {}),
      ...(await this.mintAttestation(details)),
    };
  }

  /**
   * What the catalogue already knows about a Google Place ID, from rows GoGo
   * holds — no provider request (#337). `null` means "nothing decided here,
   * carry on and ask Google".
   *
   * Shared by both doors: a link that carries an id and a branch the editor
   * picked are the same question, and answering them differently would mean a
   * place that opens from a pasted link but duplicates from a chosen one.
   */
  private async knownIdAnswer(googlePlaceId: string): Promise<ResolveLinkResponse | null> {
    if (!(await this.dbFirstEnabled())) return null;
    const known = await this.dedup.knownProviderPlace(googlePlaceId, {
      verificationWindowSeconds: this.config.PLACE_RESOLUTION_TTL_S,
    });
    if (known.kind === 'CONFLICT') {
      return { status: 'UNRESOLVED', reasonCodes: ['PLACE_IDENTITY_CONFLICT'] };
    }
    if (known.kind === 'KNOWN') {
      this.metrics.increment('place_dbfirst_hit_total', { path: 'resolve_link' });
      // No `resolutionToken`: nothing was verified with Google in this
      // request, and a token minted from a stored row would be exactly the
      // cross-request snapshot ADR-0006 §9.5 forbids, wearing a signature.
      return {
        status: 'ALREADY_EXISTS',
        existingPlaceId: known.place.placeId,
        reasonCodes: ['PLACE_ALREADY_LINKED', 'DB_FIRST'],
        candidate: {
          googlePlaceId: known.place.googlePlaceId,
          name: known.place.name,
          address: known.place.addressText,
          location: { lat: known.place.lat, lng: known.place.lng },
          googleRating: known.place.rating,
          googleRatingCount: known.place.ratingCount,
          googleScore: known.place.derivedScore,
          businessStatus: known.place.businessStatus,
          source: 'google_places' as const,
          // The stored fetch time, not `now()`. Saying "just now" about a row
          // last refreshed three weeks ago is the one lie this path could
          // tell, and freshness is what the user is judging the answer on.
          fetchedAt: known.place.fetchedAt,
          // #339 — a stored row may carry the old wording; the user sees one.
          attributions: known.place.attribution
            ? [normalizeGoogleAttribution(known.place.attribution)]
            : [],
        },
      };
    }
    /**
     * Identity resolved, no `place_provider_sources` row. That used to mean a
     * legacy `place_sources` link the backfill had not reached; since #465 it
     * also means a place an editor created from a link, which writes the
     * identity and nothing else.
     *
     * The catalogue holds this place either way, and saying so is the whole
     * answer. Asking Google instead would answer `RESOLVED`, invite the editor
     * to create it, and hand them a `409 PLACE_ALREADY_LINKED` at the end of
     * the form — a round trip and a Details call to reach a fact already in the
     * database.
     *
     * No `candidate`: there is no provider row, so there is no rating and no
     * `fetchedAt` that could be published honestly. `/v1` has always allowed
     * `ALREADY_EXISTS` without one, and both clients render the place-exists
     * panel from `existingPlaceId` alone.
     */
    if (known.reason === 'legacy') {
      const identity = await this.dedup.resolveGoogleIdentity(googlePlaceId);
      if (identity.kind === 'RESOLVED') {
        this.metrics.increment('place_dbfirst_hit_total', { path: 'resolve_link_identity' });
        return {
          status: 'ALREADY_EXISTS',
          existingPlaceId: identity.placeId,
          reasonCodes: ['PLACE_ALREADY_LINKED', 'DB_FIRST'],
        };
      }
    }

    this.metrics.increment('place_dbfirst_miss_total', { reason: known.reason });
    return null;
  }

  /**
   * Mints the proof the submit that follows can present instead of a second
   * Details call — but only for a place Google just called `OPERATIONAL`.
   *
   * That condition is the whole design. `businessStatus` is Google content and
   * may not travel in the token, so the token's *existence* has to carry it: a
   * closed place gets none, its submit takes the old route, and the 409
   * `PLACE_CLOSED` still comes from a live provider answer. Nothing about
   * closure is inferred from a stored row, and nothing about it is stored.
   */
  private async mintAttestation(
    details: ResolvedProviderPlace,
  ): Promise<{ resolutionToken?: string }> {
    if (!this.config.PLACE_RESOLUTION_ATTESTATION_SECRET) {
      this.metrics.increment('place_resolution_attestation_total', { result: 'unconfigured' });
      return {};
    }
    if (!(await this.attestationEnabled())) {
      this.metrics.increment('place_resolution_attestation_total', { result: 'disabled' });
      return {};
    }
    if (details.businessStatus !== 'OPERATIONAL') return {};
    this.metrics.increment('place_resolution_attestation_total', { result: 'issued' });
    return {
      resolutionToken: signResolutionAttestation({
        googlePlaceId: details.providerPlaceId,
        secret: this.config.PLACE_RESOLUTION_ATTESTATION_SECRET,
        ttlSeconds: this.config.PLACE_RESOLUTION_TTL_S,
      }),
    };
  }

  private toCandidate(details: ResolvedProviderPlace, score: number) {
    return {
      googlePlaceId: details.providerPlaceId,
      name: details.name,
      address: details.addressText,
      location: { lat: details.lat, lng: details.lng },
      googleRating: details.rating,
      googleRatingCount: details.ratingCount,
      googleScore: score,
      businessStatus: details.businessStatus,
      source: 'google_places' as const,
      fetchedAt: new Date().toISOString(),
      attributions: [normalizeGoogleAttribution(details.attribution)],
    };
  }

  /**
   * Decides whether a presented attestation lets this request skip the Details
   * fetch — and refuses loudly when it does not.
   *
   * An expired, forged or mismatched token never quietly becomes a Google call
   * (plan §3 PR4): silently paying for what the client thought it had already
   * paid for is how a cost regression hides. The client is told to resolve
   * again, which is a real retry, not a lost cause — hence `retryable`.
   *
   * A token that was simply never offered, or a deployment with the feature off
   * or unconfigured, is not an error: those take the old path, which is exactly
   * the rollback.
   */
  private async acceptAttestation(
    token: string | undefined,
    googlePlaceId: string,
  ): Promise<boolean> {
    if (!token) return false;
    if (!this.config.PLACE_RESOLUTION_ATTESTATION_SECRET) {
      this.metrics.increment('place_resolution_attestation_total', { result: 'unconfigured' });
      return false;
    }
    if (!(await this.attestationEnabled())) {
      this.metrics.increment('place_resolution_attestation_total', { result: 'disabled' });
      return false;
    }

    const verdict = verifyResolutionAttestation(token, {
      secret: this.config.PLACE_RESOLUTION_ATTESTATION_SECRET,
    });
    if (!verdict.ok) {
      this.metrics.increment('place_resolution_attestation_total', {
        result: verdict.reason.toLowerCase(),
      });
      throw new AppError(
        'RESOLUTION_TOKEN_INVALID',
        'Cần mở lại liên kết để xác minh địa điểm rồi thử lại',
        400,
        { retryable: true },
      );
    }
    // Signed for a different place: valid proof, wrong subject. Accepting it
    // would let one verified id vouch for any other.
    if (verdict.attestation.googlePlaceId !== googlePlaceId) {
      this.metrics.increment('place_resolution_attestation_total', { result: 'mismatch' });
      throw new AppError(
        'RESOLUTION_TOKEN_INVALID',
        'Cần mở lại liên kết để xác minh địa điểm rồi thử lại',
        400,
        { retryable: true },
      );
    }

    this.metrics.increment('place_resolution_attestation_total', { result: 'accepted' });
    return true;
  }

  /** FR-INGEST-011/012 — proposal only; publishing stays with CMS. */
  async submit(
    actor: Actor,
    input: {
      googlePlaceId: string;
      roomId?: string | undefined;
      categoryKey?: string | undefined;
      priceMin?: number | undefined;
      priceMax?: number | undefined;
      priceUnit?: string | undefined;
      vibeKeys?: string[] | undefined;
      note?: string | undefined;
      resolutionToken?: string | undefined;
    },
  ) {
    if (actor.type === 'guest' && !input.roomId) {
      throw AppError.forbidden('ROOM_SCOPE_REQUIRED', 'Guests submit within their room only');
    }
    if (actor.type === 'guest' && input.roomId && actor.roomId !== input.roomId) {
      throw AppError.forbidden('ROOM_SCOPE_VIOLATION', 'Guest session is bound to another room');
    }

    // DB-first (#337, plan §3 PR4 item 3). The id is the dedup key and we hold
    // it, so asking Google what a place we already catalogued looks like — only
    // to answer `ALREADY_EXISTS` from our own row a moment later — was one
    // Enterprise `details` spent to learn nothing.
    if (await this.dbFirstEnabled()) {
      const known = await this.dedup.knownProviderPlace(input.googlePlaceId, {
        verificationWindowSeconds: this.config.PLACE_RESOLUTION_TTL_S,
      });
      if (known.kind === 'CONFLICT') throw identityConflict(this.metrics);
      if (known.kind === 'KNOWN') {
        this.metrics.increment('place_dbfirst_hit_total', { path: 'submit' });
        // An **identity** answer: this Google ID is already a GoGo place, so
        // the proposal is redundant and nothing is created. Identity does not
        // go stale, so the catalogue's own freshness window governs it.
        if (known.place.businessStatus === 'OPERATIONAL') {
          return { status: 'ALREADY_EXISTS' as const, placeId: known.place.placeId };
        }
        // A **verification** answer, and a refusal at that. Held to the short
        // window: `source_status` from three weeks ago would tell someone their
        // reopened café is shut, and a stored fact that old is not evidence
        // about right now. Stale closure costs one Details call, which is the
        // right thing to spend it on.
        if (known.place.verificationFresh) {
          throw AppError.conflict('PLACE_CLOSED', 'Place is closed and cannot be added');
        }
        this.metrics.increment('place_dbfirst_miss_total', { reason: 'closure_unverified' });
      } else {
        this.metrics.increment('place_dbfirst_miss_total', { reason: known.reason });
      }
    }

    // The attestation replaces the *fetch*, never a check. Everything below —
    // guest scope above, identity, pending-uniqueness — still runs; what goes
    // away is asking Google a second time within the TTL about a place it
    // already answered for (plan §2.8).
    const attested = await this.acceptAttestation(input.resolutionToken, input.googlePlaceId);

    let verdict: DedupVerdict;
    /**
     * What we are standing on if this request ends up creating a proposal.
     *
     * Made explicit after review, because until now the rule held by accident:
     * a DB-first hit always resolved to an existing place, so it could never
     * reach the insert. That is a property of one `if`, not an invariant — the
     * next person to add a DB-derived shortcut here would not be told they had
     * broken it. Now they are, twice: this has no initialiser, so a branch that
     * reaches the insert without setting it fails `tsc` with "used before being
     * assigned", and `assertFreshlyVerified` catches a value outside the two
     * kinds of evidence that count.
     */
    let verifiedBy: 'attestation' | 'provider';
    if (attested) {
      verifiedBy = 'attestation';
      // No provider object, so identity is read directly. `check()`'s other
      // verdicts need a name and coordinates, and neither changes the outcome
      // here: `MERGE_CANDIDATE` and `NEW` both create the same pending
      // proposal, and a moderator decides between them with a fresh fetch.
      const identity = await this.dedup.resolveGoogleIdentity(input.googlePlaceId);
      verdict =
        identity.kind === 'CONFLICT'
          ? {
              kind: 'IDENTITY_CONFLICT',
              placeIds: identity.placeIds,
              conflictId: identity.conflictId,
            }
          : identity.kind === 'RESOLVED'
            ? { kind: 'LINKED_EXISTING', placeId: identity.placeId }
            : { kind: 'NEW' };
    } else {
      // `core` (#338). This branch is the un-attested submit: it reads
      // `businessStatus` to refuse a closed place, and hands the object to
      // `dedup.check`, which needs a name and a coordinate. Every one of those
      // is a Pro field. Nothing here reads a rating, an opening hour or a price
      // level — the catalogue row is written at approve, and that fetch is
      // still Enterprise.
      const details = await this.resolver
        .resolveByProviderId(input.googlePlaceId, 'core')
        // #339 — `catch(() => null)` turned every provider fault into
        // `400 PLACE_NOT_FOUND`: a disabled API, an exhausted quota and an
        // upstream outage all reached the submitter as "that place does not
        // exist". It is the same conflation #279 fixed at the resolver, still
        // alive at the door one level up, and 400 is the reading that does the
        // most damage — it is not retryable, so a client that believes it stops
        // trying and the user is told their real place is not real.
        .catch((err: unknown) => {
          throw placeProviderUnavailable(err);
        });
      if (!details || details.status !== 'RESOLVED') {
        throw AppError.badRequest('PLACE_NOT_FOUND', 'Provider place could not be verified');
      }
      if (details.details.businessStatus === 'FUTURE_OPENING') {
        // #339 — not `PLACE_CLOSED`. A place Google lists as opening soon has
        // never traded, and telling a submitter their find is shut is both
        // wrong and discouraging in the one direction that matters: they are
        // early, not mistaken.
        throw AppError.conflict(
          'PLACE_NOT_YET_OPEN',
          'Địa điểm này chưa khai trương — thêm lại khi đã mở cửa',
        );
      }
      if (details.details.businessStatus !== 'OPERATIONAL') {
        throw AppError.conflict('PLACE_CLOSED', 'Place is closed and cannot be added');
      }
      this.dedup.reportIdMismatch(details.details, 'submission');
      verdict = await this.dedup.check(details.details);
      verifiedBy = 'provider';
    }
    if (verdict.kind === 'IDENTITY_CONFLICT') throw identityConflict(this.metrics);
    if (verdict.kind === 'LINKED_EXISTING') {
      return { status: 'ALREADY_EXISTS' as const, placeId: verdict.placeId };
    }

    // Nothing below this line may run on a stored provider fact. See
    // `assertFreshlyVerified`.
    assertFreshlyVerified(verifiedBy);

    // Same provider id from many users bumps the counter, never a new draft.
    const [existing] = await this.db
      .select()
      .from(schema.placeSubmissions)
      .where(
        sql`${schema.placeSubmissions.googlePlaceId} = ${input.googlePlaceId} and ${schema.placeSubmissions.status} = 'pending'`,
      )
      .limit(1);
    if (existing) {
      await this.db
        .update(schema.placeSubmissions)
        .set({ submissionCount: sql`${schema.placeSubmissions.submissionCount} + 1` })
        .where(eq(schema.placeSubmissions.id, existing.id));
      this.metrics.increment('mobile_place_submissions_total', { status: 'deduped' });
      return { status: 'PENDING' as const, submissionId: existing.id, deduped: true };
    }

    const [row] = await this.db
      .insert(schema.placeSubmissions)
      .values({
        googlePlaceId: input.googlePlaceId,
        ...(actor.type === 'user'
          ? { submittedByUserId: actor.id }
          : { submittedByGuestSessionId: actor.id }),
        roomId: input.roomId ?? null,
        categoryKey: input.categoryKey ?? null,
        priceMin: input.priceMin ?? null,
        priceMax: input.priceMax ?? null,
        priceUnit: input.priceUnit ?? null,
        vibeKeys: input.vibeKeys ?? [],
        note: input.note ?? null,
      })
      .returning();
    this.metrics.increment('mobile_place_submissions_total', { status: 'pending' });
    await writeOutbox(this.db, {
      eventType: 'place.submission_created',
      resourceType: 'place_submission',
      resourceId: row!.id,
      payload: { googlePlaceId: input.googlePlaceId },
    });
    return { status: 'PENDING' as const, submissionId: row!.id, deduped: false };
  }

  async getSubmission(actor: Actor, id: string) {
    const [row] = await this.db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, id))
      .limit(1);
    if (!row) throw AppError.notFound('SUBMISSION_NOT_FOUND', 'Submission not found');
    const owner =
      (actor.type === 'user' && row.submittedByUserId === actor.id) ||
      (actor.type === 'guest' && row.submittedByGuestSessionId === actor.id);
    if (!owner) throw AppError.forbidden();
    return {
      id: row.id,
      status: row.status,
      googlePlaceId: row.googlePlaceId,
      placeId: row.resultPlaceId ?? undefined,
      submissionCount: row.submissionCount,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString(),
    };
  }

  /**
   * PI-CMS-007 — the pending queue.
   *
   * The decide endpoint existed without anything to list what to decide on, so
   * the CMS had no way to find a submission in the first place. Keyset paging
   * on `(created_at, id)` for the same reason as the place list: proposals
   * arrive while a moderator works through them.
   */
  async listSubmissions(options: {
    status?: 'pending' | 'approved' | 'rejected' | 'merged' | undefined;
    limit: number;
    cursor?: string | undefined;
  }) {
    const where = [options.status ? sql`s.status = ${options.status}` : sql`true`];
    if (options.cursor) {
      const { createdAt, id } = decodeSubmissionCursor(options.cursor);
      where.push(sql`(s.created_at, s.id) < (${createdAt}::timestamptz, ${id}::uuid)`);
    }

    const rows = await this.db.execute(sql`
      select s.id, s.google_place_id, s.status, s.submission_count, s.category_key,
             s.price_min, s.price_max, s.price_unit, s.vibe_keys, s.note,
             s.room_id, s.result_place_id, s.created_at, s.decided_at, s.decision_reason,
             (s.submitted_by_user_id is not null) as from_user,
             p.name as result_place_name
      from place_submissions s
      left join places p on p.id = s.result_place_id
      where ${sql.join(where, sql` and `)}
      order by s.created_at desc, s.id desc
      limit ${options.limit + 1}
    `);

    type Row = {
      id: string;
      google_place_id: string;
      status: string;
      submission_count: number;
      category_key: string | null;
      price_min: number | null;
      price_max: number | null;
      price_unit: string | null;
      vibe_keys: string[];
      note: string | null;
      room_id: string | null;
      result_place_id: string | null;
      result_place_name: string | null;
      created_at: Date | string;
      decided_at: Date | string | null;
      decision_reason: string | null;
      from_user: boolean;
    };
    const page = rows.rows as Row[];
    const items = page.slice(0, options.limit);
    const last = items[items.length - 1];

    return {
      items: items.map((r) => ({
        id: r.id,
        googlePlaceId: r.google_place_id,
        status: r.status,
        // Many people proposing the same place is one row, not many — the
        // count is the signal a moderator prioritises by.
        submissionCount: r.submission_count,
        categoryKey: r.category_key ?? undefined,
        estimatedPrice:
          r.price_min !== null && r.price_max !== null
            ? { min: r.price_min, max: r.price_max, unit: r.price_unit ?? 'per_person' }
            : undefined,
        vibeKeys: r.vibe_keys,
        note: r.note ?? undefined,
        roomId: r.room_id ?? undefined,
        resultPlaceId: r.result_place_id ?? undefined,
        resultPlaceName: r.result_place_name ?? undefined,
        // Who submitted is deliberately reduced to a boolean: moderating does
        // not need the person's identity, only whether it came from an account.
        fromRegisteredUser: r.from_user,
        createdAt: iso(r.created_at)!,
        decidedAt: iso(r.decided_at),
        decisionReason: r.decision_reason ?? undefined,
      })),
      nextCursor:
        page.length > options.limit && last
          ? encodeSubmissionCursor(last.created_at, last.id)
          : null,
    };
  }

  /** CMS moderation (PI-CMS-007 backend half). */
  async decide(
    adminId: string,
    id: string,
    decision: 'approved' | 'rejected' | 'merged',
    reason: string,
    mergeIntoPlaceId?: string,
  ) {
    const [row] = await this.db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, id))
      .limit(1);
    if (!row) throw AppError.notFound('SUBMISSION_NOT_FOUND', 'Submission not found');
    if (row.status !== 'pending') {
      throw AppError.conflict('ALREADY_DECIDED', 'Submission already decided');
    }

    let resultPlaceId: string | null = row.resultPlaceId;
    if (decision === 'approved') {
      resultPlaceId = await this.createDraftFromSubmission(row);
    } else if (decision === 'merged') {
      if (!mergeIntoPlaceId) {
        throw AppError.badRequest('MERGE_TARGET_REQUIRED', 'mergeIntoPlaceId is required');
      }
      resultPlaceId = mergeIntoPlaceId;
      await this.dedup.emitReindex(mergeIntoPlaceId, 'merged');
    }

    await this.db
      .update(schema.placeSubmissions)
      .set({
        status: decision,
        decidedByAdminId: adminId,
        decisionReason: reason,
        decidedAt: sql`now()`,
        resultPlaceId,
      })
      .where(eq(schema.placeSubmissions.id, id));
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action: 'place_submission.decided',
      resourceType: 'place_submission',
      resourceId: id,
      diff: { decision, reason, resultPlaceId },
    });
    this.metrics.increment('mobile_place_submissions_total', { status: decision });
    // How long a proposal waited before an editor acted on it (spec §13).
    this.metrics.observe(
      'place_submission_publish_latency_hours',
      (Date.now() - row.createdAt.getTime()) / 3_600_000,
      { decision },
    );
    await writeOutbox(this.db, {
      eventType: 'place.submission_decided',
      resourceType: 'place_submission',
      resourceId: id,
      payload: { decision, resultPlaceId },
    });
    return { id, status: decision, placeId: resultPlaceId ?? undefined };
  }

  private async createDraftFromSubmission(
    row: typeof schema.placeSubmissions.$inferSelect,
  ): Promise<string> {
    // The approve step re-verifies against Google on purpose: moderation delay
    // outlives any attestation, and this is the fetch that becomes the
    // catalogue row (plan §2.8, §3 PR4).
    // `quality`: this fetch becomes the catalogue row — rating, review count,
    // price level and the whole weekly opening-hours table are all written
    // from it a few lines below (#338).
    const outcome = await this.resolver
      .resolveByProviderId(row.googlePlaceId, 'quality')
      .catch((err: unknown) => {
        throw placeProviderUnavailable(err);
      });
    if (outcome.status !== 'RESOLVED') {
      throw AppError.conflict('PROVIDER_UNAVAILABLE', 'Cannot verify provider place right now');
    }
    const d = outcome.details;
    const score = await this.resolver.scoreFor(d, null, row.categoryKey);

    return this.db
      .transaction(async (tx) => {
        const [place] = await tx
          .insert(schema.places)
          .values({
            name: d.name,
            nameNormalized: 'set-by-trigger',
            status: 'community_submitted',
            geom: { x: d.lng, y: d.lat },
            addressText: d.addressText,
            rating: d.rating !== null ? d.rating.toFixed(2) : null,
            ratingCount: d.ratingCount,
            priceLevel: d.priceLevel,
            confidence: '0.60',
            freshnessCheckedAt: new Date(),
          })
          .returning();
        for (const h of d.hours) {
          await tx.insert(schema.placeHours).values({
            placeId: place!.id,
            dayOfWeek: h.dayOfWeek,
            openMinute: h.openMinute,
            closeMinute: h.closeMinute,
            isOvernight: h.isOvernight,
            source: 'provider',
            verifiedAt: new Date(),
          });
        }
        if (row.priceMin !== null && row.priceMax !== null) {
          await tx.insert(schema.placePrices).values({
            placeId: place!.id,
            priceMin: row.priceMin,
            priceMax: row.priceMax,
            currency: 'VND',
            unit: row.priceUnit === 'per_item' ? 'per_item' : 'per_person',
            // User-supplied estimate — low confidence until an editor verifies.
            confidence: '0.30',
            source: 'editor',
          });
        }
        return place!.id;
      })
      .then(async (placeId) => {
        await this.dedup.upsertProviderSource({
          placeId,
          details: d,
          derivedScore: score,
          fetchTier: d.fetchTier,
        });
        await this.dedup.emitReindex(placeId, 'published');
        return placeId;
      });
  }
}

/**
 * The gate between "GoGo already has this" and "GoGo is being asked to add it".
 *
 * Everything past this point creates or bumps a proposal for a place the
 * catalogue does not hold, and the only acceptable evidence for that is minutes
 * old: a provider answer from this request, or an attestation over one, whose
 * lifetime is `PLACE_RESOLUTION_TTL_S`.
 *
 * A persisted `place_provider_sources` row is **not** that evidence, however
 * comfortably it sits inside `refresh_after`. Identity may be read from it —
 * knowing which place an ID belongs to is what makes the cheap
 * `ALREADY_EXISTS` correct — but identity answers return above and never arrive
 * here.
 *
 * Takes a `string` rather than the narrow union on purpose. The union is the
 * compile-time half of the guard — `verifiedBy` has no initialiser, so a new
 * branch that forgets it fails `tsc` outright — and this is the half that still
 * means something once someone widens that union to add a third kind of
 * evidence. It throws rather than returning, because there is no correct
 * fallback: a request that reaches it has already skipped the verification it
 * needed, and quietly fetching now would paper over the bug instead of
 * surfacing it.
 */
function assertFreshlyVerified(verifiedBy: string): void {
  if (verifiedBy === 'attestation' || verifiedBy === 'provider') return;
  throw AppError.internal(
    'A place submission was about to be created without a fresh provider verification',
  );
}

/**
 * #334 — one Google id claimed by two GoGo places, at whichever door.
 *
 * Accepting the submission would attach it to an ambiguous identity, and the
 * moderator approving it later would inherit the same choice being refused
 * here. Shared because DB-first reaches this conclusion without a provider
 * call and the resolved path reaches it with one — the answer must not depend
 * on which.
 */
function identityConflict(metrics: MetricsPort): AppError {
  metrics.increment('place_identity_conflict_blocked_total', { path: 'submission' });
  return AppError.conflict(
    'PLACE_IDENTITY_CONFLICT',
    'Địa điểm Google này đang trỏ tới hai place GoGo; cần gộp trước khi thêm',
  );
}

/**
 * #279 — one operational failure, one HTTP answer.
 *
 * The client is told the service cannot verify a place right now, and nothing
 * else. Which secret is missing, which adapter was bound, and what Google
 * said are facts about our infrastructure; they ride the `cause` into the log
 * and Sentry, where an operator can act on them, and they never reach the
 * envelope. Same split PI-BE-022 already settled for the Sheets path.
 *
 * `retryable: true` because every one of these is true again on the next
 * request only if someone fixes it — but the client's correct behaviour is
 * identical in all of them: back off and try later, do not tell the user
 * their place does not exist.
 */
export function placeProviderUnavailable(err: unknown): AppError {
  const operational =
    err instanceof ProviderConfigurationError ||
    err instanceof ProviderQuotaExceededError ||
    err instanceof ProviderUnavailableError;
  if (!operational) return err instanceof AppError ? err : AppError.internal();
  return new AppError(
    'PLACE_PROVIDER_UNAVAILABLE',
    'GoGo đang tạm thời không xác minh được địa điểm',
    503,
    { retryable: true, cause: err },
  );
}

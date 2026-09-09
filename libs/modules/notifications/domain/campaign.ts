import { z } from 'zod';
import { AppError } from '../../shared/app-error';
import { assertExternalUrl } from '../../shared/external-url';

/**
 * BE-CMS-G4e (#226) — what a campaign is allowed to say and who it can reach.
 *
 * Two rules shape everything here. A campaign that has been sent cannot be
 * recalled, so anything ambiguous is refused before it is stored rather than
 * discovered at delivery. And a campaign must only target an audience the
 * backend can actually compute — a segment the server has to guess at reaches
 * the wrong people, which is the one failure with no undo.
 */

/**
 * The audiences resolvable from data GoGo holds today.
 *
 * `city`, `app_version` and `custom_segment` appear in the mockup and are
 * deliberately not here: nothing stores a user's city or their app version,
 * and there is no segment store. Each needs its own backend work first.
 */
export const CAMPAIGN_AUDIENCES = ['all', 'couple', 'group', 'platform'] as const;
export type CampaignAudience = (typeof CAMPAIGN_AUDIENCES)[number];

export const CAMPAIGN_DESTINATIONS = [
  'home',
  'place',
  'recommendation',
  /**
   * A campaign points every recipient at the same thing, so it cannot point at
   * a *plan* — a plan belongs to one room. A plan template is the plan-shaped
   * thing that is the same for everyone.
   */
  'plan_template',
  'saved',
  'external_url',
] as const;
export type CampaignDestination = (typeof CAMPAIGN_DESTINATIONS)[number];

export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'cancelled',
  'failed',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Closed per audience type, like every other filter in the CMS contract. */
export const AUDIENCE_FILTERS = {
  all: z.object({}).strict(),
  couple: z.object({}).strict(),
  group: z.object({}).strict(),
  platform: z.object({ platform: z.enum(['ios', 'android', 'web']) }).strict(),
} as const satisfies Record<CampaignAudience, z.ZodType>;

/** Destinations that carry an id, and what kind of id it is. */
export const DESTINATION_REFERENCES: Partial<Record<CampaignDestination, 'uuid' | 'url'>> = {
  place: 'uuid',
  recommendation: 'uuid',
  plan_template: 'uuid',
  external_url: 'url',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badDestination(field: string, message: string): AppError {
  return AppError.badRequest('INVALID_DESTINATION', 'That destination cannot be used', [
    { field, code: 'invalid', message },
  ]);
}

/**
 * Checks the destination pair without touching the database.
 *
 * Existence of the referenced row is checked separately, in the service, since
 * only it can ask; what happens here is the part that is true regardless of
 * data — that `home` and `saved` carry nothing, everything else carries
 * something, and that something is the right shape.
 */
export function assertDestinationShape(
  type: CampaignDestination,
  value: string | undefined,
): string | null {
  const reference = DESTINATION_REFERENCES[type];
  if (!reference) {
    if (value) throw badDestination('destinationValue', `${type} takes no destination value`);
    return null;
  }
  if (!value) throw badDestination('destinationValue', `${type} needs a destination`);
  if (reference === 'uuid') {
    if (!UUID.test(value)) throw badDestination('destinationValue', 'must be an id');
    return value;
  }
  return assertExternalUrl(value);
}

/**
 * Which status may follow which.
 *
 * `sending` has no way back: once the worker has started handing messages to
 * the provider, some are already on someone's phone. Saying a campaign can be
 * cancelled at that point would be a promise the backend cannot keep.
 */
/**
 * `sent: []` is what makes a completed campaign final, and it decides more than
 * it looks like it does: a recipient the provider had no subscription for is
 * counted in `failed_count` and keeps `push_sent_at` null, but because nothing
 * can move a `sent` campaign back to `scheduled`, that recipient is never
 * attempted again. From `failed` the same recipient *is* retried, because that
 * status reopens.
 *
 * That was review finding R4, recorded and not changed, and #516 is what
 * happens when the unrecoverable branch is also the one taken by default: a
 * dispatch that accepted nothing wrote `sent`, so *every* recipient was in the
 * never-retried state and the campaign said it had gone out. `campaignOutcome`
 * below is the fix — a dispatch only claims `sent` when the provider created at
 * least one message, and the rest end `failed`, which reopens.
 */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['scheduled'],
  scheduled: ['draft', 'sending', 'cancelled'],
  sending: ['sent', 'failed'],
  sent: [],
  cancelled: ['scheduled'],
  failed: ['scheduled'],
};

/**
 * Editing is only meaningful while nothing has been sent.
 *
 * `failed` and `cancelled` are on the list because a campaign that never
 * reached anyone is still a draft in every way that matters. Once it *has*
 * reached someone, `CampaignsService.update` refuses the fields that reach a
 * phone regardless of status (review finding R3) — status alone cannot express
 * that, because a failed campaign may have delivered to none or to half.
 */
export const EDITABLE_STATUSES: CampaignStatus[] = ['draft', 'cancelled', 'failed'];

/**
 * NTF-BE-012 (#516) — how a dispatch that has finished walking its recipient
 * list ends.
 *
 * The dispatcher used to write `sent` here unconditionally, which said only
 * "the loop completed". Campaign AAA on DEV finished `sent` with zero messages
 * accepted and three no-target failures, and the CMS rendered that as a mint
 * badge with a check glyph. Worse, `sent` is terminal (`CAMPAIGN_TRANSITIONS`
 * above), so the three recipients whose rows kept `push_sent_at = null` could
 * never be attempted again — the R4 note above, reached by the one path that
 * made it unrecoverable.
 *
 * The rule is that `sent` must be able to point at a message the provider
 * created. Nothing accepted is `failed`: not a claim that the system broke, but
 * the state an operator can act from — `failed → scheduled` reopens, and a
 * re-run of the same dispatch key skips whoever already has `push_sent_at`.
 *
 * An empty audience ends the same way and for the same reason. `sent 0/0` reads
 * as success, and "this campaign selected nobody" is exactly the thing an
 * operator has to see before they conclude the message went out.
 *
 * Partial delivery stays `sent`: some people are holding the message, and no
 * status can un-send it. The two counters carry the rest of the story.
 */
export type CampaignOutcome = {
  status: Extract<CampaignStatus, 'sent' | 'failed'>;
  /** Stable code first, so the CMS can translate rather than echo. */
  lastError: string | null;
};

export function campaignOutcome(counts: {
  /** Recipients the dispatch actually tried. */
  attempted: number;
  /** Of those, how many the provider created a message for. */
  accepted: number;
}): CampaignOutcome {
  if (counts.accepted > 0) return { status: 'sent', lastError: null };
  if (counts.attempted === 0) {
    return {
      status: 'failed',
      lastError: 'EMPTY_AUDIENCE: no account matched this audience at send time',
    };
  }
  return {
    status: 'failed',
    lastError: `NO_SUBSCRIPTION_ACCEPTED: the provider created no message for any of ${counts.attempted} recipients`,
  };
}

/**
 * The dedupe key one recipient's message carries.
 *
 * Built from the dispatch key rather than the campaign id, so a worker retry
 * is a no-op while a deliberate re-send after a cancel — a new dispatch — is
 * not mistaken for one.
 */
export function campaignDedupeKey(dispatchKey: string, userId: string): string {
  return `campaign:${dispatchKey}:${userId}`;
}

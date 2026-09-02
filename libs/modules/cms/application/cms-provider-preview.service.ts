import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import { GOOGLE_PROVIDER } from '../../shared/google-provenance';
import { DB } from '../../shared/tokens';
import { ProviderContentService } from '../../ingestion/application/provider-content.service';
import type {
  ProviderContentAnswer,
  ProviderContentTier,
} from '../../ingestion/domain/provider-content';

/**
 * What the CMS gets back from a preview. Facts, not sentences; the console
 * composes "GoGo says X, Google says Y" from the place it already holds.
 *
 * `ephemeral: true` is a literal on purpose — a client reading the contract
 * sees, in the payload, that this answer was not and will not be stored, and
 * renders the notice that says so (ADR-0006 §9.7.1).
 */
export type CmsProviderPreviewDto = {
  outcome: ProviderContentAnswer['outcome'];
  tier: ProviderContentTier;
  requestedGooglePlaceId: string;
  fetchedAt: string;
  attribution: string;
  ephemeral: true;
  provider: {
    googlePlaceId: string;
    moved: boolean;
    name: string;
    addressText: string;
    location: { lat: number; lng: number };
    businessStatus: string;
    primaryType: string | null;
    types: string[];
    googleMapsUri: string | null;
    quality: {
      rating: number | null;
      ratingCount: number;
      hours: { dayOfWeek: number; openMinute: number; closeMinute: number; isOvernight: boolean }[];
      priceLevel: number | null;
    } | null;
  } | null;
};

/**
 * #341 (PR8) / CMS#98 — "Xem dữ liệu Google hiện tại".
 *
 * A moderator asks what Google says *right now* about a place GoGo already
 * holds, to compare, to verify a report, to see whether an id still answers.
 * The answer is rendered and discarded: this service reads the place's Google
 * identity, calls the ephemeral boundary, writes one audit row that names the
 * ids and the outcome and nothing else, and returns. It holds no repository
 * and performs no catalogue write — `provider-content-boundary.spec.ts`
 * refuses one here structurally.
 *
 * What it does **not** do, and must not grow to do: copy anything from the
 * answer into `places`, `place_provider_sources`, `place_hours` or
 * `place_prices`. If a moderator wants GoGo's record to say what Google says,
 * they type it into the editor form, and the row carries their authorship.
 * The single sanctioned way the *persisted* provider state changes on Google's
 * say-so is PR7's scheduled liveness refresh, which a moderator can only ask
 * for sooner (`CmsCatalogService.requestRefresh`).
 */
@Injectable()
export class CmsProviderPreviewService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly content: ProviderContentService,
  ) {}

  async preview(
    adminId: string,
    placeId: string,
    tier: ProviderContentTier,
  ): Promise<CmsProviderPreviewDto> {
    const identity = await this.googleIdentityOf(placeId);

    let answer: ProviderContentAnswer;
    try {
      answer = await this.content.fetch({
        googlePlaceId: identity.externalId,
        tier,
        scope: 'google.places.cms_preview',
      });
    } catch (err) {
      // The attempt is audited even when the provider could not answer: the
      // reservation was spent on this actor's click, and "who asked" is the
      // question an audit exists to answer. Still ids only.
      await this.audit(adminId, placeId, {
        tier,
        outcome: 'provider_unavailable',
        googlePlaceId: identity.externalId,
        answeredGooglePlaceId: null,
      });
      throw err;
    }

    await this.audit(adminId, placeId, {
      tier,
      outcome: answer.outcome,
      googlePlaceId: identity.externalId,
      answeredGooglePlaceId: answer.outcome === 'found' ? answer.content.googlePlaceId : null,
    });

    return toDto(answer);
  }

  /**
   * The canonical Google row for a place, or the reason there is none.
   *
   * Two Google rows on one place is an identity conflict PR1 parks for a human
   * (#334); previewing "the" id would pick one silently, so it refuses.
   */
  private async googleIdentityOf(placeId: string): Promise<{ externalId: string }> {
    const rows = await this.db
      .select({ externalId: schema.placeProviderSources.externalId })
      .from(schema.placeProviderSources)
      .where(
        and(
          eq(schema.placeProviderSources.placeId, placeId),
          eq(schema.placeProviderSources.provider, GOOGLE_PROVIDER),
        ),
      );
    if (rows.length === 1) return rows[0]!;
    if (rows.length > 1) {
      throw AppError.conflict(
        'PLACE_IDENTITY_CONFLICT',
        'Place holds more than one Google identity; resolve the conflict first',
      );
    }
    const [place] = await this.db
      .select({ id: schema.places.id })
      .from(schema.places)
      .where(eq(schema.places.id, placeId))
      .limit(1);
    if (!place) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');
    throw AppError.conflict('PLACE_NO_PROVIDER_SOURCE', 'Place has no Google identity to preview');
  }

  /**
   * Place IDs, the tier and the outcome. Never the name, the rating, the
   * status: an audit row is a durable store, and ADR-0006 §9.7.1 lists
   * `audit_logs.diff` among the places rich content may not land.
   */
  private audit(
    adminId: string,
    placeId: string,
    diff: {
      tier: ProviderContentTier;
      outcome: ProviderContentAnswer['outcome'] | 'provider_unavailable';
      googlePlaceId: string;
      answeredGooglePlaceId: string | null;
    },
  ): Promise<void> {
    return writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action: 'place.provider_previewed',
      resourceType: 'place',
      resourceId: placeId,
      diff,
    });
  }
}

function toDto(answer: ProviderContentAnswer): CmsProviderPreviewDto {
  if (answer.outcome !== 'found') {
    return {
      outcome: answer.outcome,
      tier: answer.tier,
      requestedGooglePlaceId: answer.requestedGooglePlaceId,
      fetchedAt: answer.fetchedAt,
      attribution: 'Google Maps',
      ephemeral: true,
      provider: null,
    };
  }
  const { content } = answer;
  const { facts } = content;
  return {
    outcome: 'found',
    tier: content.tier,
    requestedGooglePlaceId: content.requestedGooglePlaceId,
    fetchedAt: content.fetchedAt,
    attribution: content.attribution,
    ephemeral: true,
    provider: {
      googlePlaceId: content.googlePlaceId,
      moved: content.moved,
      name: facts.name,
      addressText: facts.addressText,
      location: { lat: facts.location.lat, lng: facts.location.lng },
      businessStatus: facts.businessStatus,
      primaryType: facts.primaryType,
      types: [...facts.types],
      googleMapsUri: facts.googleMapsUri,
      quality:
        facts.quality === null
          ? null
          : {
              rating: facts.quality.rating,
              ratingCount: facts.quality.ratingCount,
              hours: facts.quality.hours.map((h) => ({ ...h })),
              priceLevel: facts.quality.priceLevel,
            },
    },
  };
}

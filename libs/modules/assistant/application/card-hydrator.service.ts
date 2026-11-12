import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import { AppError } from '../../shared/app-error';
import { placeCardFromDetail } from './place-card';
import type { Actor } from '../../identity/domain/actor';
import { SearchService } from '../../search/application/search.service';
import { PlansService } from '../../plans/application/plans.service';
import { RoomsService } from '../../rooms/application/rooms.service';
import type { AssistantCardRef } from '../domain/assistant.types';

/**
 * GoGo-BE#713 — card facts, read now from the same verified paths the app's
 * own screens use (`PlaceDetail`, `getPlan`). History stores ids only, so a
 * card always shows today's verified facts with their `checkedAt`; a place no
 * longer usable, or a plan the caller can no longer read, comes back
 * `available: false` with minimal facts. Nothing here ever comes from a model.
 */
export type PlaceCard = {
  kind: 'place';
  placeId: string;
  available: boolean;
  facts: {
    name: string;
    areaKey?: string;
    addressText?: string;
    priceLevel?: number;
    priceMin?: number;
    priceMax?: number;
    currency?: string;
    providerRating?: number;
    providerRatingCount?: number;
    providerRatingSource?: 'google';
    gogoRating?: number;
    gogoRatingCount?: number;
    openNow?: boolean | null;
    photoUrl?: string;
    checkedAt?: string;
  };
};

export type PlanCard = {
  kind: 'plan';
  planId: string;
  roomId: string;
  available: boolean;
  facts: {
    roomTitle?: string;
    roomType?: string;
    participantCount?: number;
    status?: string;
    version?: number;
    stopCount?: number;
    totals?: unknown;
    startAt?: string;
  };
};

export type PlaceTags = { categories: string[]; moods: string[]; settings: string[] };

@Injectable()
export class AssistantCardHydrator {
  constructor(
    private readonly search: SearchService,
    private readonly plans: PlansService,
    private readonly rooms: RoomsService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async hydrate(
    actor: Actor,
    refs: readonly AssistantCardRef[],
    at = new Date(),
  ): Promise<(PlaceCard | PlanCard)[]> {
    return Promise.all(
      refs.map((ref) =>
        ref.kind === 'place'
          ? this.placeCard(ref.placeId, at)
          : this.planCard(actor, ref.planId, ref.roomId),
      ),
    );
  }

  async placeCard(placeId: string, at = new Date()): Promise<PlaceCard> {
    let detail: Awaited<ReturnType<SearchService['placeDetail']>>;
    try {
      detail = await this.search.placeDetail(placeId);
    } catch (err) {
      if (err instanceof AppError && err.httpStatus === 404) return this.unavailablePlace(placeId);
      throw err;
    }
    return placeCardFromDetail(detail, at);
  }

  private async unavailablePlace(placeId: string): Promise<PlaceCard> {
    const res = await this.db.execute(sql`select name from places where id = ${placeId}`);
    const name = (res.rows[0] as { name: string } | undefined)?.name ?? '';
    return { kind: 'place', placeId, available: false, facts: { name } };
  }

  async planCard(actor: Actor, planId: string, roomId: string): Promise<PlanCard> {
    try {
      const plan = await this.plans.getPlan(actor, planId);
      const room = await this.rooms.getRoomSummary(actor, plan.roomId);
      const first = plan.stops.find((s) => s.arriveAt)?.arriveAt;
      return {
        kind: 'plan',
        planId,
        roomId: plan.roomId,
        available: true,
        facts: {
          ...(room.title ? { roomTitle: room.title } : {}),
          roomType: room.type,
          participantCount: room.participantCount,
          status: plan.status,
          version: plan.version,
          stopCount: plan.stops.length,
          totals: plan.totals,
          ...(first ? { startAt: first } : {}),
        },
      };
    } catch (err) {
      if (err instanceof AppError && (err.httpStatus === 403 || err.httpStatus === 404)) {
        return { kind: 'plan', planId, roomId, available: false, facts: {} };
      }
      throw err;
    }
  }

  /** CMS taxonomy keys attached to places, for candidate descriptions. */
  async placeTags(placeIds: readonly string[]): Promise<Map<string, PlaceTags>> {
    const out = new Map<string, PlaceTags>();
    if (placeIds.length === 0) return out;
    const res = await this.db.execute(sql`
      select pt.place_id, t.kind::text as kind, t.key
      from place_taxonomies pt join taxonomies t on t.id = pt.taxonomy_id
      where pt.place_id in (${sql.join(
        placeIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        and t.kind in ('category', 'mood', 'setting')`);
    for (const r of res.rows as { place_id: string; kind: string; key: string }[]) {
      const tags = out.get(r.place_id) ?? { categories: [], moods: [], settings: [] };
      if (r.kind === 'category') tags.categories.push(r.key);
      else if (r.kind === 'mood') tags.moods.push(r.key);
      else tags.settings.push(r.key);
      out.set(r.place_id, tags);
    }
    return out;
  }
}

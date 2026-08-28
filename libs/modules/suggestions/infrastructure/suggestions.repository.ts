import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { writeOutbox, type DomainEventInput } from '../../shared/outbox';
import { DB } from '../../shared/tokens';
import { pgArray } from '../../search/infrastructure/search.repository';
import type { Candidate, RoomSnapshot } from '../domain/types';

export type RunRow = typeof schema.suggestionRuns.$inferSelect;
export type ScoreRow = typeof schema.candidateScores.$inferSelect;
export type VoteRow = typeof schema.votes.$inferSelect;

@Injectable()
export class SuggestionsRepository {
  constructor(@Inject(DB) readonly db: Db) {}

  /** SG-002 — immutable snapshot of everything a run depends on. */
  async buildSnapshot(roomId: string): Promise<RoomSnapshot> {
    const [room] = await this.db
      .select()
      .from(schema.rooms)
      .where(eq(schema.rooms.id, roomId))
      .limit(1);
    if (!room) throw AppError.notFound('ROOM_NOT_FOUND', 'Room not found');
    const [constraint] = await this.db
      .select()
      .from(schema.roomConstraints)
      .where(
        and(
          eq(schema.roomConstraints.roomId, roomId),
          eq(schema.roomConstraints.version, room.constraintVersion),
        ),
      )
      .limit(1);
    if (!constraint) throw AppError.internal('Room has no constraint row');

    const members = await this.db
      .select({
        memberId: schema.roomMembers.id,
        selections: schema.preferenceSelections.selections,
        weights: schema.preferenceSelections.weights,
        isDraft: schema.preferenceSelections.isDraft,
      })
      .from(schema.roomMembers)
      .leftJoin(
        schema.preferenceSelections,
        eq(schema.preferenceSelections.memberId, schema.roomMembers.id),
      )
      .where(
        and(eq(schema.roomMembers.roomId, roomId), sql`${schema.roomMembers.removedAt} is null`),
      );

    const seeds = await this.db
      .select({ placeId: schema.roomSeedPlaces.placeId })
      .from(schema.roomSeedPlaces)
      .where(eq(schema.roomSeedPlaces.roomId, roomId));

    return {
      roomId,
      constraintVersion: room.constraintVersion,
      type: room.type,
      decisionMode: room.decisionMode,
      participantCount: room.participantCount,
      budget: {
        mode: constraint.budgetMode,
        amount: constraint.budgetAmount,
        currency: constraint.currency,
      },
      timeWindow: {
        startAt: constraint.startAt?.toISOString() ?? null,
        endAt: constraint.endAt?.toISOString() ?? null,
      },
      origin:
        constraint.originLat !== null && constraint.originLng !== null
          ? { lat: constraint.originLat, lng: constraint.originLng }
          : null,
      radiusM: constraint.radiusM,
      dietaryKeys: constraint.dietaryKeys,
      accessibilityKeys: constraint.accessibilityKeys,
      memberPreferences: members.map((m) => ({
        memberId: m.memberId,
        selections: m.selections ?? {},
        weights: m.weights ?? null,
      })),
      seedPlaceIds: seeds.map((s) => s.placeId),
    };
  }

  /** Candidate retrieval — verified published places with aggregated facts. */
  async retrieveCandidates(snapshot: RoomSnapshot, limit = 200): Promise<Candidate[]> {
    const geoFilter =
      snapshot.origin && snapshot.radiusM
        ? sql`and ST_DWithin(p.geom::geography,
            ST_SetSRID(ST_MakePoint(${snapshot.origin.lng}, ${snapshot.origin.lat}), 4326)::geography,
            ${snapshot.radiusM})`
        : sql``;
    const seedIds = snapshot.seedPlaceIds;
    const hasSeeds = seedIds.length > 0;
    const seedExpr = hasSeeds ? sql`p.id = any((${pgArray(seedIds)})::uuid[])` : sql`false`;
    // PG rejects bare boolean constants in ORDER BY — only order by the seed
    // flag when seeds exist.
    const seedOrder = hasSeeds ? sql`(case when ${seedExpr} then 0 else 1 end),` : sql``;

    const rows = await this.db.execute(sql`
      select
        p.id, p.name, ST_Y(p.geom) as lat, ST_X(p.geom) as lng,
        p.suitability, p.rating, p.rating_count, p.avg_visit_minutes,
        p.confidence,
        case when p.freshness_checked_at is null then null
          else extract(epoch from (now() - p.freshness_checked_at)) / 86400.0 end as freshness_days,
        lp.price_min, lp.price_max,
        coalesce((select jsonb_object_agg(kind, keys) from (
          select t.kind, jsonb_agg(t.key) as keys
          from place_taxonomies pt join taxonomies t on t.id = pt.taxonomy_id
          where pt.place_id = p.id group by t.kind
        ) tk), '{}'::jsonb) as taxonomy_keys,
        coalesce((select jsonb_agg(jsonb_build_object(
            'dayOfWeek', h.day_of_week, 'openMinute', h.open_minute,
            'closeMinute', h.close_minute, 'isOvernight', h.is_overnight))
          from place_hours h where h.place_id = p.id), '[]'::jsonb) as hours,
        (${seedExpr}) as is_seed
      from places p
      left join lateral (
        select pp.price_min, pp.price_max from place_prices pp
        where pp.place_id = p.id and pp.unit = 'per_person'
        order by pp.verified_at desc nulls last, pp.created_at desc limit 1
      ) lp on true
      where p.status = 'published' and p.is_lodging = false
        -- BE-IMP-004: a place the provider reports shut stays published (that
        -- is a moderation state, and nobody moderated it) but must not be
        -- suggested — putting a closed door on someone's evening is exactly
        -- what core rule #8 forbids.
        and not exists (
          select 1 from place_provider_sources ps
          where ps.place_id = p.id and ps.source_status in ('closed', 'temporarily_closed')
        )
        ${geoFilter}
      order by ${seedOrder} p.rating desc nulls last, p.rating_count desc
      limit ${limit}
    `);

    return (rows.rows as Record<string, unknown>[]).map((r) => ({
      placeId: r.id as string,
      name: r.name as string,
      lat: Number(r.lat),
      lng: Number(r.lng),
      taxonomyKeys: (r.taxonomy_keys ?? {}) as Record<string, string[]>,
      suitability: (r.suitability ?? null) as Record<string, number> | null,
      pricePerPersonMin: r.price_min !== null ? Number(r.price_min) : null,
      pricePerPersonMax: r.price_max !== null ? Number(r.price_max) : null,
      avgVisitMinutes: r.avg_visit_minutes !== null ? Number(r.avg_visit_minutes) : null,
      rating: r.rating !== null ? Number(r.rating) : null,
      ratingCount: Number(r.rating_count),
      confidence: Number(r.confidence),
      freshnessDays: r.freshness_days !== null ? Number(r.freshness_days) : null,
      hours: (r.hours ?? []) as Candidate['hours'],
      isSeed: r.is_seed === true,
    }));
  }

  async createRun(input: {
    roomId: string;
    constraintVersion: number;
    engineVersion: string;
    weightsVersion: string;
    inputSnapshot: RoomSnapshot;
    /** SG-010 — absent when no experiment was defined, which is not control. */
    experimentKey?: string | undefined;
    experimentVariant?: string | undefined;
  }): Promise<RunRow> {
    const [row] = await this.db
      .insert(schema.suggestionRuns)
      .values({ ...input, status: 'running', startedAt: sql`now()` })
      .returning();
    return row!;
  }

  async finishRun(
    runId: string,
    status: 'succeeded' | 'failed',
    errorCode?: string,
    latencyMs?: number,
  ): Promise<void> {
    await this.db
      .update(schema.suggestionRuns)
      .set({
        status,
        finishedAt: sql`now()`,
        errorCode: errorCode ?? null,
        // Recorded for the failed case too: a run that took eight seconds and
        // then failed is a different problem from one that failed at once.
        ...(latencyMs !== undefined ? { latencyMs } : {}),
      })
      .where(eq(schema.suggestionRuns.id, runId));
  }

  async persistScores(
    runId: string,
    roomId: string,
    scores: {
      placeId: string;
      rank: number;
      scoreMicros: number;
      components: Record<string, number>;
      reasonCodes: string[];
    }[],
    event: DomainEventInput,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Older runs' scores go stale the moment a new ranking lands.
      await tx
        .update(schema.candidateScores)
        .set({ isStale: true })
        .where(eq(schema.candidateScores.roomId, roomId));
      if (scores.length > 0) {
        await tx.insert(schema.candidateScores).values(
          scores.map((s) => ({
            runId,
            roomId,
            placeId: s.placeId,
            rank: s.rank,
            scoreMicros: s.scoreMicros,
            components: s.components,
            reasonCodes: s.reasonCodes,
            isStale: false,
          })),
        );
      }
      await writeOutbox(tx, event);
    });
  }

  async latestRun(roomId: string): Promise<RunRow | undefined> {
    return this.db
      .select()
      .from(schema.suggestionRuns)
      .where(
        and(
          eq(schema.suggestionRuns.roomId, roomId),
          eq(schema.suggestionRuns.status, 'succeeded'),
        ),
      )
      .orderBy(desc(schema.suggestionRuns.createdAt))
      .limit(1)
      .then((r) => r[0]);
  }

  async scoresForRun(runId: string): Promise<(ScoreRow & { name: string })[]> {
    const rows = await this.db
      .select({
        score: schema.candidateScores,
        name: schema.places.name,
      })
      .from(schema.candidateScores)
      .innerJoin(schema.places, eq(schema.places.id, schema.candidateScores.placeId))
      .where(eq(schema.candidateScores.runId, runId))
      .orderBy(schema.candidateScores.rank);
    return rows.map((r) => ({ ...r.score, name: r.name }));
  }

  async upsertVote(input: {
    roomId: string;
    memberId: string;
    placeId: string;
    value: 'yes' | 'no' | 'star';
    event: DomainEventInput;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.votes)
        .values({
          roomId: input.roomId,
          memberId: input.memberId,
          targetPlaceId: input.placeId,
          value: input.value,
        })
        .onConflictDoUpdate({
          target: [schema.votes.roomId, schema.votes.memberId, schema.votes.targetPlaceId],
          set: { value: input.value, updatedAt: sql`now()` },
        });
      await writeOutbox(tx, input.event);
    });
  }

  listVotes(roomId: string): Promise<VoteRow[]> {
    return this.db.select().from(schema.votes).where(eq(schema.votes.roomId, roomId));
  }
}

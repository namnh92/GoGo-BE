import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { METRICS, type MetricsPort } from '@gogo/observability';
import { CONTROL } from '../domain/assignment';
import { ExperimentsService, RANKING_EXPERIMENT } from './experiments.service';

/**
 * SG-010 — the latency a suggestion run is expected to fit in. Exceeding it is
 * not an error (a slow answer still beats no answer), but it is counted, so a
 * variant that wins on ranking and loses on speed is visible as both.
 */
export const SUGGESTION_LATENCY_BUDGET_MS = 3_000;
import { ROOM_EVENT_BUS, type RoomEventBus } from '../../realtime/application/room-event-bus';
import type { Actor } from '../../identity/domain/actor';
import { RoomPolicy } from '../../rooms/presentation/room-policy';
import { coupleMatches, resolveWinner, tallyVotes, type VoteRecord } from '../domain/decision';
import { rankWithFairness } from '../domain/fairness';
import { hardFilter } from '../domain/hard-filter';
import { scoreCandidate } from '../domain/scoring';
import {
  DEFAULT_SCORING_WEIGHTS,
  ENGINE_VERSION,
  SCORING_WEIGHT_BOUNDS,
  type ScoringWeights,
} from '../domain/types';
import { SuggestionsRepository } from '../infrastructure/suggestions.repository';
import { PlanBuilderService } from '../../plans/application/plan-builder.service';

const TOP_K = 10;

/** BE-BFF-007 — deterministic suggestion runs, votes, decisions (SG-002..006). */
@Injectable()
export class SuggestionService {
  constructor(
    private readonly repo: SuggestionsRepository,
    private readonly policy: RoomPolicy,
    private readonly planBuilder: PlanBuilderService,
    @Inject(DB) private readonly db: Db,
    @Inject(ROOM_EVENT_BUS) private readonly events: RoomEventBus,
    private readonly experiments: ExperimentsService,
    @Optional() @Inject(METRICS) private readonly metrics?: MetricsPort,
  ) {}

  /** Transport-only: a realtime failure never fails the write it describes. */
  private async publish(input: Parameters<RoomEventBus['publish']>[0]): Promise<void> {
    try {
      await this.events.publish(input);
    } catch {
      /* clients fall back to polling */
    }
  }

  /**
   * Versioned weights from ranking_configs with SG-001 bounds enforcement.
   *
   * SG-010: a variant names an **approved** config version to try. Approved,
   * not draft — an experiment must not be a way to put unreviewed weights in
   * front of users, and the four-eyes rule stays the gate. A variant naming a
   * version that is not approved falls back to the active config rather than
   * failing the run, and says so in the version string so the audit does not
   * claim the experiment ran.
   */
  private async activeWeights(
    variant?: string,
  ): Promise<{ weights: ScoringWeights; version: string }> {
    if (variant && variant !== CONTROL) {
      const candidate = await this.db.execute(sql`
        select version, weights from ranking_configs
        where key = 'suggestion.scoring'
          and version = ${Number(variant)}
          and status in ('approved', 'active')
        limit 1
      `);
      const row = candidate.rows[0] as
        { version: number; weights: Partial<ScoringWeights> } | undefined;
      if (row) return this.boundsChecked(row);
      // Falls through to the active config below.
    }

    const rows = await this.db.execute(sql`
      select version, weights from ranking_configs
      where key = 'suggestion.scoring' and status = 'active'
      order by version desc limit 1
    `);
    const row = rows.rows[0] as { version: number; weights: Partial<ScoringWeights> } | undefined;
    if (!row) return { weights: DEFAULT_SCORING_WEIGHTS, version: 'default' };
    return this.boundsChecked(row);
  }

  private boundsChecked(row: { version: number; weights: Partial<ScoringWeights> }): {
    weights: ScoringWeights;
    version: string;
  } {
    const merged: ScoringWeights = { ...DEFAULT_SCORING_WEIGHTS, ...row.weights };
    for (const [key, bound] of Object.entries(SCORING_WEIGHT_BOUNDS)) {
      const v = merged[key as keyof ScoringWeights];
      if (v < bound.min || v > bound.max) {
        // Out-of-bounds config is ignored, never partially applied.
        return { weights: DEFAULT_SCORING_WEIGHTS, version: 'default(bounds-rejected)' };
      }
    }
    return { weights: merged, version: String(row.version) };
  }

  /** SG-002..005 — run the deterministic pipeline and persist ranked scores. */
  async generate(actor: Actor, roomId: string) {
    const { room } = await this.policy.requireMember(actor, roomId);
    if (!['matching', 'collecting'].includes(room.status)) {
      throw AppError.conflict('ROOM_NOT_MATCHING', 'Room is not ready for suggestions');
    }

    // Announced before the work, so a second member sees a spinner rather
    // than an unexplained pause while the pipeline runs.
    await this.publish({ roomId, type: 'matching.started', payload: {} });

    const startedAt = Date.now();
    // SG-010: the room is the subject, never the member. Two people in one
    // room landing in different variants would compare two systems and call
    // it one experiment, and the plan would depend on who asked for it.
    const assignment = await this.experiments.assignmentFor(RANKING_EXPERIMENT, roomId);

    const snapshot = await this.repo.buildSnapshot(roomId);
    const { weights, version } = await this.activeWeights(assignment.variant);
    const run = await this.repo.createRun({
      roomId,
      constraintVersion: snapshot.constraintVersion,
      engineVersion: ENGINE_VERSION,
      weightsVersion: version,
      inputSnapshot: snapshot,
      ...(assignment.key ? { experimentKey: assignment.key } : {}),
      ...(assignment.key ? { experimentVariant: assignment.variant } : {}),
    });

    try {
      const candidates = await this.repo.retrieveCandidates(snapshot);
      const passed = candidates.filter((c) => hardFilter(c, snapshot).ok);
      const scored = passed.map((c) => scoreCandidate(c, snapshot, weights));
      const ranked = rankWithFairness(scored, { topK: TOP_K });
      await this.repo.persistScores(
        run.id,
        roomId,
        ranked.map((s, i) => ({
          placeId: s.candidate.placeId,
          rank: i + 1,
          scoreMicros: Math.round(s.score * 1e6),
          components: s.components,
          reasonCodes: s.reasonCodes,
        })),
        {
          eventType: 'suggestion.generated',
          resourceType: 'room',
          resourceId: roomId,
          payload: {
            runId: run.id,
            candidateCount: ranked.length,
            engineVersion: ENGINE_VERSION,
            weightsVersion: version,
          },
        },
      );
      const latencyMs = Date.now() - startedAt;
      await this.repo.finishRun(run.id, 'succeeded', undefined, latencyMs);
      // SG-010 cost/latency budget. Recorded per run and emitted with the
      // variant, because "the new weights are better" and "the new weights are
      // slower" are both results and only one of them shows up in ranking.
      this.metrics?.observe('suggestion_run_latency_ms', latencyMs, {
        variant: assignment.variant,
        weights_version: version,
      });
      if (latencyMs > SUGGESTION_LATENCY_BUDGET_MS) {
        this.metrics?.increment('suggestion_run_over_budget_total', {
          variant: assignment.variant,
        });
      }
      await this.publish({
        roomId,
        type: 'suggestions.generated',
        payload: {
          runId: run.id,
          candidateCount: ranked.length,
          engineVersion: ENGINE_VERSION,
          weightsVersion: version,
          // The version a client compares against to tell a stale event from
          // one describing the constraints it currently holds.
          constraintVersion: snapshot.constraintVersion,
        },
      });
      await this.publish({
        roomId,
        type: 'matching.completed',
        payload: { runId: run.id, candidateCount: ranked.length },
      });
      return this.current(actor, roomId);
    } catch (err) {
      await this.repo.finishRun(run.id, 'failed', 'PIPELINE_ERROR', Date.now() - startedAt);
      await this.publish({
        roomId,
        type: 'matching.failed',
        payload: { runId: run.id, reason: 'PIPELINE_ERROR' },
      });
      throw err;
    }
  }

  /** Current ranking + the caller's votes + aggregate progress. */
  async current(actor: Actor, roomId: string) {
    const { member, room } = await this.policy.requireMember(actor, roomId);
    const run = await this.repo.latestRun(roomId);
    if (!run) {
      return { run: null, candidates: [], votes: { mine: {}, progress: [] } };
    }
    const scores = await this.repo.scoresForRun(run.id);
    const votes = await this.repo.listVotes(roomId);
    const myVotes = Object.fromEntries(
      votes.filter((v) => v.memberId === member.id).map((v) => [v.targetPlaceId, v.value]),
    );
    const tally = tallyVotes(
      votes.map((v) => ({ memberId: v.memberId, placeId: v.targetPlaceId, value: v.value })),
    );
    return {
      run: {
        id: run.id,
        createdAt: run.createdAt.toISOString(),
        constraintVersion: run.constraintVersion,
        engineVersion: run.engineVersion,
        weightsVersion: run.weightsVersion,
        stale: scores.length > 0 && scores.every((s) => s.isStale),
      },
      decisionMode: room.decisionMode,
      candidates: scores.map((s) => ({
        placeId: s.placeId,
        name: s.name,
        rank: s.rank,
        score: s.scoreMicros / 1e6,
        components: s.components,
        reasonCodes: s.reasonCodes,
        stale: s.isStale,
        myVote: myVotes[s.placeId],
        points: tally.find((t) => t.placeId === s.placeId)?.points ?? 0,
      })),
      votes: {
        mine: myVotes,
        progress: tally,
      },
    };
  }

  /** FR-SUG-004 — idempotent vote; couple `match` auto-decides on full match. */
  async vote(actor: Actor, roomId: string, placeId: string, value: 'yes' | 'no' | 'star') {
    const { member, room } = await this.policy.requireMember(actor, roomId);
    if (room.status !== 'matching') {
      throw AppError.conflict('ROOM_NOT_MATCHING', 'Voting is not open for this room');
    }
    const run = await this.repo.latestRun(roomId);
    if (!run) throw AppError.conflict('NO_SUGGESTIONS', 'Generate suggestions first');
    const scores = await this.repo.scoresForRun(run.id);
    if (!scores.some((s) => s.placeId === placeId && !s.isStale)) {
      // Votes only land on current, allowlisted candidates.
      throw AppError.badRequest('NOT_A_CANDIDATE', 'Place is not in the current suggestions');
    }

    await this.repo.upsertVote({
      roomId,
      memberId: member.id,
      placeId,
      value,
      event: {
        eventType: 'vote.cast',
        resourceType: 'room',
        resourceId: roomId,
        payload: { placeId, value },
      },
    });

    // Facts only: who voted and on what. Never another member's full ballot —
    // FR-PREF-005 keeps selections private, and a realtime channel is not an
    // exception to that.
    await this.publish({
      roomId,
      type: 'vote.changed',
      actorId: member.id,
      payload: { memberId: member.id, placeId, runId: run.id },
    });

    if (room.decisionMode === 'match') {
      const votes = await this.repo.listVotes(roomId);
      const members = new Set(votes.map((v) => v.memberId));
      const records: VoteRecord[] = votes.map((v) => ({
        memberId: v.memberId,
        placeId: v.targetPlaceId,
        value: v.value,
      }));
      const matches = coupleMatches(records, [...members]);
      // Auto-decide only when every room member has voted on something.
      const memberCount = run.inputSnapshot
        ? (run.inputSnapshot as { memberPreferences: unknown[] }).memberPreferences.length
        : 2;
      if (matches.length > 0 && members.size >= memberCount) {
        const rankByPlace = new Map(scores.map((s) => [s.placeId, s.rank]));
        const best = [...matches].sort(
          (a, b) => (rankByPlace.get(a) ?? 1e9) - (rankByPlace.get(b) ?? 1e9),
        )[0]!;
        const plan = await this.planBuilder.buildAroundWinner(roomId, best, run.id);
        await this.publish({
          roomId,
          type: 'plan.updated',
          resourceType: 'plan',
          resourceId: plan.plan.id,
          payload: { planId: plan.plan.id, version: plan.plan.version, reason: 'matched' },
        });
        return { voted: true, matched: true, planId: plan.plan.id };
      }
    }
    return { voted: true, matched: false };
  }

  /** Host finalizes a vote/host decision; tie resolved by candidate rank. */
  async finalize(actor: Actor, roomId: string, explicitPlaceId?: string) {
    const { room } = await this.policy.requireHost(actor, roomId);
    if (room.status !== 'matching') {
      throw AppError.conflict('ROOM_NOT_MATCHING', 'Room is not in matching state');
    }
    const run = await this.repo.latestRun(roomId);
    if (!run) throw AppError.conflict('NO_SUGGESTIONS', 'Generate suggestions first');
    const scores = await this.repo.scoresForRun(run.id);

    let winner: string;
    let tie = false;
    if (explicitPlaceId) {
      // Host decision mode / host tie-break — still allowlisted only.
      if (!scores.some((s) => s.placeId === explicitPlaceId)) {
        throw AppError.badRequest('NOT_A_CANDIDATE', 'Place is not in the current suggestions');
      }
      winner = explicitPlaceId;
    } else {
      const votes = await this.repo.listVotes(roomId);
      const tally = tallyVotes(
        votes.map((v) => ({ memberId: v.memberId, placeId: v.targetPlaceId, value: v.value })),
      );
      const resolved = resolveWinner(tally, new Map(scores.map((s) => [s.placeId, s.rank])));
      if (!resolved.winnerPlaceId) {
        throw AppError.conflict('NO_VOTES', 'No votes to finalize');
      }
      winner = resolved.winnerPlaceId;
      tie = resolved.tie;
    }

    const plan = await this.planBuilder.buildAroundWinner(roomId, winner, run.id);
    return { finalized: true, tie, winnerPlaceId: winner, planId: plan.plan.id };
  }
}

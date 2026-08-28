import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { SuggestionsRepository } from '../../suggestions/infrastructure/suggestions.repository';
import { hardFilter } from '../../suggestions/domain/hard-filter';
import { scoreCandidate } from '../../suggestions/domain/scoring';
import { rankWithFairness } from '../../suggestions/domain/fairness';
import {
  DEFAULT_SCORING_WEIGHTS,
  SCORING_WEIGHT_BOUNDS,
  type RoomSnapshot,
  type ScoringWeights,
} from '../../suggestions/domain/types';

/**
 * SG-010 (#49) — offline evaluation.
 *
 * Every suggestion run stores the immutable snapshot it was computed from, so
 * a candidate ranking config can be replayed against real rooms **before**
 * anyone is exposed to it. This is the thing that makes activating a config a
 * decision rather than a hope.
 *
 * Offline in the strict sense: it reads snapshots, scores in memory, and
 * writes nothing. No plan, no run, no user sees any of it.
 */
export type EvaluationResult = {
  configVersion: number;
  baselineVersion: string;
  runsEvaluated: number;
  metrics: {
    /** Share of runs whose top result is unchanged. */
    top1Agreement: number;
    /** Mean overlap of the top 5 — how much the ordering moved overall. */
    top5Overlap: number;
    /** Runs where the candidate returns nothing and the baseline returned something. */
    newZeroResults: number;
    meanCandidateCount: number;
  };
  /** Runs the candidate config could not be evaluated on, and why. */
  skipped: { runId: string; reason: string }[];
};

const TOP_K = 5;

@Injectable()
export class RankingEvaluationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly suggestions: SuggestionsRepository,
  ) {}

  async evaluate(configId: string, sampleSize: number): Promise<EvaluationResult> {
    const configRows = await this.db.execute(sql`
      select version, weights, status from ranking_configs where id = ${configId}::uuid
    `);
    const config = configRows.rows[0] as
      { version: number; weights: Partial<ScoringWeights>; status: string } | undefined;
    if (!config) throw AppError.notFound('CONFIG_NOT_FOUND', 'Ranking config not found');

    const candidateWeights = this.merged(config.weights);
    if (!candidateWeights) {
      // A config outside the engine's own bounds is not evaluated at all: any
      // number produced from it would describe weights the engine would have
      // refused anyway.
      throw AppError.badRequest(
        'WEIGHTS_OUT_OF_BOUNDS',
        'Config weights are outside SG-001 bounds',
      );
    }

    const activeRows = await this.db.execute(sql`
      select version, weights from ranking_configs
      where key = 'suggestion.scoring' and status = 'active'
      order by version desc limit 1
    `);
    const activeRow = activeRows.rows[0] as
      { version: number; weights: Partial<ScoringWeights> } | undefined;
    const baselineWeights = activeRow ? this.merged(activeRow.weights) : DEFAULT_SCORING_WEIGHTS;
    const baselineVersion = activeRow ? String(activeRow.version) : 'default';

    // Succeeded runs only: a failed run's snapshot describes a room the
    // pipeline never got through, so scoring it says nothing about ranking.
    const runs = await this.db.execute(sql`
      select id, input_snapshot from suggestion_runs
      where status = 'succeeded'
      order by created_at desc
      limit ${sampleSize}
    `);

    const skipped: { runId: string; reason: string }[] = [];
    let top1Same = 0;
    let overlapSum = 0;
    let newZeros = 0;
    let candidateCountSum = 0;
    let evaluated = 0;

    for (const raw of runs.rows as { id: string; input_snapshot: RoomSnapshot }[]) {
      const snapshot = raw.input_snapshot;
      let candidates;
      try {
        candidates = await this.suggestions.retrieveCandidates(snapshot);
      } catch (err) {
        skipped.push({ runId: raw.id, reason: String(err).slice(0, 120) });
        continue;
      }
      const passed = candidates.filter((c) => hardFilter(c, snapshot).ok);
      if (passed.length === 0) {
        // Nothing to compare: both configs would return the same nothing, and
        // counting it as agreement would flatter every candidate config.
        skipped.push({ runId: raw.id, reason: 'no candidates passed hard filters' });
        continue;
      }

      const rank = (weights: ScoringWeights) =>
        rankWithFairness(
          passed.map((c) => scoreCandidate(c, snapshot, weights)),
          { topK: TOP_K },
        ).map((s) => s.candidate.placeId);

      const baseline = rank(baselineWeights ?? DEFAULT_SCORING_WEIGHTS);
      const candidate = rank(candidateWeights);

      evaluated += 1;
      candidateCountSum += candidate.length;
      if (baseline[0] !== undefined && baseline[0] === candidate[0]) top1Same += 1;
      if (candidate.length === 0 && baseline.length > 0) newZeros += 1;

      const overlap = candidate.filter((id) => baseline.includes(id)).length;
      overlapSum += baseline.length === 0 ? 0 : overlap / Math.min(TOP_K, baseline.length);
    }

    const ratio = (n: number) => (evaluated === 0 ? 0 : Number((n / evaluated).toFixed(4)));

    return {
      configVersion: config.version,
      baselineVersion,
      runsEvaluated: evaluated,
      metrics: {
        top1Agreement: ratio(top1Same),
        top5Overlap: evaluated === 0 ? 0 : Number((overlapSum / evaluated).toFixed(4)),
        newZeroResults: newZeros,
        meanCandidateCount:
          evaluated === 0 ? 0 : Number((candidateCountSum / evaluated).toFixed(2)),
      },
      skipped,
    };
  }

  /** Null when any weight is outside the engine's own bounds. */
  private merged(weights: Partial<ScoringWeights>): ScoringWeights | null {
    const merged: ScoringWeights = { ...DEFAULT_SCORING_WEIGHTS, ...weights };
    for (const [key, bound] of Object.entries(SCORING_WEIGHT_BOUNDS)) {
      const value = merged[key as keyof ScoringWeights];
      if (value < bound.min || value > bound.max) return null;
    }
    return merged;
  }
}

import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { METRICS, type MetricsPort } from '@gogo/observability';
import { DB } from '../../shared/tokens';
import { assign, CONTROL } from '../domain/assignment';

/**
 * SG-010 (#49) — which variant a room is in, and whether it is in one at all.
 *
 * Definitions are read per call rather than cached: the kill switch has to
 * take effect on the next request, and a cache measured in minutes would mean
 * an experiment that cannot actually be stopped.
 */
export type Assignment = {
  /** Null when no experiment is defined — which is not the same as control. */
  key: string | null;
  variant: string;
};

@Injectable()
export class ExperimentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(METRICS) private readonly metrics?: MetricsPort,
  ) {}

  async assignmentFor(experimentKey: string, subjectId: string): Promise<Assignment> {
    const [experiment] = await this.db
      .select()
      .from(schema.experiments)
      .where(eq(schema.experiments.key, experimentKey))
      .limit(1);

    // Undefined and disabled both behave as control for the pipeline, and are
    // recorded differently: "no experiment ran" and "the experiment ran and
    // this room was control" are different facts about a result.
    if (!experiment) return { key: null, variant: CONTROL };
    if (!experiment.enabled) return { key: experimentKey, variant: CONTROL };

    const variant = assign(experimentKey, subjectId, experiment.variants);
    this.metrics?.increment('experiment_assignment_total', { experiment: experimentKey, variant });
    return { key: experimentKey, variant };
  }
}

/** The experiment the suggestion engine reads, if one is defined. */
export const RANKING_EXPERIMENT = 'suggestion.ranking';

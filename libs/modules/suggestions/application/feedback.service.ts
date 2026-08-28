import { Inject, Injectable, Optional } from '@nestjs/common';
import { schema, type Db } from '@gogo/database';
import {
  FEEDBACK_PARSER,
  KeywordFeedbackParser,
  ProviderQuotaExceededError,
  type FeedbackParseInput,
  type FeedbackParserPort,
} from '@gogo/providers';
import { METRICS, type MetricsPort } from '@gogo/observability';
import { DB } from '../../shared/tokens';
import { validateFeedback, type FeedbackContext, type ValidatedFeedback } from '../domain/feedback';

export const AI_FEEDBACK_ENABLED = Symbol('AI_FEEDBACK_ENABLED');
/** Overridable timeout, so the timeout path is testable without waiting 15s. */
export const FEEDBACK_TIMEOUT_OVERRIDE = Symbol('FEEDBACK_TIMEOUT_OVERRIDE');

/**
 * Hard ceiling from the AI guardrails. A plan regenerate that waits longer
 * than this for a parse has already failed the user, whatever the model
 * eventually says.
 */
export const FEEDBACK_TIMEOUT_MS = 15_000;

/**
 * Why the AI path did or did not produce the applied result. `disabled` is the
 * normal MVP value — the flag is off and the deterministic parser did the work.
 * Everything except `accepted` means the deterministic parser produced the
 * result instead.
 */
export type FeedbackOutcome =
  'accepted' | 'rejected' | 'disabled' | 'timeout' | 'quota' | 'provider_error';

export type FeedbackResult = ValidatedFeedback & {
  outcome: FeedbackOutcome;
  /** The parser whose output was actually applied. */
  modelVersion: string;
};

/**
 * SG-009 (#48) — natural-language feedback, guarded.
 *
 * The deterministic pipeline is the source of truth; this only turns a
 * sentence into structured constraints that the pipeline then honours or
 * ignores on its own terms.
 *
 * Every failure mode lands in the same place: the deterministic keyword parser.
 * Disabled by flag, timed out, out of quota, provider down, or output that
 * fails validation — all of them fall back rather than surfacing an error,
 * because the user asked for a different plan, not for a report about a model.
 */
@Injectable()
export class FeedbackService {
  private readonly deterministic = new KeywordFeedbackParser();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(FEEDBACK_PARSER) private readonly parser?: FeedbackParserPort,
    @Optional() @Inject(AI_FEEDBACK_ENABLED) private readonly enabled = false,
    @Optional() @Inject(METRICS) private readonly metrics?: MetricsPort,
    @Optional()
    @Inject(FEEDBACK_TIMEOUT_OVERRIDE)
    private readonly timeoutMs: number = FEEDBACK_TIMEOUT_MS,
  ) {}

  async interpret(
    input: FeedbackParseInput,
    context: FeedbackContext,
    audit: { planId: string; roomId: string; memberId?: string | undefined },
  ): Promise<FeedbackResult> {
    const startedAt = Date.now();
    // The kill switch is checked first and is mandatory: an AI path that
    // cannot be turned off is not a path that can be operated.
    const attempt =
      this.enabled && this.parser
        ? await this.tryParser(this.parser, input, context)
        : { outcome: 'disabled' as FeedbackOutcome, result: null };

    // One fallback, for every outcome except acceptance. That single path is
    // what makes "provider failure falls back deterministically" true rather
    // than aspirational — there is no branch where a failure surfaces to the
    // user instead, because they asked for a different plan, not for a report
    // about a model.
    const result =
      attempt.result ?? validateFeedback(await this.deterministic.parse(input), context);
    const outcome = attempt.outcome;
    const modelVersion = attempt.result
      ? this.parser!.modelVersion
      : this.deterministic.modelVersion;

    const latencyMs = Date.now() - startedAt;
    await this.record({ ...audit, modelVersion, outcome, result, input, latencyMs });
    this.metrics?.increment('ai_feedback_runs_total', { outcome });

    return { ...result, outcome, modelVersion };
  }

  /**
   * Runs the provider and validates it. Returns a result only when the output
   * survived validation *and* meant something: output that fails either is
   * never partially applied, because half-understood feedback silently
   * changing a plan is worse than feedback that plainly did not land.
   */
  private async tryParser(
    parser: FeedbackParserPort,
    input: FeedbackParseInput,
    context: FeedbackContext,
  ): Promise<{ outcome: FeedbackOutcome; result: ValidatedFeedback | null }> {
    try {
      const validated = validateFeedback(await this.withTimeout(parser, input), context);
      return validated.understood
        ? { outcome: 'accepted', result: validated }
        : { outcome: 'rejected', result: null };
    } catch (err) {
      if (err instanceof ProviderQuotaExceededError) return { outcome: 'quota', result: null };
      const aborted = err instanceof Error && err.name === 'AbortError';
      return { outcome: aborted ? 'timeout' : 'provider_error', result: null };
    }
  }

  private async withTimeout(
    parser: FeedbackParserPort,
    input: FeedbackParseInput,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await parser.parse(input, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private async record(entry: {
    planId: string;
    roomId: string;
    memberId?: string | undefined;
    modelVersion: string;
    outcome: FeedbackOutcome;
    result: ValidatedFeedback;
    input: FeedbackParseInput;
    latencyMs: number;
  }): Promise<void> {
    try {
      await this.db.insert(schema.aiFeedbackRuns).values({
        planId: entry.planId,
        roomId: entry.roomId,
        memberId: entry.memberId ?? null,
        modelVersion: entry.modelVersion,
        outcome: entry.outcome,
        reasonCodes: entry.result.rejected,
        // Length, not the text: the member's words are the input, and storing
        // arbitrary user text where nothing reads it is not worth the risk.
        inputLength: entry.input.text.length,
        candidateCount: entry.input.allowedPlaceIds.length,
        applied: entry.result.applied,
        latencyMs: entry.latencyMs,
      });
    } catch {
      /* an audit write must not fail the regenerate it describes */
    }
  }
}

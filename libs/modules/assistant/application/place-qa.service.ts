import { Injectable, Inject, Optional } from '@nestjs/common';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { SearchService } from '../../search/application/search.service';
import { normalizeVietnamese } from '../../search/domain/normalize';
import { AssistantRepository, type MessageRow } from '../infrastructure/assistant.repository';
import {
  PlaceQaClassifier,
  isNewNonQaRequest,
  type QaClassification,
  type QaArgs,
  type QaClass,
} from '../domain/place-qa/classifier';
import { PLACE_QA_CONFIG_VERSION } from '../domain/place-qa/config';
import {
  confirmText,
  choiceText,
  choiceDiscriminator,
  makeQaPending,
  readQaPending,
  isTypedConfirm,
  type QaPending,
} from '../domain/place-qa/pending';
import { answerToken, type AnswerTopic } from '../domain/place-qa/tokens';
import { placeToken } from '../domain/place-tokens';
import { UNPRODUCED_GROUP, type PlaceAnswerGroup } from '../domain/place-qa/reference-group';
import { renderPlaceAnswer } from '../domain/place-qa/templates';
import type { QaCopyKey } from '../domain/place-qa/copy';
import type { PlaceNameArea } from '../domain/place-qa/resolution';
import { COPY_KEYS } from '../domain/assistant.types';
import { AssistantAreaResolver } from './area-resolver.service';
import { AssistantTaxonomyService } from './taxonomy.service';
import { AssistantAvailabilityService } from './assistant-availability.service';
import type { TurnInput } from './assistant-orchestrator.service';
import { firstTextGuard } from './first-text-guard';
import type { TurnSink, TurnState } from './turn-state';

type QaOutcome =
  QaCopyKey | 'answer' | 'no_data' | 'choice' | 'confirm' | 'unavailable' | 'cancelled' | 'timeout';
type QaTrace = {
  configVersion: string;
  class: QaClass | 'control';
  topic: AnswerTopic;
  args: QaArgs;
  row: 1 | 2 | 3 | 4 | 5 | 6 | null;
  tier: 'verified_current' | 'verified_reference' | 'absent' | 'unavailable';
  outcome: QaOutcome;
  candidateIds: readonly string[];
  questionMessageId: string;
  pending?: QaPending;
};

/** Bound on the flag read that settles an undecided QA question at the deadline. */
const QA_SETTLE_FLAG_MS = 1_500;

/** S3 producer. One admitted turn; no model, card hydrator or recommendation state. */
@Injectable()
export class PlaceQaService {
  private readonly classifier = new PlaceQaClassifier();
  constructor(
    private readonly repo: AssistantRepository,
    private readonly search: SearchService,
    private readonly areas: AssistantAreaResolver,
    private readonly availability: AssistantAvailabilityService,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
    @Optional() private readonly qaTaxonomy?: AssistantTaxonomyService,
  ) {}

  /** One cleanup budget, including flag lookup and the cancellable SQL write.
   * Failure retains uncertain exclusion; it never establishes a QA route.
   */
  async settleUndecided(
    input: TurnInput,
    state: TurnState,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<boolean> {
    if (state.qaDecided === true || !input.qaProbe || input.qaProbe === 'control') return false;
    const deadlineAt = Date.now() + QA_SETTLE_FLAG_MS;
    const guard = firstTextGuard(deadlineAt, signal);
    try {
      const qa = await guard.run(async () => {
        let enabled = state.qaEnabled ?? false;
        if (state.qaEnabled === undefined && input.qaProbe === 'question') {
          const flagDeadline = Date.now() + QA_SETTLE_FLAG_MS / 2;
          const flagGuard = firstTextGuard(flagDeadline, guard.signal);
          try {
            enabled = await flagGuard.run(() =>
              this.availability.placeQaEnabled({
                signal: flagGuard.signal,
                deadlineAt: flagDeadline,
              }),
            );
          } catch {
            enabled = false;
          } finally {
            flagGuard.dispose();
          }
          guard.signal.throwIfAborted();
          state.qaEnabled = enabled;
        }
        return this.repo.settleQaProbe(input.messageId, enabled, {
          signal: guard.signal,
          deadlineAt,
        });
      });
      signal.throwIfAborted();
      state.qaDecided = true;
      if (qa) {
        state.trace.route = 'place_qa';
        state.trace.placeAnswerGroup ??= UNPRODUCED_GROUP;
      }
      return qa;
    } catch (error) {
      // A stalled flag is disabled, but a stalled UPDATE cannot be called
      // settled. Finalization preserves the probe until safe recovery.
      state.qaSettlementUncertain = true;
      throw error;
    } finally {
      guard.dispose();
    }
  }

  /** Idempotent for one turn: the in-process marker first, then the durable row. */
  private async fence(input: TurnInput, state: TurnState): Promise<string> {
    if (state.trace.route === 'place_qa' && typeof state.trace.questionMessageId === 'string')
      return state.trace.questionMessageId;
    // Set the in-process marker before awaiting persistence, too. A stop or
    // first-text deadline cannot reclassify this turn as a recommendation.
    state.trace.route = 'place_qa';
    const questionId = await this.repo.markPlaceQa(
      input.userId,
      input.conversationId,
      input.messageId,
    );
    if (!questionId) throw new Error('Place QA route fence lost');
    state.trace.questionMessageId = questionId;
    // A fenced turn that ends before it produces a group reads as the fixed
    // load-error notice, exactly like one cancelled during resolution.
    state.trace.placeAnswerGroup ??= UNPRODUCED_GROUP;
    return questionId;
  }

  async handle(
    input: TurnInput,
    state: TurnState,
    sink: TurnSink,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<boolean> {
    const started = Date.now();
    const now = new Date(started);
    let classified = this.classifier.classify(input.text, input.context, {
      now,
      locale: input.locale,
    });
    const structured = input.replyToMessageId !== undefined || input.followUpOptionId !== undefined;
    const typedControl = isTypedConfirm(input.text);
    let trace: QaTrace | undefined;
    let undecided = false;
    let pendingCreatedAt: number | undefined;
    // The message the place name is read from, when it is not the question
    // itself (a name supplied after a referent clarification). Astra F-01.
    let nameSourceId: string | undefined;
    const mark = async (kind: QaTrace['class'], topic: AnswerTopic, args: QaArgs) => {
      const questionId = await this.fence(input, state);
      trace = {
        configVersion: PLACE_QA_CONFIG_VERSION,
        class: kind,
        topic,
        args,
        row: null,
        tier: 'absent',
        outcome: 'clarify_referent',
        candidateIds: [],
        questionMessageId: questionId,
      };
      state.trace.placeQa = trace;
      // No dispatch occurred; these are known zeros, not missing provider evidence.
      state.costs.jevCostUsd = 0;
      state.costs.haikuUpstreamCostUsd = 0;
      state.costs.haikuOpenrouterCostUsd = 0;
    };
    const group = async (g: PlaceAnswerGroup, text = '') => {
      signal.throwIfAborted();
      state.trace.placeAnswerGroup = g;
      // An empty reference group still needs a delta slot for fixed reader copy.
      await sink.emit({ type: 'delta', text });
      for (const placeId of g.cards)
        await sink.emit({ type: 'card', card: { kind: 'place', placeId } });
      await sink.emit({ type: 'sources', sources: [] });
      await sink.emit({ type: 'follow_ups', groups: [] });
    };
    const notice = async (key: QaCopyKey) => {
      trace!.outcome = key;
      await group({ v: 1, kind: 'notice', message: key, cards: [], sources: [], options: [] });
      if (key === 'not_found')
        await sink.emit({ type: 'notice', notice: { kind: 'empty', copyKey: COPY_KEYS.empty } });
    };
    const pending = (
      kind: QaPending['kind'],
      questionMessageId: string,
      candidates: readonly string[] = [],
      retryCount = 0,
    ) => {
      const p = makeQaPending({
        kind,
        questionMessageId,
        sourceMessageId: nameSourceId,
        assistantMessageId: input.messageId,
        now: pendingCreatedAt ?? started,
        topic: trace!.topic,
        args: trace!.args,
        candidates,
        retryCount,
      });
      trace!.pending = p;
      return p;
    };
    const clarify = async (
      kind: 'choice' | 'confirm',
      ids: readonly string[],
      source: string,
      legacyArea = false,
      retryCount = 0,
    ) => {
      trace!.outcome = kind;
      trace!.candidateIds = ids;
      const p = pending(kind, source, ids, retryCount);
      await group(
        {
          v: 1,
          kind: 'clarification',
          prompt: kind === 'choice' ? 'place_choice' : 'place_confirm',
          ...(legacyArea ? { legacyArea: true } : {}),
          cards: ids,
          sources: [],
          options: p.options.map((o) =>
            o.key === 'place'
              ? { id: o.optionId, placeId: o.placeId! }
              : { id: o.optionId, none: true },
          ),
        },
        ids.map(placeToken).join(', '),
      );
    };
    const answer = async (placeId: string) => {
      const query = { placeId, locale: input.locale, topic: trace!.topic, ...trace!.args };
      const facts = await this.search.placeFacts([placeId], { signal, deadlineAt });
      signal.throwIfAborted();
      const rendered = renderPlaceAnswer(query, facts);
      trace!.candidateIds = [placeId];
      trace!.outcome = rendered.unavailable
        ? 'unavailable'
        : rendered.eligible
          ? 'answer'
          : 'no_data';
      trace!.tier = rendered.tier;
      const token = answerToken(query);
      await group({ v: 1, kind: 'answer', cards: [placeId], sources: [token], options: [] }, token);
    };
    // Both references of a pending state, each re-read under the current user
    // and conversation (deleted, expired or foreign rows read as missing).
    const sourcesOf = async (p: QaPending) => {
      const question = await this.repo.findMessage(
        input.userId,
        input.conversationId,
        p.questionMessageId,
      );
      const nameId = p.slots[0]!.sourceMessageId;
      const name =
        nameId === p.questionMessageId
          ? question
          : await this.repo.findMessage(input.userId, input.conversationId, nameId);
      if (!question || question.role !== 'user' || !name || name.role !== 'user') return null;
      nameSourceId = name.id === question.id ? undefined : name.id;
      return { question, name };
    };
    const resolve = async (
      c: Extract<QaClassification, { kind: 'named_place_question' | 'name_only' }>,
      // Read after qualification: a fresh name-only turn has no trace before it.
      sourceOf: () => string,
      areaOverride?: PlaceNameArea,
      continuationText?: string,
    ) => {
      const area =
        areaOverride ?? (c.span.statedArea ? await this.area(c.span.statedArea) : undefined);
      const result = await this.search.resolvePlaceName(c.span.text, {
        signal,
        deadlineAt,
        ...(area ? { area } : {}),
        alternates: c.span.alternates,
      });
      signal.throwIfAborted();
      // Name-only needs canonical equality of the WHOLE text (§3.1). A pending
      // area refinement is already QA: validate the original source, not the
      // area reply, and keep its fence even when the refined query has no match.
      if (
        c.kind === 'name_only' &&
        ((continuationText === undefined && !result.candidates.some((x) => x.exact)) ||
          normalizeVietnamese(c.span.text) !==
            normalizeVietnamese((continuationText ?? input.text).trim().replace(/[?!]+$/u, '')))
      ) {
        if (continuationText !== undefined) {
          await notice('restate');
          return true;
        }
        // An unqualified probe wrote nothing: this is an ordinary turn.
        return false;
      }
      // Qualified: only now does a fresh name-only turn become QA.
      if (!trace) await mark(c.kind, c.topic, c.args);
      if (c.kind === 'name_only') await sink.emit({ type: 'step', step: 'searching_places' });
      trace!.row = result.row;
      const ids = result.candidates.map((x) => x.id);
      if (result.kind === 'answer') await answer(ids[0]!);
      else if (result.kind === 'choice' || result.kind === 'confirm')
        await clarify(result.kind, ids, sourceOf(), area?.kind === 'legacy');
      else {
        if (result.kind === 'narrow') pending('narrow', sourceOf());
        await notice(result.kind);
      }
      return true;
    };

    try {
      if (!structured && isNewNonQaRequest(input.text)) return false;
      // Structured QA control is fenced before all control/source lookups,
      // including when disabled. It can never enter the model pipeline.
      if (structured || typedControl) await mark('control', 'overview', {});
      state.qaEnabled = false; // Unknown stays disabled, including cancellation before the read settles.
      const flagGuard = firstTextGuard(
        Math.min(deadlineAt, Date.now() + QA_SETTLE_FLAG_MS),
        signal,
      );
      let enabled: boolean;
      try {
        enabled = await flagGuard.run(() =>
          this.availability.placeQaEnabled({
            signal: flagGuard.signal,
            deadlineAt: Math.min(deadlineAt, Date.now() + QA_SETTLE_FLAG_MS),
          }),
        );
      } catch {
        enabled = false;
      } finally {
        flagGuard.dispose();
      }
      state.qaEnabled = enabled;
      // Producer observation wins even if this process dies before the route
      // fence or first ordinary frame. Never continue without a durable latch.
      const observationDeadline = Math.min(deadlineAt, Date.now() + QA_SETTLE_FLAG_MS);
      const observationGuard = firstTextGuard(observationDeadline, signal);
      try {
        const persisted = await observationGuard.run(() =>
          this.repo.persistQaEnabled(input.userId, input.conversationId, input.messageId, enabled, {
            signal: observationGuard.signal,
            deadlineAt: observationDeadline,
          }),
        );
        if (!persisted) throw new Error('Place QA flag observation lost');
      } finally {
        observationGuard.dispose();
      }
      signal.throwIfAborted();
      // A bare name is only a probe here: it becomes QA after exact canonical
      // qualification (resolve) or as a typed reply to a QA turn, never before.
      if (!structured && enabled && classified.kind !== 'not_qa' && classified.kind !== 'name_only')
        await mark(classified.kind, classified.topic, classified.args);
      if (
        !structured &&
        enabled &&
        trace &&
        this.qaTaxonomy &&
        classified.kind !== 'not_qa' &&
        ['amenity', 'parking', 'suitability', 'out_of_data'].includes(classified.topic)
      ) {
        const vocabulary = await this.qaTaxonomy.qaVocabulary();
        signal.throwIfAborted();
        classified = this.classifier.classify(input.text, input.context, {
          now,
          locale: input.locale,
          vocabulary,
        });
        if (classified.kind !== 'not_qa') {
          trace.class = classified.kind;
          trace.topic = classified.topic;
          trace.args = classified.args;
        }
      }
      const freshQuestion =
        !structured &&
        !isTypedConfirm(input.text) &&
        classified.kind !== 'not_qa' &&
        classified.kind !== 'name_only';
      if (!enabled && freshQuestion) return false;
      const latest = freshQuestion
        ? null
        : await this.repo.latestAssistant(input.userId, input.conversationId, input.messageId);
      signal.throwIfAborted();
      const isQa = latest?.trace?.route === 'place_qa';
      if (typedControl && !structured && !isQa) {
        await notice('stale_choice');
        return true;
      }
      const qa = latest?.trace?.placeQa as { pending?: unknown } | undefined;
      const p =
        latest && latest.status === 'complete'
          ? readQaPending(qa?.pending, latest.id, started)
          : null;
      if (structured) {
        if (
          !latest ||
          !isQa ||
          latest.id !== input.replyToMessageId ||
          !p ||
          !input.followUpOptionId
        ) {
          await notice('stale_choice');
          return true;
        }
        const option = p.options.find((o) => o.optionId === input.followUpOptionId);
        if (!option) {
          await notice('stale_choice');
          return true;
        }
        if (!enabled) {
          await notice('disabled');
          return true;
        }
        if (!(await sourcesOf(p))) {
          await notice('stale_choice');
          return true;
        }
        trace!.topic = p.topic;
        trace!.args = p.args;
        pendingCreatedAt = Date.parse(p.createdAt);
        if (option.key === 'none') {
          pending('narrow', p.questionMessageId);
          await notice('narrow');
        } else {
          trace!.row = 3;
          await answer(option.placeId!);
        }
        return true;
      }
      if (continuesQa(latest, input.text, classified)) {
        await mark('control', p?.topic ?? 'overview', p?.args ?? {});
        if (!enabled) {
          await notice('disabled');
          return true;
        }
        if (!p) {
          if (classified.kind === 'name_only' && input.text.trim().split(/\s+/u).length > 1) {
            const fresh = await this.search.resolvePlaceName(input.text.trim(), {
              signal,
              deadlineAt,
            });
            signal.throwIfAborted();
            const exact = fresh.candidates.filter((c) => c.exact);
            if (exact.length) {
              trace!.class = 'name_only';
              trace!.topic = 'overview';
              trace!.args = {};
              trace!.row = fresh.row;
              if (fresh.kind === 'answer') await answer(exact[0]!.id);
              else if (fresh.kind === 'choice' || fresh.kind === 'confirm')
                await clarify(
                  fresh.kind,
                  fresh.candidates.map((c) => c.id),
                  trace!.questionMessageId,
                );
              else {
                if (fresh.kind === 'narrow') pending('narrow', trace!.questionMessageId);
                await notice(fresh.kind);
              }
              return true;
            }
          }
          await notice('stale_choice');
          return true;
        }
        pendingCreatedAt = Date.parse(p.createdAt);
        const sources = await sourcesOf(p);
        if (!sources) {
          await notice('stale_choice');
          return true;
        }
        const t = normalizeVietnamese(input.text)
          .replace(/[.!?]+$/u, '')
          .trim();
        if (/^(?:khong phai cac quan nay|none of these)$/u.test(t)) {
          pending('narrow', p.questionMessageId);
          await notice('narrow');
          return true;
        }
        const candidates = p.slots[0]!.candidateIds ?? [];
        const confirming = p.kind === 'confirm' && candidates.length === 1;
        if (isTypedConfirm(input.text)) {
          if (confirming) {
            const facts = await this.search.placeFacts(candidates, { signal, deadlineAt });
            const candidate = facts.places.get(candidates[0]!);
            const phrase = candidate?.available
              ? confirmText(
                  latest?.locale ?? 'vi',
                  candidate.name,
                  candidate.areaLabel,
                  choiceDiscriminator(candidate, [...facts.places.values()]),
                )
              : null;
            if (phrase && normalizeVietnamese(phrase) === t) {
              // Re-read the complete canonical-name family, not just the last
              // singleton: identical labels on another branch must re-ask.
              const family = await this.search.resolvePlaceName(candidate!.name, {
                signal,
                deadlineAt,
              });
              const ids = family.candidates.filter((c) => c.exact).map((c) => c.id);
              if (!family.overflow && ids.includes(candidates[0]!)) {
                const all = await this.search.placeFacts(ids, { signal, deadlineAt });
                const matching = ids.filter((id) => {
                  const place = all.places.get(id);
                  const identity = place?.available
                    ? confirmText(
                        latest?.locale ?? 'vi',
                        place.name,
                        place.areaLabel,
                        choiceDiscriminator(place, [...all.places.values()]),
                      )
                    : null;
                  return identity !== null && normalizeVietnamese(identity) === t;
                });
                if (matching.length === 1 && matching[0] === candidates[0]) {
                  trace!.row = 3;
                  await answer(matching[0]!);
                  return true;
                }
              }
            }
          }
          if (p.retryCount === 0) {
            pending(p.kind, p.questionMessageId, candidates, 1);
            await notice('retry');
          } else await notice('restate');
          return true;
        }
        const ordinal = /^(?:quan |chi nhanh |so |place )?([1-3])$/u.exec(t);
        if (ordinal && candidates[Number(ordinal[1]) - 1]) {
          // Old clients' text is not proof of which source chip was tapped.
          await clarify('confirm', [candidates[Number(ordinal[1]) - 1]!], p.questionMessageId);
          return true;
        }
        if (candidates.length) {
          const facts = await this.search.placeFacts(candidates, { signal, deadlineAt });
          const named = candidates.filter((id) => {
            const f = facts.places.get(id);
            return (
              f?.available &&
              [f.name, choiceText(f, [...facts.places.values()])].some(
                (identity) =>
                  normalizeVietnamese(identity) ===
                  t.replace(/^(?:xac nhan|dung la|confirm) /u, ''),
              )
            );
          });
          if (named.length) {
            await clarify(named.length === 1 ? 'confirm' : 'choice', named, p.questionMessageId);
            return true;
          }
        }
        const a = await this.area(input.text);
        if (a.kind === 'current') {
          // The whole name query is rerun from the name-bearing message; the
          // topic, arguments and lifetime stay those of the original question.
          const original = this.classifier.classify(sources.name.text, null, {
            now: new Date(p.createdAt),
            locale: sources.name.locale ?? input.locale,
          });
          if (original.kind === 'named_place_question' || original.kind === 'name_only') {
            return await resolve(original, () => sources.question.id, a, sources.name.text);
          }
        }
        if (classified.kind === 'name_only') {
          const fresh = await this.search.resolvePlaceName(input.text.trim(), {
            signal,
            deadlineAt,
          });
          signal.throwIfAborted();
          if (fresh.candidates.some((c) => c.exact)) {
            trace!.class = 'name_only';
            if (p.kind !== 'referent') {
              trace!.topic = 'overview';
              trace!.args = {};
              pendingCreatedAt = undefined;
              nameSourceId = undefined;
            } else {
              // This reply carries the name; the question keeps its own id.
              nameSourceId =
                trace!.questionMessageId === p.questionMessageId
                  ? undefined
                  : trace!.questionMessageId;
            }
            trace!.row = fresh.row;
            const ids = fresh.candidates.map((c) => c.id);
            const source = p.kind === 'referent' ? p.questionMessageId : trace!.questionMessageId;
            if (fresh.kind === 'answer') await answer(ids[0]!);
            else if (fresh.kind === 'choice' || fresh.kind === 'confirm')
              await clarify(fresh.kind, ids, source);
            else {
              if (fresh.kind === 'narrow') pending('narrow', source);
              await notice(fresh.kind);
            }
            return true;
          }
        }
        if (p.retryCount === 0) {
          pending(p.kind, p.questionMessageId, candidates, 1);
          await notice('retry');
        } else await notice('restate');
        return true;
      }
      if (!enabled || classified.kind === 'not_qa') return false;
      if (!trace && classified.kind !== 'name_only')
        await mark(classified.kind, classified.topic, classified.args);
      if (classified.kind === 'compare') {
        await notice('unsupported');
        trace!.outcome = 'unavailable';
        return true;
      }
      if (classified.kind === 'clarify_referent') {
        pending('referent', trace!.questionMessageId);
        await notice('clarify_referent');
        return true;
      }
      if (classified.kind === 'referent_question') {
        if (input.context?.kind === 'place') {
          trace!.row = 3;
          await answer(input.context.id);
        } else {
          pending('referent', trace!.questionMessageId);
          await notice('clarify_referent');
        }
        return true;
      }
      if (classified.kind === 'named_place_question')
        await sink.emit({ type: 'step', step: 'searching_places' });
      if ('span' in classified) return await resolve(classified, () => trace!.questionMessageId);
      return true;
    } catch (error) {
      // A failure, abort or deadline before the choice leaves the turn
      // undecided: the terminal write then resolves the admission marker from
      // durable facts alone (AssistantRepository.finalizeMessage).
      undecided = !trace;
      if (trace) {
        trace.row = 1;
        trace.outcome =
          (error as { reason?: string })?.reason === 'timeout' ||
          (signal.reason as { name?: string })?.name === 'FirstTextDeadlineError' ||
          Date.now() >= deadlineAt
            ? 'timeout'
            : signal.aborted
              ? 'cancelled'
              : 'read_error';
        state.trace.placeAnswerGroup = UNPRODUCED_GROUP;
        if (!signal.aborted) await sink.emit({ type: 'delta', text: '' });
      }
      throw error;
    } finally {
      if (!undecided) state.qaDecided = true;
      if (trace) {
        state.trace.latencyMs = Date.now() - started;
        this.metrics.increment('assistant_place_qa_total', {
          class: trace.class,
          topic: trace.topic,
          outcome: trace.outcome,
          tier: trace.tier,
        });
        this.metrics.observe('assistant_turn_duration_seconds', (Date.now() - started) / 1000, {
          route: 'place_qa',
          status: ['read_error', 'timeout', 'cancelled'].includes(trace.outcome)
            ? 'failed'
            : 'complete',
        });
      }
    }
  }

  private async area(text: string): Promise<PlaceNameArea> {
    // The S0-S5 standing policy does not map old districts to successors.
    if (/(?:^|\s)(?:quận|quan|huyện|huyen|q\.?\s*\d|district)(?:\s|$|\d)/iu.test(text))
      return { kind: 'legacy' };
    const result = await this.areas.resolve(text, text, {
      text,
      areaText: text,
      allowBareArea: true,
    });
    return result.kind === 'resolved'
      ? { kind: 'current', ...result.value.area }
      : { kind: 'unresolved' };
  }
}

/** A typed reply to the latest QA turn that is neither a new non-QA request nor
 * a new explicit QA question: QA control, whatever the flag says (§3.2). */
function continuesQa(
  latest: Pick<MessageRow, 'trace'> | null,
  text: string,
  classified: QaClassification,
): boolean {
  if (latest?.trace?.route !== 'place_qa') return false;
  // An emitted confirm text carries the place NAME, which may contain category
  // or recommendation words; it is QA control whatever the name says.
  if (isTypedConfirm(text)) return true;
  const explicitNewQa = classified.kind !== 'not_qa' && classified.kind !== 'name_only';
  return !isNewNonQaRequest(text) && !explicitNewQa;
}

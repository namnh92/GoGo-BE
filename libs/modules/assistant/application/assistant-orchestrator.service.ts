import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import {
  ASSISTANT_LLM,
  AssistantLlmError,
  ProviderCallAbortedError,
  ProviderConfigurationError,
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  type AssistantLlmPort,
  type DecisionProviderPort,
} from '@gogo/providers';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG } from '../../shared/config';
import type { Actor } from '../../identity/domain/actor';
import { SearchService } from '../../search/application/search.service';
import {
  fallbackIntent,
  parseIntentFacts,
  type IntentFallbackReason,
  type IntentTaxonomy,
} from '../../search/domain/intent';
import { createRoomSchema } from '../../rooms/presentation/dtos';
import {
  ASSISTANT_THRESHOLDS,
  buildAssistantDecisionRequest,
  buildRelevanceRequest,
  fallbackAssistantDecision,
  mapAssistantAnswers,
  type AssistantDecision,
  type AssistantRoute,
} from '../domain/decision';
import {
  StreamSanitizer,
  buildComposerMessages,
  constraintsFrom,
  deterministicReply,
  followUpsFor,
  rankGuideSections,
  type GroundedAnswerContext,
  type GroundedPlace,
  type HistoryTurn,
  type Origin,
} from '../domain/grounding';
import { COPY_KEYS, type AssistantProposalValue } from '../domain/assistant.types';
import { PROPOSAL_TTL_MS, validateProposalValues } from '../domain/proposal';
import { vnDayStart } from '../domain/limits';
import { AssistantRepository } from '../infrastructure/assistant.repository';
import { ASSISTANT_DECISION_PROVIDER, type AssistantConfig } from './assistant.config';
import { AssistantAvailabilityService } from './assistant-availability.service';
import { AssistantAreaResolver, type ResolvedArea } from './area-resolver.service';
import { AssistantCardHydrator, type PlaceCard, type PlanCard } from './card-hydrator.service';
import { GuideDocumentsService } from './guide-documents.service';
import { AssistantTaxonomyService } from './taxonomy.service';
import type { TurnOutcome, TurnSink, TurnState } from './turn-state';

/** Milliseconds off the clock, seconds into the metric (#320). */
const secondsSince = (startedAtMs: number) => (Date.now() - startedAtMs) / 1000;

export type TurnInput = {
  messageId: string;
  /** The turn's ledger row: its reservation, and where a BYOK violation is marked. */
  ledgerId: string;
  conversationId: string;
  userId: string;
  text: string;
  locale: 'vi' | 'en';
  context: { kind: 'place' | 'plan'; id: string } | null;
};

/** Search candidates before ranking; cards shown after it (ADR-0036 §3D). */
const CANDIDATE_LIMIT = 8;
const RELEVANCE_MAX = 6;
const CARD_LIMIT = 3;
/** Below this much first-text budget, no further model call is started. */
const MIN_COMPOSE_BUDGET_MS = 2_500;
const HISTORY_LIMIT = 6;
/** "Near the place I opened", when the request names no area. */
const CONTEXT_RADIUS_M = 2_000;

/**
 * ADR-0036 — one reply: admission already happened (the send), so this is
 * context → deterministic facts → Jev intent → GoGo retrieval → optional Jev
 * relevance → backend validation → Haiku → structured frames.
 *
 * Jev decides semantic relevance, the backend executes and validates, Haiku
 * explains. Every id on a card or a proposal comes from a backend read made
 * for this caller; a model never returns an id, a price, an hour or a source.
 * At most one Jev intent call, one Jev relevance call and one Haiku call per
 * turn; no retries; the first-text deadline covers all of them together.
 */
@Injectable()
export class AssistantOrchestrator {
  private readonly logger = new Logger(AssistantOrchestrator.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AssistantConfig,
    private readonly repo: AssistantRepository,
    private readonly taxonomy: AssistantTaxonomyService,
    private readonly search: SearchService,
    private readonly hydrator: AssistantCardHydrator,
    private readonly areas: AssistantAreaResolver,
    private readonly guide: GuideDocumentsService,
    private readonly availability: AssistantAvailabilityService,
    @Inject(ASSISTANT_DECISION_PROVIDER) private readonly decisions: DecisionProviderPort | null,
    @Inject(ASSISTANT_LLM) private readonly llm: AssistantLlmPort | null,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  async run(
    input: TurnInput,
    state: TurnState,
    sink: TurnSink,
    signal: AbortSignal,
  ): Promise<TurnOutcome> {
    const startedAt = Date.now();
    const deadline = startedAt + this.config.ASSISTANT_FIRST_TEXT_TIMEOUT_MS;
    // A-R-05: one first-text deadline over every stage, not only the Haiku
    // call. A stage still running when it passes is abandoned (its result is
    // never used, so it can emit nothing and prepare nothing) and the turn
    // answers deterministically.
    const guard = firstTextGuard(deadline, signal);
    try {
      return await this.runStages(input, state, sink, signal, startedAt, deadline, guard);
    } catch (err) {
      if (!(err instanceof FirstTextDeadlineError) || state.textStarted) throw err;
      signal.throwIfAborted();
      await sink.emit({ type: 'delta', text: timeoutReply(input.locale) });
      await sink.emit({
        type: 'notice',
        notice: { kind: 'fallback', reason: 'timeout', copyKey: COPY_KEYS.fallback },
      });
      this.metrics.increment('assistant_fallbacks_total', { reason: 'timeout' });
      state.trace.deadline = 'first_text';
      state.trace.latencyMs = Date.now() - startedAt;
      return { status: 'fallback' };
    } finally {
      guard.dispose();
    }
  }

  private async runStages(
    input: TurnInput,
    state: TurnState,
    sink: TurnSink,
    signal: AbortSignal,
    startedAt: number,
    deadline: number,
    guard: FirstTextGuard,
  ): Promise<TurnOutcome> {
    const actor: Actor = { type: 'user', id: input.userId, sessionId: 'assistant-turn' };
    const remaining = () => deadline - Date.now();

    // ── context ──────────────────────────────────────────────────────────────
    const history = await guard.run(() => this.historyFor(input));
    const previousRequest = [...history].reverse().find((t) => t.role === 'user')?.text ?? null;
    const taxonomy = await guard.run(() => this.taxonomy.taxonomy());
    const labels = this.taxonomy.labels(taxonomy);
    const facts = parseIntentFacts(input.text);

    // ── Jev decision 1 ───────────────────────────────────────────────────────
    const decision = await guard.run(() =>
      this.decide(input, previousRequest, taxonomy, guard.signal, remaining(), state),
    );
    const c = decision.classification;
    state.trace.intent = {
      source: decision.source,
      model: decision.model,
      fallbackReason: decision.fallbackReason,
      intent: decision.intent,
      intentProbability: decision.intentProbability,
      action: decision.action,
      category: c.category.key,
      occasion: c.occasion.key,
      moods: c.moods.map((m) => m.key),
      settings: c.settings.map((s) => s.key),
      clarification: c.clarification.reasons,
      unverifiedAttribute: decision.unverifiedAttribute,
    };
    this.metrics.increment('assistant_decisions_total', {
      source: decision.source,
      intent: decision.intent,
    });

    let route: AssistantRoute = decision.intent;
    // `plan_help` is about a plan the person opened; without one, a question
    // about plans is a question about how GoGo works.
    if (route === 'plan_help' && input.context?.kind !== 'plan') route = 'gogo_guide';
    const clarification: string[] = [];
    const conflicting = c.clarification.reasons.includes('conflicting_preferences');
    if (conflicting) clarification.push('preference');
    // Only an unknown kind of place needs asking about; a missing area or
    // budget is handled as its own follow-up below.
    if (
      route === 'recommend_places' &&
      c.clarification.reasons.includes('unclear_activity') &&
      c.category.key === null
    ) {
      route = 'clarify';
      clarification.push('activity');
    }
    const unverifiable =
      decision.unverifiedAttribute !== null &&
      decision.unverifiedAttribute >= ASSISTANT_THRESHOLDS.unverifiedAttributeMin;

    const ctx: GroundedAnswerContext = {
      route,
      locale: input.locale,
      constraints: [],
      preferences: {
        moods: c.moods.map((m) => labels.get(m.key) ?? m.key),
        settings: c.settings.map((s) => labels.get(s.key) ?? s.key),
        occasion: c.occasion.key ? (labels.get(c.occasion.key) ?? c.occasion.key) : null,
      },
      places: [],
      guide: [],
      plan: null,
      pendingAction: null,
      clarification,
      unverifiableRequirement: unverifiable,
      conflicting,
    };

    // ── retrieval (authorized, deterministic) ───────────────────────────────
    let placeCards: PlaceCard[] = [];
    let planCard: PlanCard | null = null;
    let area: ResolvedArea | null = null;
    let perPerson: { amount: number | null; origin: Origin } = { amount: null, origin: 'unknown' };

    if (input.context?.kind === 'plan') {
      const planId = input.context.id;
      planCard = await guard.run(() => this.hydrator.planCard(actor, planId, ''));
      if (!planCard.available) planCard = null;
    }

    if (route === 'recommend_places') {
      await guard.run(() => sink.emit({ type: 'step', step: 'searching_places' }));
      const resolution = await guard.run(() => this.areas.resolve(input.text, facts.areaText));
      area = resolution.kind === 'resolved' ? resolution.value : null;
      perPerson = perPersonBudget(facts, c.occasion.key);
      ctx.constraints = constraintsFrom(facts, area?.label ?? null, {
        perPersonBudget: perPerson.amount,
        perPersonOrigin: perPerson.origin,
      });
      const contextPlaceId = input.context?.kind === 'place' ? input.context.id : null;
      if (!area && !contextPlaceId) {
        // No area and nothing to anchor on: a nationwide list would be noise.
        clarification.push('area');
      } else {
        placeCards = await guard.run(() =>
          this.findPlaces(
            input,
            decision,
            area,
            perPerson.amount,
            facts.timeHint,
            contextPlaceId,
            guard.signal,
            remaining,
            state,
            labels,
          ),
        );
        if (!facts.budget && placeCards.length > 0) clarification.push('budget');
      }
      ctx.places = await guard.run(() => this.groundedPlaces(placeCards, labels));
      state.trace.retrieval = {
        areaResolved: area !== null,
        areaAmbiguous: resolution.kind === 'ambiguous',
        candidates: placeCards.length,
        perPersonBudget: perPerson.amount,
      };
    } else if (route === 'gogo_guide') {
      await guard.run(() => sink.emit({ type: 'step', step: 'reading_guide' }));
      const docs = await guard.run(() => this.guide.searchPublished(input.text, input.locale));
      const sections = rankGuideSections(docs, input.text, 3);
      // One source per document version; sections of it share the index.
      const byVersion = new Map<string, number>();
      for (const s of sections) {
        if (!byVersion.has(s.versionId)) {
          byVersion.set(s.versionId, byVersion.size + 1);
          state.sources.push({
            index: byVersion.get(s.versionId)!,
            kind: 'guide_document',
            documentId: s.documentId,
            versionId: s.versionId,
            slug: s.slug,
            title: s.title,
            ...(s.description ? { description: s.description } : {}),
          });
        }
        ctx.guide.push({
          index: byVersion.get(s.versionId)!,
          title: s.title,
          heading: s.heading,
          excerpt: s.excerpt,
        });
      }
      state.trace.retrieval = { guideVersions: [...byVersion.keys()], sections: sections.length };
    } else if (route === 'plan_help') {
      await guard.run(() => sink.emit({ type: 'step', step: 'reading_plan' }));
      if (planCard) {
        ctx.plan = {
          roomTitle: planCard.facts.roomTitle ?? null,
          roomType: planCard.facts.roomType ?? null,
          status: planCard.facts.status ?? null,
          stopCount: planCard.facts.stopCount ?? null,
        };
      }
    }

    // ── proposal (prepared, never performed) ────────────────────────────────
    // Only a turn that is about places or the opened plan may prepare one: an
    // out-of-scope or unclear request ("…and create a room now") never does.
    const proposal =
      route === 'recommend_places' || route === 'plan_help'
        ? this.prepareProposal(
            decision,
            facts,
            area,
            perPerson,
            placeCards,
            planCard,
            c.occasion.key,
          )
        : null;
    if (proposal) ctx.pendingAction = proposal.kind;

    // ── compose ──────────────────────────────────────────────────────────────
    const placesAsSources = placeCards.length > 0;
    if (placesAsSources) {
      const checked = placeCards
        .map((p) => p.facts.checkedAt)
        .filter((d): d is string => !!d)
        .sort();
      state.sources.push({
        index: state.sources.length + 1,
        kind: 'place_data',
        title: input.locale === 'en' ? 'GoGo place data' : 'Dữ liệu địa điểm GoGo',
        ...(checked.length > 0 ? { checkedAt: checked[checked.length - 1]! } : {}),
      });
    }

    const composable =
      (route === 'recommend_places' && (placeCards.length > 0 || conflicting)) ||
      (route === 'gogo_guide' && ctx.guide.length > 0) ||
      (route === 'plan_help' && ctx.plan !== null);
    let status: TurnOutcome['status'] = 'complete';
    let fallbackReason: 'timeout' | 'provider_unavailable' | 'invalid_output' | null = null;

    signal.throwIfAborted();
    guard.release();
    if (composable && this.llm) {
      if (remaining() < MIN_COMPOSE_BUDGET_MS) {
        fallbackReason = 'timeout';
      } else {
        await sink.emit({ type: 'step', step: 'writing' });
        const composed = await this.compose(input, ctx, history, state, sink, signal, deadline);
        if (composed.kind === 'fallback') fallbackReason = composed.reason;
        else if (composed.kind === 'truncated') status = 'truncated';
      }
    } else if (composable) {
      fallbackReason = 'provider_unavailable';
    }

    if (!state.textStarted) {
      // Deterministic reply from validated data: empty states, out-of-scope,
      // clarification, and every model failure before the first text.
      const text = deterministicReply(ctx);
      signal.throwIfAborted();
      if (text) await sink.emit({ type: 'delta', text });
    }

    // ── structured outputs ───────────────────────────────────────────────────
    for (const card of placeCards.slice(0, CARD_LIMIT)) await sink.emit({ type: 'card', card });
    if (planCard && route === 'plan_help') await sink.emit({ type: 'card', card: planCard });
    if (state.sources.length > 0) await sink.emit({ type: 'sources', sources: state.sources });

    if (status !== 'truncated') {
      // A-R-06: a Stop or the kill switch during the reply prepares nothing.
      signal.throwIfAborted();
      if (proposal) {
        const row = await this.repo.insertProposal({
          conversationId: input.conversationId,
          messageId: input.messageId,
          userId: input.userId,
          kind: proposal.kind,
          values: proposal.values,
          expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
        });
        state.proposalIds.push(row.id);
        await sink.emit({
          type: 'proposal',
          proposal: {
            id: row.id,
            conversationId: row.conversation_id,
            messageId: row.message_id,
            kind: row.kind,
            status: 'pending',
            values: row.values,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          },
        });
      }
      const groups = followUpsFor(ctx);
      if (groups.length > 0) await sink.emit({ type: 'follow_ups', groups });
    }

    const noAnswer =
      (route === 'gogo_guide' && ctx.guide.length === 0) ||
      (route === 'recommend_places' && placeCards.length === 0 && !clarification.includes('area'));
    if (fallbackReason) {
      status = 'fallback';
      await sink.emit({
        type: 'notice',
        notice: { kind: 'fallback', reason: fallbackReason, copyKey: COPY_KEYS.fallback },
      });
      this.metrics.increment('assistant_fallbacks_total', { reason: fallbackReason });
    } else if (noAnswer) {
      await sink.emit({ type: 'notice', notice: { kind: 'empty', copyKey: COPY_KEYS.empty } });
    }

    state.trace.route = route;
    state.trace.latencyMs = Date.now() - startedAt;
    this.metrics.observe('assistant_turn_duration_seconds', secondsSince(startedAt), {
      route,
      status,
    });
    return { status };
  }

  // ── stages ───────────────────────────────────────────────────────────────

  private async historyFor(input: TurnInput): Promise<HistoryTurn[]> {
    const rows = await this.repo.history(input.conversationId, input.messageId, HISTORY_LIMIT + 1);
    // The newest user turn is the question itself; it goes in separately.
    const last = rows[rows.length - 1];
    if (last && last.role === 'user' && last.text === input.text) rows.pop();
    return rows.slice(-HISTORY_LIMIT).map((r) => ({ role: r.role, text: r.text }));
  }

  private async decide(
    input: TurnInput,
    previousRequest: string | null,
    taxonomy: IntentTaxonomy,
    signal: AbortSignal,
    budgetMs: number,
    state: TurnState,
  ): Promise<AssistantDecision> {
    const facts = parseIntentFacts(input.text);
    const openedFrom = input.context?.kind ?? null;
    const fallback = (reason: IntentFallbackReason) =>
      fallbackAssistantDecision(
        input.text,
        fallbackIntent(input.text, facts, taxonomy, reason),
        openedFrom,
      );
    if (!this.decisions) return fallback('disabled');
    if (input.text.trim().length < 2) return fallback('empty_request');
    const request = buildAssistantDecisionRequest(
      input.text,
      { previousRequest, openedFrom },
      taxonomy,
    );
    const started = Date.now();
    // The adapter has its own timeout; the turn's remaining budget caps it too.
    const budget = AbortSignal.timeout(
      Math.max(1, Math.min(budgetMs, this.config.ASSISTANT_JEV_TIMEOUT_MS)),
    );
    beginJevCall(state, signal);
    try {
      const response = await this.decisions.decide(request, {
        signal: AbortSignal.any([signal, budget]),
      });
      this.recordJevUsage(state, response.model, response.usage);
      this.metrics.observe('assistant_provider_duration_seconds', secondsSince(started), {
        provider: 'jev',
        outcome: 'ok',
      });
      return mapAssistantAnswers(facts, response.answers, response.model);
    } catch (err) {
      endJevCall(state, null);
      if (signal.aborted) throw err;
      const reason = jevFallbackReason(err, budget.aborted);
      this.metrics.observe('assistant_provider_duration_seconds', secondsSince(started), {
        provider: 'jev',
        outcome: reason,
      });
      this.logger.warn({
        msg: 'assistant jev decision fell back',
        event: 'assistant.jev_fallback',
        reason,
      });
      return fallback(reason);
    }
  }

  private recordJevUsage(
    state: TurnState,
    model: string,
    usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null },
  ): void {
    const costs = state.costs;
    costs.jevModel = model;
    costs.jevInputTokens = (costs.jevInputTokens ?? 0) + (usage.inputTokens ?? 0);
    costs.jevOutputTokens = (costs.jevOutputTokens ?? 0) + (usage.outputTokens ?? 0);
    endJevCall(state, usage.costUsd);
  }

  private async findPlaces(
    input: TurnInput,
    decision: AssistantDecision,
    area: ResolvedArea | null,
    perPersonBudget: number | null,
    timeHint: string | null,
    contextPlaceId: string | null,
    signal: AbortSignal,
    remaining: () => number,
    state: TurnState,
    labels: Map<string, string>,
  ): Promise<PlaceCard[]> {
    const c = decision.classification;
    const occasion = c.occasion.key;
    const now = new Date();
    // A-R-09: the place the person opened is a candidate only if the same
    // hard filters keep it. Without a named area the search is anchored
    // around it; with one, it must be in that area like any other result.
    const scope = area
      ? { administrativeArea: area.area }
      : contextPlaceId
        ? await this.anchorAround(contextPlaceId)
        : null;
    const result = scope
      ? await this.search.search({
          categories: c.category.key ? [c.category.key] : undefined,
          suitedFor:
            occasion === 'couple' || occasion === 'group' || occasion === 'family'
              ? occasion
              : undefined,
          priceMaxPerPerson: perPersonBudget ?? undefined,
          // Only "right now" is a hard opening-hours filter; a later time is
          // shown on the card instead of hiding places whose hours are unknown.
          openAt: timeHint === 'now' ? now : undefined,
          ...scope,
          includeLodging: c.category.key === 'lodging',
          sort: 'relevance',
          limit: CANDIDATE_LIMIT,
          scoredAt: now,
        })
      : { results: [] as { id: string }[] };
    let ids = result.results.map((r) => r.id);
    // The opened place leads when it passed the filters; it is never added.
    if (contextPlaceId && ids.includes(contextPlaceId)) {
      ids = [contextPlaceId, ...ids.filter((id) => id !== contextPlaceId)];
    }

    // Optional Jev decision 2: only when the request carries a preference the
    // search cannot filter on, and only over the backend's own candidates.
    const wantsSemantic = c.moods.length + c.settings.length > 0;
    if (this.decisions && wantsSemantic && ids.length > CARD_LIMIT && remaining() > 5_000) {
      ids = await this.rankByRelevance(
        input.text,
        ids.slice(0, RELEVANCE_MAX),
        signal,
        remaining(),
        state,
        labels,
      );
    }

    // Backend hard-constraint validation of whatever survived: a verified,
    // published place, inside the budget where the price is known.
    const cards: PlaceCard[] = [];
    for (const id of ids) {
      if (cards.length >= CARD_LIMIT) break;
      const card = await this.hydrator.placeCard(id, now);
      if (!card.available) continue;
      if (
        perPersonBudget !== null &&
        card.facts.priceMin !== undefined &&
        card.facts.priceMin > perPersonBudget
      ) {
        continue;
      }
      cards.push(card);
    }
    return cards;
  }

  /** A search scope around the opened place; none when it cannot be read. */
  private async anchorAround(
    placeId: string,
  ): Promise<{ lat: number; lng: number; radiusM: number } | null> {
    try {
      const place = (await this.search.placeDetail(placeId)) as { lat?: unknown; lng?: unknown };
      const lat = Number(place.lat);
      const lng = Number(place.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng, radiusM: CONTEXT_RADIUS_M };
    } catch (err) {
      if (err instanceof AppError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  private async rankByRelevance(
    text: string,
    ids: string[],
    signal: AbortSignal,
    budgetMs: number,
    state: TurnState,
    labels: Map<string, string>,
  ): Promise<string[]> {
    const stageStartedAt = Date.now();
    const tags = await this.hydrator.placeTags(ids);
    const names = new Map<string, string>();
    for (const id of ids) names.set(id, (await this.hydrator.placeCard(id)).facts.name);
    // Server-generated keys; the key → id map never leaves this process.
    const keyed = ids.map((id, i) => ({ key: `c${i + 1}`, id }));
    const request = buildRelevanceRequest(
      text,
      keyed.map(({ key, id }) => {
        const t = tags.get(id) ?? { categories: [], moods: [], settings: [] };
        const words = [...t.categories, ...t.moods, ...t.settings].map((k) => labels.get(k) ?? k);
        return {
          key,
          description: `${names.get(id) ?? ''}${words.length ? ` (${words.join(', ')})` : ''}`,
        };
      }),
    );
    // A-R2-06: an abandoned stage (deadline passed, turn ended) starts no
    // paid call; the budget is re-read now, not when the stage began.
    const budget = AbortSignal.timeout(
      Math.max(
        1,
        Math.min(
          budgetMs - (Date.now() - stageStartedAt) - MIN_COMPOSE_BUDGET_MS,
          this.config.ASSISTANT_JEV_TIMEOUT_MS,
        ),
      ),
    );
    beginJevCall(state, signal);
    try {
      const response = await this.decisions!.decide(request, {
        signal: AbortSignal.any([signal, budget]),
      });
      this.recordJevUsage(state, response.model, response.usage);
      const scored = keyed
        .map(({ key, id }) => {
          const a = response.answers[key];
          return { id, p: a?.type === 'noul' ? a.noul : 0 };
        })
        .filter((s) => s.p >= ASSISTANT_THRESHOLDS.relevanceMin)
        // Ties keep the search order (stable sort), so the result is deterministic.
        .sort((a, b) => b.p - a.p);
      state.trace.relevance = { asked: keyed.length, kept: scored.length };
      // Nothing relevant enough: keep the deterministic order rather than nothing.
      return scored.length > 0 ? scored.map((s) => s.id) : ids;
    } catch (err) {
      endJevCall(state, null);
      if (signal.aborted) throw err;
      state.trace.relevance = { asked: keyed.length, fallback: true };
      return ids;
    }
  }

  private async groundedPlaces(
    cards: PlaceCard[],
    labels: Map<string, string>,
  ): Promise<GroundedPlace[]> {
    const tags = await this.hydrator.placeTags(cards.map((c) => c.placeId));
    return cards.slice(0, CARD_LIMIT).map((card, i) => {
      const t = tags.get(card.placeId) ?? { categories: [], moods: [], settings: [] };
      return {
        position: i + 1,
        placeId: card.placeId,
        name: card.facts.name,
        categories: t.categories.map((k) => labels.get(k) ?? k),
        moods: [...t.moods, ...t.settings].map((k) => labels.get(k) ?? k),
      };
    });
  }

  private prepareProposal(
    decision: AssistantDecision,
    facts: ReturnType<typeof parseIntentFacts>,
    area: ResolvedArea | null,
    perPerson: { amount: number | null; origin: Origin },
    places: PlaceCard[],
    plan: PlanCard | null,
    occasion: string | null,
  ): { kind: string; values: AssistantProposalValue[] } | null {
    const v = (
      field: string,
      value: unknown,
      origin: 'explicit' | 'assumed',
      editable = true,
    ): AssistantProposalValue => ({
      field,
      value,
      origin,
      editable,
    });
    let kind: 'create_room' | 'create_invite' | 'finalize_plan' | null = null;
    let values: AssistantProposalValue[] = [];
    if (decision.action === 'create_room') {
      kind = 'create_room';
      const couple = facts.partySize === 2 || occasion === 'couple';
      const type = couple ? 'couple' : 'group';
      const participants = couple ? 2 : Math.min(20, Math.max(2, facts.partySize ?? 4));
      values = [
        v('type', type, facts.partySize !== null || occasion !== null ? 'explicit' : 'assumed'),
        v('participantCount', participants, facts.partySize !== null ? 'explicit' : 'assumed'),
        v('decisionMode', couple ? 'match' : 'vote', 'assumed'),
      ];
      const start = startFor(facts.timeHint);
      if (start) {
        values.push(v('startAt', start.toISOString(), 'assumed'));
        values.push(
          v('endAt', new Date(start.getTime() + 3 * 3600 * 1000).toISOString(), 'assumed'),
        );
      }
      if (facts.budget) {
        // Couple rooms are total-budget rooms (`assertBudgetMode`).
        const mode = couple ? 'total' : (facts.budget.mode ?? 'per_person');
        const amount =
          mode === 'total' && facts.budget.mode === 'per_person'
            ? facts.budget.amount * participants
            : facts.budget.amount;
        values.push(v('budgetMode', mode, facts.budget.mode === mode ? 'explicit' : 'assumed'));
        values.push(v('budgetAmount', amount, facts.budget.mode === mode ? 'explicit' : 'assumed'));
      } else {
        values.push(v('budgetMode', couple ? 'total' : 'per_person', 'assumed'));
        values.push(v('budgetAmount', perPerson.amount ?? 0, 'assumed'));
      }
      if (area) values.push(v('administrativeArea', area.area, 'explicit'));
      if (places.length > 0)
        values.push(
          v(
            'seedPlaceIds',
            places.slice(0, CARD_LIMIT).map((p) => p.placeId),
            'assumed',
          ),
        );
      // The target endpoint's own schema decides, before the card is shown.
      const draft = createRoomSchema.safeParse(toCreateRoomInput(values));
      if (!draft.success) return null;
    } else if (decision.action === 'create_invite' && plan) {
      kind = 'create_invite';
      values = [v('roomId', plan.roomId, 'explicit', false)];
    } else if (decision.action === 'finalize_plan' && plan) {
      kind = 'finalize_plan';
      values = [v('roomId', plan.roomId, 'explicit', false)];
    }
    if (!kind) return null;
    return validateProposalValues(kind, values).length === 0 ? { kind, values } : null;
  }

  private async compose(
    input: TurnInput,
    ctx: GroundedAnswerContext,
    history: HistoryTurn[],
    state: TurnState,
    sink: TurnSink,
    signal: AbortSignal,
    deadline: number,
  ): Promise<
    | { kind: 'ok' }
    | { kind: 'truncated' }
    | { kind: 'fallback'; reason: 'timeout' | 'provider_unavailable' | 'invalid_output' }
  > {
    const llm = this.llm!;
    // A-R-06: an abort that fired before this point must still stop the call.
    signal.throwIfAborted();
    const local = new AbortController();
    const firstTextTimer = setTimeout(
      () => {
        // A-R3-03: the deadline is about text the person sees. Model text the
        // sanitizer still holds back does not count: at the deadline the
        // call ends and the deterministic reply is shown instead.
        if (!state.textStarted) local.abort();
      },
      Math.max(1, deadline - Date.now()),
    );
    const sanitizer = new StreamSanitizer(state.sources.length, ctx.places, ctx.locale);
    const started = Date.now();
    state.costs.haikuCalls += 1;
    state.costs.haikuModel = llm.model;
    let finish: 'stop' | 'length' | 'other' = 'other';
    try {
      for await (const event of llm.stream({
        messages: buildComposerMessages(ctx, history, input.text),
        maxOutputTokens: this.config.ASSISTANT_MAX_OUTPUT_TOKENS,
        signal: AbortSignal.any([signal, local.signal]),
      })) {
        if (event.type === 'delta') {
          const clean = sanitizer.push(event.text);
          if (clean) await sink.emit({ type: 'delta', text: clean });
        } else if (event.type === 'usage') {
          const u = event.usage;
          state.costs.haikuModel = u.model ?? llm.model;
          state.costs.haikuInputTokens = u.inputTokens;
          state.costs.haikuOutputTokens = u.outputTokens;
          state.costs.haikuUpstreamCostUsd = u.upstreamCostUsd;
          state.costs.haikuOpenrouterCostUsd = u.openRouterCostUsd;
          state.costs.haikuIsByok = u.isByok;
          this.metrics.increment('assistant_haiku_calls_total', {
            billing_source: u.billingSource,
          });
          if (u.isByok === false) {
            // Billed to OpenRouter credits instead of GoGo's Anthropic key:
            // stop taking sends until someone looks (ADR-0036 strict BYOK).
            await this.availability.recordByokViolation(input.ledgerId);
            this.logger.error({
              msg: 'assistant haiku call was not routed through Anthropic BYOK',
              event: 'assistant.byok_violation',
              provider: u.provider,
            });
          }
        } else {
          finish = event.finishReason;
        }
      }
      const rest = sanitizer.flush();
      if (rest) await sink.emit({ type: 'delta', text: rest });
      this.metrics.observe('assistant_provider_duration_seconds', secondsSince(started), {
        provider: 'haiku',
        outcome: 'ok',
      });
      if (!state.textStarted) return { kind: 'fallback', reason: 'invalid_output' };
      return finish === 'length' ? { kind: 'truncated' } : { kind: 'ok' };
    } catch (err) {
      if (signal.aborted) throw err;
      const reason: 'timeout' | 'provider_unavailable' | 'invalid_output' =
        local.signal.aborted && !state.textStarted
          ? 'timeout'
          : err instanceof AssistantLlmError && err.kind === 'invalid_output'
            ? 'invalid_output'
            : 'provider_unavailable';
      this.metrics.observe('assistant_provider_duration_seconds', secondsSince(started), {
        provider: 'haiku',
        outcome: reason,
      });
      this.logger.warn({
        msg: 'assistant haiku composition failed',
        event: 'assistant.haiku_failed',
        kind: err instanceof AssistantLlmError ? err.kind : 'unknown',
        textStarted: state.textStarted,
      });
      if (state.textStarted) {
        // After text started, the contract ends the turn with an error frame.
        throw new HaikuMidStreamError(err);
      }
      return { kind: 'fallback', reason };
    } finally {
      clearTimeout(firstTextTimer);
    }
  }
}

/** The first-text deadline passed before any stage produced text. */
export class FirstTextDeadlineError extends Error {
  constructor() {
    super('assistant first-text deadline passed');
    this.name = 'FirstTextDeadlineError';
  }
}

export type FirstTextGuard = {
  /**
   * Aborts when the deadline passes (until released) or the turn is aborted:
   * a stage hands it to provider calls so abandoned work cannot start or
   * continue paid calls (A-R2-06).
   */
  readonly signal: AbortSignal;
  /**
   * The stage's result, unless the deadline passes or the turn is aborted
   * first. Lazy, so a stage the deadline already refused never starts.
   */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Text is about to start (or the compose stage owns the deadline from here). */
  release(): void;
  dispose(): void;
};

export function firstTextGuard(deadline: number, signal: AbortSignal): FirstTextGuard {
  let released = false;
  let expire: (() => void) | null = null;
  const expired = new Promise<never>((_resolve, reject) => {
    expire = () => reject(new FirstTextDeadlineError());
  });
  expired.catch(() => undefined);
  const deadlineController = new AbortController();
  const timer = setTimeout(
    () => {
      deadlineController.abort(new FirstTextDeadlineError());
      expire?.();
    },
    Math.max(0, deadline - Date.now()),
  );
  timer.unref?.();
  return {
    signal: AbortSignal.any([signal, deadlineController.signal]),
    async run<T>(stage: () => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      if (released) return stage();
      if (Date.now() >= deadline) throw new FirstTextDeadlineError();
      const work = stage();
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        void work
          .finally(() => signal.removeEventListener('abort', onAbort))
          .catch(() => undefined);
      });
      aborted.catch(() => undefined);
      work.catch(() => undefined);
      return Promise.race([work, expired, aborted]);
    },
    release() {
      released = true;
      clearTimeout(timer);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

/**
 * Jev cost accounting with calls in flight (A-R2-06): while any call is
 * outstanding, or any reported no cost, the turn's Jev cost is unknown —
 * so a ledger settled while an abandoned call was still running records an
 * unknown, counted at the ceiling, never a partial sum.
 */
function beginJevCall(state: TurnState, signal: AbortSignal): void {
  signal.throwIfAborted();
  state.costs.jevCalls += 1;
  state.jevInFlight += 1;
  state.costs.jevCostUsd = null;
}

function endJevCall(state: TurnState, costUsd: number | null): void {
  state.jevInFlight = Math.max(0, state.jevInFlight - 1);
  if (costUsd === null) state.trace.jevUnknownCost = true;
  else state.jevKnownUsd += costUsd;
  state.costs.jevCostUsd =
    state.jevInFlight === 0 && !state.trace.jevUnknownCost ? state.jevKnownUsd : null;
}

function timeoutReply(locale: 'vi' | 'en'): string {
  return locale === 'en'
    ? 'Sorry, GoGo is slower than usual right now. Please try again in a moment.'
    : 'Xin lỗi, GoGo đang phản hồi chậm hơn bình thường. Bạn thử lại sau ít phút nhé.';
}

/** Haiku failed after text was streamed: the runner ends the turn `failed`. */
export class HaikuMidStreamError extends Error {
  constructor(cause: unknown) {
    super('assistant composition failed after text started', { cause });
    this.name = 'HaikuMidStreamError';
  }
}

function jevFallbackReason(err: unknown, budgetAborted: boolean): IntentFallbackReason {
  if (budgetAborted || err instanceof ProviderCallAbortedError) return 'timeout';
  if (err instanceof ProviderQuotaExceededError) return 'quota';
  if (err instanceof ProviderConfigurationError) return 'provider_error';
  if (err instanceof ProviderUnavailableError) {
    const cause = err.cause as { name?: string } | undefined;
    if (cause?.name === 'DecisionContractError') return 'invalid_response';
    if (cause?.name === 'AbortError' || cause?.name === 'TimeoutError') return 'timeout';
    return 'provider_error';
  }
  if (err instanceof Error && err.name === 'DecisionContractError') return 'invalid_response';
  return 'provider_error';
}

/**
 * Per-person budget for the price filter. Arithmetic is code's, never a
 * model's: a total is divided by the stated party; a couple's total by two,
 * marked assumed when the party size was not said.
 */
export function perPersonBudget(
  facts: ReturnType<typeof parseIntentFacts>,
  occasion: string | null,
): { amount: number | null; origin: Origin } {
  const b = facts.budget;
  if (!b) return { amount: null, origin: 'unknown' };
  if (b.mode === 'per_person') return { amount: b.amount, origin: 'explicit' };
  if (b.mode === 'total') {
    if (facts.partySize && facts.partySize > 0) {
      return { amount: Math.floor(b.amount / facts.partySize), origin: 'explicit' };
    }
    if (occasion === 'couple') return { amount: Math.floor(b.amount / 2), origin: 'assumed' };
    return { amount: null, origin: 'unknown' };
  }
  // Mode not stated: read as per person, flagged.
  return { amount: b.amount, origin: 'assumed' };
}

/** The local evening the hint names, 19:00 Asia/Ho_Chi_Minh; null when none. */
function startFor(hint: string | null, now = new Date()): Date | null {
  const today = vnDayStart(now).getTime();
  const evening = (dayOffset: number) =>
    new Date(today + dayOffset * 86_400_000 + 19 * 3600 * 1000);
  if (hint === 'tonight' || hint === 'today') {
    const e = evening(0);
    return e.getTime() > now.getTime()
      ? e
      : new Date(Math.ceil(now.getTime() / 900_000) * 900_000 + 900_000);
  }
  if (hint === 'tomorrow') return evening(1);
  if (hint === 'now') return new Date(Math.ceil(now.getTime() / 900_000) * 900_000);
  return null;
}

/** The proposal values in `createRoom`'s request shape. */
export function toCreateRoomInput(
  values: readonly AssistantProposalValue[],
): Record<string, unknown> {
  const get = (f: string) => values.find((v) => v.field === f)?.value;
  const constraint: Record<string, unknown> = {
    budgetMode: get('budgetMode'),
    budgetAmount: get('budgetAmount'),
  };
  if (get('startAt') !== undefined) constraint.startAt = get('startAt');
  if (get('endAt') !== undefined) constraint.endAt = get('endAt');
  if (get('administrativeArea') !== undefined)
    constraint.administrativeArea = get('administrativeArea');
  return {
    type: get('type'),
    decisionMode: get('decisionMode'),
    participantCount: get('participantCount'),
    ...(get('title') !== undefined ? { title: get('title') } : {}),
    constraint,
    seedPlaceIds: get('seedPlaceIds') ?? [],
  };
}

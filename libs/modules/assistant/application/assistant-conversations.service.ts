import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import {
  beginIdempotent,
  completeIdempotentWithin,
  releaseIdempotent,
  type IdempotencyScope,
} from '../../shared/idempotency.interceptor';
import type { Actor } from '../../identity/domain/actor';
import { SearchService } from '../../search/application/search.service';
import type { AssistantContextInput, AssistantFeedbackReason } from '../domain/assistant.types';
import { decodeCursor, encodeCursor } from '../domain/cursor';
import {
  AssistantRepository,
  type ConversationRow,
  type MessageRow,
} from '../infrastructure/assistant.repository';
import { ASSISTANT_FRAME_BUFFER, type AssistantFrameBuffer } from '../infrastructure/frame-buffer';
import { ASSISTANT_INSTANCE_ID, LEASE_MS } from './assistant.config';
import { AssistantAvailabilityService } from './assistant-availability.service';
import { AssistantTurnRunner } from './assistant-turn-runner.service';
import { AssistantCardHydrator } from './card-hydrator.service';
import { conversationView, messageView, refsOf, type ContextLabel } from './assistant-views';

export function requireUser(actor: Actor): string {
  if (actor.type !== 'user') {
    throw AppError.forbidden('USER_ONLY', 'Register an account to use GoGo AI');
  }
  return actor.id;
}

const STOP_WAIT_MS = 5_000;

/**
 * GoGo-BE#713 — conversations, messages, send, stop and feedback for the
 * caller's own history. Registered users only; another account's row, a
 * deleted one and one past retention are the same 404. Reading, renaming and
 * deleting keep working with the kill switch off; sending does not.
 */
@Injectable()
export class AssistantConversationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: AssistantRepository,
    private readonly availability: AssistantAvailabilityService,
    private readonly runner: AssistantTurnRunner,
    private readonly hydrator: AssistantCardHydrator,
    private readonly search: SearchService,
    @Inject(ASSISTANT_FRAME_BUFFER) private readonly buffer: AssistantFrameBuffer,
    @Inject(ASSISTANT_INSTANCE_ID) private readonly instanceId: string,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  status(actor: Actor) {
    return this.availability.status(requireUser(actor));
  }

  // --- conversations -----------------------------------------------------------

  async list(
    actor: Actor,
    query: { q?: string | undefined; limit: number; cursor?: string | undefined },
  ) {
    const userId = requireUser(actor);
    const rows = await this.repo.listConversations(userId, {
      q: query.q ?? null,
      limit: query.limit,
      cursor: decodeCursor(query.cursor),
    });
    const page = rows.slice(0, query.limit);
    const items = await Promise.all(
      page.map(async (r) => conversationView(r, await this.contextLabel(actor, r))),
    );
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.last_message_at, last.id) : null,
    };
  }

  async create(
    actor: Actor,
    input: { title?: string | undefined; context?: AssistantContextInput | undefined },
  ) {
    const userId = requireUser(actor);
    await this.availability.requireReady();
    const context = input.context ? await this.resolveContext(actor, input.context) : null;
    const row = await this.repo.createConversation(this.db, {
      userId,
      title: input.title?.trim() || null,
      context: context ? { kind: context.kind, id: context.id } : null,
    });
    return conversationView(row, context);
  }

  async get(actor: Actor, id: string) {
    const row = await this.requireConversation(actor, id);
    return conversationView(row, await this.contextLabel(actor, row));
  }

  async rename(actor: Actor, id: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) {
      throw AppError.badRequest('VALIDATION_FAILED', 'Title is blank', [
        { field: 'title', code: 'blank', message: 'must not be blank' },
      ]);
    }
    const row = await this.repo.renameConversation(requireUser(actor), id, trimmed);
    if (!row) throw AppError.notFound();
    return conversationView(row, await this.contextLabel(actor, row));
  }

  /** Hard delete; a reply still streaming is stopped first. Idempotent. */
  async remove(actor: Actor, id: string): Promise<void> {
    const userId = requireUser(actor);
    for (const messageId of await this.repo.streamingMessageIds(userId, id)) {
      if (!(await this.runner.stopLocal(messageId))) await this.buffer.requestStop(messageId);
    }
    await this.repo.deleteConversation(userId, id);
  }

  // --- messages ----------------------------------------------------------------

  async messages(
    actor: Actor,
    conversationId: string,
    query: { limit: number; cursor?: string | undefined },
  ) {
    await this.requireConversation(actor, conversationId);
    const rows = await this.repo.listMessages(conversationId, {
      limit: query.limit,
      cursor: decodeCursor(query.cursor),
    });
    const page = rows.slice(0, query.limit);
    const items = await this.views(actor, page);
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  /**
   * The send (ADR-0036 §3A): idempotency first, so a replay neither spends
   * allowance nor meets a limit; then the environment gate; then, under the
   * account's lock, the allowance and the two rows; the replay record completes
   * in that same transaction. The reply starts after the commit.
   */
  async send(
    actor: Actor,
    conversationId: string,
    input: {
      text: string;
      context?: AssistantContextInput | undefined;
      attachments?: { uploadKey: string }[] | undefined;
      locale?: 'vi' | 'en' | undefined;
    },
    scope: IdempotencyScope,
  ): Promise<{ replay: boolean; status: number; body: unknown }> {
    const userId = requireUser(actor);
    const conversation = await this.requireConversation(actor, conversationId);
    const text = input.text.trim();
    if (!text) {
      throw AppError.badRequest('VALIDATION_FAILED', 'Message is blank', [
        { field: 'text', code: 'blank', message: 'must not be blank' },
      ]);
    }
    if (input.attachments && input.attachments.length > 0) {
      // `assistant_image` uploads are not served yet (POST /uploads refuses the
      // purpose), so no key can be this caller's image. One answer, no reason.
      throw AppError.badRequest('ATTACHMENT_INVALID', 'Attachment is not a valid assistant image');
    }

    const begun = await beginIdempotent(this.db, scope);
    if (begun.kind === 'replay') return { replay: true, status: begun.status, body: begun.body };
    const claim = begun.claim;
    try {
      const context = input.context
        ? await this.resolveContext(actor, input.context)
        : conversation.context_kind && conversation.context_id
          ? { kind: conversation.context_kind, id: conversation.context_id, label: '' }
          : null;
      const limits = await this.availability.requireReady();
      const locale = input.locale ?? 'vi';
      const turn = await this.db.transaction(async (tx) => {
        await this.repo.lockAccount(tx, userId);
        await this.availability.requireAllowance(tx, userId, limits);
        let inserted;
        try {
          inserted = await this.repo.insertTurn(tx, {
            userId,
            conversationId,
            text,
            locale,
            context: context ? { kind: context.kind, id: context.id } : null,
            leaseOwner: this.instanceId,
            leaseMs: LEASE_MS,
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw AppError.conflict(
              'ASSISTANT_TURN_IN_PROGRESS',
              'A reply in this conversation is still streaming',
            );
          }
          throw err;
        }
        const body = {
          userMessage: messageView(inserted.user, {
            context: context?.label ? context : null,
            sources: [],
            cards: [],
            proposals: [],
            feedback: null,
          }),
          assistantMessage: messageView(inserted.assistant, {
            context: null,
            sources: [],
            cards: [],
            proposals: [],
            feedback: null,
          }),
        };
        if (!(await completeIdempotentWithin(tx, claim, 202, body))) {
          throw AppError.conflict(
            'IDEMPOTENT_REQUEST_IN_FLIGHT',
            'Original request is still processing',
          );
        }
        return { ...inserted, body };
      });
      this.metrics.increment('assistant_admission_total', { outcome: 'accepted' });
      this.runner.start({
        messageId: turn.assistant.id,
        conversationId,
        userId,
        ledgerId: turn.ledgerId,
        text,
        locale,
        context: context ? { kind: context.kind, id: context.id } : null,
      });
      return { replay: false, status: 202, body: turn.body };
    } catch (err) {
      await releaseIdempotent(this.db, claim).catch(() => undefined);
      throw err;
    }
  }

  /** Stop: idempotent; the message as stored after stopping. */
  async stop(actor: Actor, conversationId: string, messageId: string) {
    const userId = requireUser(actor);
    const row = await this.requireAssistantMessage(actor, conversationId, messageId);
    if (row.status === 'streaming') {
      this.metrics.increment('assistant_stops_total', {});
      if (!(await this.runner.stopLocal(messageId))) {
        await this.buffer.requestStop(messageId);
        // The runner may live on another instance: give it time to end the turn.
        const deadline = Date.now() + STOP_WAIT_MS;
        while (Date.now() < deadline) {
          await this.buffer.wait(messageId, 250);
          const now = await this.repo.findMessage(userId, conversationId, messageId);
          if (!now || now.status !== 'streaming') break;
        }
        const still = await this.repo.findMessage(userId, conversationId, messageId);
        // Nobody is running it any more (its process died): end it here.
        if (still?.status === 'streaming') await this.runner.finalizeOrphan(still, 'stopped', null);
      }
    }
    const final = await this.requireAssistantMessage(actor, conversationId, messageId);
    return (await this.views(actor, [final]))[0];
  }

  async setFeedback(
    actor: Actor,
    conversationId: string,
    messageId: string,
    input: { rating: 'up' | 'down'; reason?: AssistantFeedbackReason | undefined },
  ) {
    const userId = requireUser(actor);
    await this.requireAssistantMessage(actor, conversationId, messageId);
    const row = await this.repo.upsertFeedback({
      messageId,
      conversationId,
      userId,
      rating: input.rating,
      reason: input.reason ?? null,
    });
    this.metrics.increment('assistant_feedback_total', { rating: input.rating });
    return {
      rating: row.rating,
      ...(row.reason ? { reason: row.reason } : {}),
      createdAt: row.created_at,
    };
  }

  async clearFeedback(actor: Actor, conversationId: string, messageId: string): Promise<void> {
    const userId = requireUser(actor);
    await this.requireAssistantMessage(actor, conversationId, messageId);
    await this.repo.deleteFeedback(userId, messageId);
  }

  // --- helpers -----------------------------------------------------------------

  async requireConversation(actor: Actor, id: string): Promise<ConversationRow> {
    const row = await this.repo.findConversation(requireUser(actor), id);
    if (!row) throw AppError.notFound();
    return row;
  }

  async requireAssistantMessage(
    actor: Actor,
    conversationId: string,
    messageId: string,
  ): Promise<MessageRow> {
    const row = await this.repo.findMessage(requireUser(actor), conversationId, messageId);
    if (!row || row.role !== 'assistant') throw AppError.notFound();
    return row;
  }

  /** Messages with what they were rendered from; cards re-read from verified data. */
  async views(actor: Actor, rows: MessageRow[]) {
    const ids = rows.map((r) => r.id);
    const [sources, feedback, proposals] = await Promise.all([
      this.repo.sourcesFor(ids),
      this.repo.feedbackFor(ids),
      this.repo.proposalsFor(ids),
    ]);
    const at = new Date();
    return Promise.all(
      rows.map(async (r) => {
        const cards =
          r.role === 'assistant' ? await this.hydrator.hydrate(actor, refsOf(r), at) : [];
        const context =
          r.role === 'user' && r.context_kind && r.context_id
            ? await this.labelFor(actor, r.context_kind, r.context_id)
            : null;
        return messageView(r, {
          context,
          sources: sources.get(r.id) ?? [],
          cards,
          proposals: proposals.get(r.id) ?? [],
          feedback: feedback.get(r.id) ?? null,
        });
      }),
    );
  }

  /** `404 CONTEXT_NOT_FOUND` for anything the caller may not read, without saying which. */
  async resolveContext(actor: Actor, input: AssistantContextInput): Promise<ContextLabel> {
    const label =
      'placeId' in input
        ? await this.labelFor(actor, 'place', input.placeId)
        : await this.labelFor(actor, 'plan', input.planId);
    if (!label)
      throw AppError.notFound('CONTEXT_NOT_FOUND', 'No such place or plan for this account');
    return label;
  }

  private async contextLabel(actor: Actor, row: ConversationRow): Promise<ContextLabel | null> {
    if (!row.context_kind || !row.context_id) return null;
    return this.labelFor(actor, row.context_kind, row.context_id);
  }

  private async labelFor(
    actor: Actor,
    kind: 'place' | 'plan',
    id: string,
  ): Promise<ContextLabel | null> {
    if (kind === 'place') {
      try {
        const place = await this.search.placeDetail(id);
        return { kind, id, label: place.name };
      } catch (err) {
        if (err instanceof AppError && err.httpStatus === 404) return null;
        throw err;
      }
    }
    const card = await this.hydrator.planCard(actor, id, '');
    return card.available ? { kind, id, label: card.facts.roomTitle ?? '' } : null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 3 && e; i += 1) {
    if ((e as { code?: string }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

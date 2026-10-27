import type { AssistantCardRef, AssistantSourceData } from '../domain/assistant.types';
import { publicProposalStatus } from '../domain/proposal';
import type {
  ConversationRow,
  FeedbackRow,
  MessageRow,
  ProposalRow,
} from '../infrastructure/assistant.repository';
import { RETENTION_DAYS } from '../infrastructure/assistant.repository';

/** Response shapes of the contract; Drizzle rows never leave the module. */

export type ContextLabel = { kind: 'place' | 'plan'; id: string; label: string };

export function conversationView(row: ConversationRow, context: ContextLabel | null) {
  const expiresAt = new Date(
    Date.parse(row.last_message_at) + RETENTION_DAYS * 86_400_000,
  ).toISOString();
  return {
    id: row.id,
    title: row.title,
    context,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    expiresAt,
    messageCount: row.message_count,
    ...(row.preview ? { preview: row.preview.slice(0, 160) } : {}),
    ...(row.match_field
      ? {
          match: {
            field: row.match_field,
            ...(row.match_message_id ? { messageId: row.match_message_id } : {}),
            ...(row.match_text ? { snippet: row.match_text.slice(0, 200) } : {}),
          },
        }
      : {}),
  };
}

export function feedbackView(row: FeedbackRow) {
  return {
    rating: row.rating,
    ...(row.reason ? { reason: row.reason } : {}),
    createdAt: row.created_at,
  };
}

export function proposalView(row: ProposalRow, now = new Date()) {
  const status = publicProposalStatus(row.status, new Date(row.expires_at), now);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    kind: row.kind,
    status,
    values: row.values,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(status === 'confirmed' && row.result ? { result: row.result } : {}),
  };
}

export function messageView(
  row: MessageRow,
  extras: {
    context: ContextLabel | null;
    sources: AssistantSourceData[];
    cards: unknown[];
    proposals: ProposalRow[];
    feedback: FeedbackRow | null;
  },
) {
  const isAssistant = row.role === 'assistant';
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    status: row.status,
    text: row.text,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    ...(extras.context ? { context: extras.context } : {}),
    ...(isAssistant
      ? {
          sources: extras.sources,
          cards: extras.cards,
          proposals: extras.proposals.map((p) => proposalView(p)),
          followUps: row.follow_ups ?? [],
          ...(row.notice ? { notice: row.notice } : {}),
          feedback: extras.feedback ? feedbackView(extras.feedback) : null,
          ...(row.status === 'failed' && row.error ? { error: row.error } : {}),
        }
      : {}),
  };
}

export function refsOf(row: MessageRow): AssistantCardRef[] {
  return Array.isArray(row.cards) ? row.cards : [];
}

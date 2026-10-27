/**
 * GoGo-BE#713 — the assistant's public vocabulary, as the contract
 * (`openapi/gogo.v1.yaml` 2.0.0-alpha.3, tag `assistant`) names it. Facts,
 * never sentences: copy is the app's (i18n keys), card facts are re-read from
 * verified data, and nothing here is ever a model's claim about a place.
 */

export type AssistantMessageStatus =
  'streaming' | 'complete' | 'stopped' | 'fallback' | 'failed' | 'truncated';
export type AssistantTerminalStatus = Exclude<AssistantMessageStatus, 'streaming'>;
export type AssistantDoneStatus = 'complete' | 'stopped' | 'fallback' | 'truncated';

export type AssistantContextInput = { placeId: string } | { planId: string };
export type AssistantContextKind = 'place' | 'plan';
export type AssistantContextRefData = { kind: AssistantContextKind; id: string };

export type AssistantStep = 'reading_guide' | 'searching_places' | 'reading_plan' | 'writing';

export type AssistantNotice =
  | { kind: 'empty'; copyKey: string }
  | {
      kind: 'fallback';
      reason: 'timeout' | 'provider_unavailable' | 'invalid_output';
      copyKey: string;
    }
  | { kind: 'limit'; copyKey: string }
  | { kind: 'disabled'; copyKey: string };

export type AssistantFollowUpGroup = {
  field: string;
  label: string;
  options: { label: string; text: string }[];
};

/** What history stores for a card: ids only, never facts. */
export type AssistantCardRef =
  { kind: 'place'; placeId: string } | { kind: 'plan'; planId: string; roomId: string };

export type AssistantSourceData = {
  index: number;
  kind: 'guide_document' | 'place_data';
  documentId?: string;
  versionId?: string;
  slug?: string;
  title: string;
  description?: string;
  checkedAt?: string;
};

export type ErrorEnvelope = {
  code: string;
  message: string;
  field_errors: { field: string; code: string; message: string }[];
  request_id: string | null;
  retryable: boolean;
};

/** One SSE frame body; `type` is also the SSE `event:` name. */
export type AssistantFrame =
  | { type: 'step'; seq: number; messageId: string; step: AssistantStep }
  | { type: 'delta'; seq: number; messageId: string; text: string }
  | { type: 'sources'; seq: number; messageId: string; sources: AssistantSourceData[] }
  | { type: 'card'; seq: number; messageId: string; card: unknown }
  | { type: 'proposal'; seq: number; messageId: string; proposal: unknown }
  | { type: 'follow_ups'; seq: number; messageId: string; groups: AssistantFollowUpGroup[] }
  | { type: 'notice'; seq: number; messageId: string; notice: AssistantNotice }
  | { type: 'done'; seq: number; messageId: string; status: AssistantDoneStatus }
  | { type: 'error'; seq: number; messageId: string; error: ErrorEnvelope };

/** A frame before the buffer numbers it. */
export type AssistantFrameInput = AssistantFrame extends infer F
  ? F extends AssistantFrame
    ? Omit<F, 'seq' | 'messageId'>
    : never
  : never;

export const isTerminalFrame = (frame: { type: string }): boolean =>
  frame.type === 'done' || frame.type === 'error';

export type AssistantProposalKind = 'create_room' | 'create_invite' | 'cast_vote' | 'finalize_plan';
export const PROPOSAL_KINDS: readonly AssistantProposalKind[] = [
  'create_room',
  'create_invite',
  'cast_vote',
  'finalize_plan',
];

export type AssistantProposalValue = {
  field: string;
  value: unknown;
  origin: 'explicit' | 'assumed';
  editable: boolean;
};

export type AssistantFeedbackReason = 'incorrect' | 'not_helpful' | 'unsafe' | 'outdated' | 'other';
export const FEEDBACK_REASONS: readonly AssistantFeedbackReason[] = [
  'incorrect',
  'not_helpful',
  'unsafe',
  'outdated',
  'other',
];

/** i18n keys the app owns (Q11: suggestion copy is fixed app i18n in v1). */
export const COPY_KEYS = {
  empty: 'assistant.notice.empty',
  noPlaces: 'assistant.notice.empty',
  fallback: 'assistant.notice.fallback',
  disabled: 'assistant.notice.disabled',
  limit: 'assistant.notice.limit',
} as const;

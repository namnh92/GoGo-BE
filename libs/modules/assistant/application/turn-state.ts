import type {
  AssistantCardRef,
  AssistantFollowUpGroup,
  AssistantFrame,
  AssistantFrameInput,
  AssistantNotice,
  AssistantSourceData,
} from '../domain/assistant.types';
import type { LedgerCosts } from '../infrastructure/assistant.repository';

/**
 * What one reply has produced so far. The runner owns it and folds every
 * emitted frame into it, so whoever ends the turn — the orchestrator, a Stop,
 * the kill switch, the hard ceiling — persists exactly what the client saw.
 */
export type TurnState = {
  text: string;
  textStarted: boolean;
  cards: AssistantCardRef[];
  sources: AssistantSourceData[];
  followUps: AssistantFollowUpGroup[];
  notice: AssistantNotice | null;
  proposalIds: string[];
  costs: LedgerCosts;
  trace: Record<string, unknown>;
};

export function emptyCosts(): LedgerCosts {
  return {
    jevCalls: 0,
    jevModel: null,
    jevInputTokens: null,
    jevOutputTokens: null,
    jevCostUsd: null,
    haikuCalls: 0,
    haikuModel: null,
    haikuInputTokens: null,
    haikuOutputTokens: null,
    haikuUpstreamCostUsd: null,
    haikuOpenrouterCostUsd: null,
    haikuIsByok: null,
  };
}

export function newTurnState(): TurnState {
  return {
    text: '',
    textStarted: false,
    cards: [],
    sources: [],
    followUps: [],
    notice: null,
    proposalIds: [],
    costs: emptyCosts(),
    trace: {},
  };
}

export interface TurnSink {
  emit(frame: AssistantFrameInput): Promise<void>;
}

/** Why a running turn was aborted from outside the orchestrator. */
export type AbortReason = 'stopped' | 'kill_switch' | 'ceiling' | 'shutdown' | 'deleted';

/** How the orchestrator ended a turn it ran to completion. */
export type TurnOutcome = {
  status: 'complete' | 'fallback' | 'truncated';
};

/**
 * Folds one numbered frame into a state. Card frames carry refs only (ids):
 * neither the buffer nor the row keeps a copy of place facts.
 */
export function applyFrame(state: TurnState, frame: AssistantFrame): void {
  switch (frame.type) {
    case 'delta':
      state.text += frame.text;
      state.textStarted = true;
      break;
    case 'card':
      state.cards.push(frame.card as AssistantCardRef);
      break;
    case 'sources':
      state.sources = frame.sources;
      break;
    case 'follow_ups':
      state.followUps = frame.groups;
      break;
    case 'notice':
      state.notice = frame.notice;
      break;
    case 'proposal':
      state.proposalIds.push((frame.proposal as { id: string }).id);
      break;
    default:
      break;
  }
}

/** A hydrated card as stored: the ref, never the facts. */
export function cardRef(card: {
  kind: 'place' | 'plan';
  placeId?: string;
  planId?: string;
  roomId?: string;
}): AssistantCardRef {
  return card.kind === 'place'
    ? { kind: 'place', placeId: card.placeId! }
    : { kind: 'plan', planId: card.planId!, roomId: card.roomId! };
}

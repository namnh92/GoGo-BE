import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { AppError, type FieldError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import { RoomsService } from '../../rooms/application/rooms.service';
import { createRoomSchema } from '../../rooms/presentation/dtos';
import { SuggestionService } from '../../suggestions/application/suggestion.service';
import {
  PROPOSAL_KINDS,
  type AssistantProposalKind,
  type AssistantProposalValue,
} from '../domain/assistant.types';
import { mergeEditedValues, publicProposalStatus, valueOf } from '../domain/proposal';
import { AssistantRepository, type ProposalRow } from '../infrastructure/assistant.repository';
import { AssistantAvailabilityService } from './assistant-availability.service';
import { requireUser } from './assistant-conversations.service';
import { proposalView } from './assistant-views';
import { toCreateRoomInput } from './assistant-orchestrator.service';

type SavedValue = { field: string; value: unknown };
type Execution = {
  resource: { type: string; id: string; roomId?: string };
  savedValues: SavedValue[];
};

/**
 * GoGo-BE#713 — the only assistant path that writes GoGo data. It calls the
 * same use case as the ordinary endpoint with the **user** as actor, so that
 * use case's policy decides (`HOST_ONLY`, room state, published seed places,
 * budget mode); ids are checked again against what the caller can reach now.
 * A proposal confirms once; the global idempotency interceptor replays the
 * response for a retried key.
 */
@Injectable()
export class AssistantProposalsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: AssistantRepository,
    private readonly availability: AssistantAvailabilityService,
    private readonly rooms: RoomsService,
    private readonly suggestions: SuggestionService,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  async get(actor: Actor, proposalId: string) {
    return proposalView(await this.require(actor, proposalId));
  }

  async dismiss(actor: Actor, proposalId: string) {
    const userId = requireUser(actor);
    await this.require(actor, proposalId);
    await this.repo.dismissProposal(userId, proposalId);
    this.metrics.increment('assistant_proposals_total', { outcome: 'dismissed' });
    return proposalView(await this.require(actor, proposalId));
  }

  async confirm(actor: Actor, proposalId: string, edits: Record<string, unknown> | undefined) {
    const userId = requireUser(actor);
    if (!(await this.availability.killSwitchOn())) {
      throw AppError.serviceUnavailable('ASSISTANT_DISABLED', 'Assistant is disabled', false);
    }
    const row = await this.require(actor, proposalId);
    this.assertPending(row);
    const kind = row.kind as AssistantProposalKind;
    if (!PROPOSAL_KINDS.includes(kind))
      throw AppError.conflict('PROPOSAL_NOT_PENDING', 'Unknown proposal kind');
    const merged = mergeEditedValues(kind, row.values, edits);
    if (merged.errors.length > 0) {
      throw AppError.badRequest('VALIDATION_FAILED', 'Edited values are not valid', merged.errors);
    }

    const claimed = await this.repo.claimProposal(userId, proposalId);
    if (!claimed) {
      this.assertPending((await this.repo.findProposal(userId, proposalId)) ?? row);
      throw AppError.conflict('IDEMPOTENT_REQUEST_IN_FLIGHT', 'This proposal is being confirmed');
    }
    let execution: Execution;
    try {
      execution = await this.execute(actor, kind, merged.values);
    } catch (err) {
      await this.repo.releaseProposal(proposalId);
      this.metrics.increment('assistant_proposals_total', { outcome: 'refused' });
      throw err;
    }
    const confirmedAt = new Date().toISOString();
    const result = { proposalId, kind, ...execution, confirmedAt };
    await this.repo.confirmProposal(proposalId, merged.values, result);
    await writeAudit(this.db, {
      actorType: 'user',
      actorId: userId,
      action: 'assistant.proposal_confirmed',
      resourceType: execution.resource.type,
      resourceId: execution.resource.id,
      diff: { proposalId, kind },
    });
    this.metrics.increment('assistant_proposals_total', { outcome: 'confirmed' });
    return result;
  }

  private async require(actor: Actor, proposalId: string): Promise<ProposalRow> {
    const row = await this.repo.findProposal(requireUser(actor), proposalId);
    if (!row) throw AppError.notFound();
    return row;
  }

  private assertPending(row: ProposalRow): void {
    const status = publicProposalStatus(row.status, new Date(row.expires_at), new Date());
    if (status === 'expired')
      throw AppError.conflict('PROPOSAL_EXPIRED', 'This proposal has expired');
    if (status !== 'pending')
      throw AppError.conflict('PROPOSAL_NOT_PENDING', 'This proposal is no longer pending');
  }

  private async execute(
    actor: Actor,
    kind: AssistantProposalKind,
    values: AssistantProposalValue[],
  ): Promise<Execution> {
    switch (kind) {
      case 'create_room': {
        const parsed = createRoomSchema.safeParse(toCreateRoomInput(values));
        if (!parsed.success) {
          const fieldErrors: FieldError[] = parsed.error.issues.map((i) => ({
            field: String(i.path[i.path.length - 1] ?? 'values'),
            code: 'invalid',
            message: i.message,
          }));
          throw AppError.badRequest(
            'VALIDATION_FAILED',
            'Proposal values are not valid',
            fieldErrors,
          );
        }
        const body = parsed.data;
        const constraint = Object.fromEntries(
          Object.entries(body.constraint).filter(([, v]) => v !== undefined),
        ) as typeof body.constraint;
        const room = await this.rooms.createRoom(actor, {
          type: body.type,
          decisionMode: body.decisionMode,
          participantCount: body.participantCount,
          ...(body.title ? { title: body.title } : {}),
          constraint,
          seedPlaceIds: body.seedPlaceIds,
        });
        const c = room.constraints;
        return {
          resource: { type: 'room', id: room.id, roomId: room.id },
          savedValues: [
            { field: 'type', value: room.type },
            { field: 'participantCount', value: room.participantCount },
            { field: 'decisionMode', value: room.decisionMode },
            ...(room.title ? [{ field: 'title', value: room.title }] : []),
            ...(c?.startAt ? [{ field: 'startAt', value: c.startAt }] : []),
            ...(c?.endAt ? [{ field: 'endAt', value: c.endAt }] : []),
            ...(c
              ? [
                  { field: 'budgetMode', value: c.budgetMode },
                  { field: 'budgetAmount', value: c.budgetAmount },
                ]
              : []),
            ...(c?.administrativeArea
              ? [{ field: 'administrativeArea', value: c.administrativeArea }]
              : []),
            { field: 'seedPlaceIds', value: room.seedPlaces.map((s) => s.placeId) },
          ],
        };
      }
      case 'create_invite': {
        const roomId = valueOf<string>(values, 'roomId')!;
        const maxUses = valueOf<number>(values, 'maxUses');
        const invite = await this.rooms.createInvite(actor, roomId, maxUses);
        // The invite code is a credential shown once by the room screen's own
        // flow; it is never stored in the proposal or replayed from here.
        return {
          resource: { type: 'invite', id: invite.inviteId, roomId },
          savedValues: [
            { field: 'roomId', value: roomId },
            { field: 'expiresAt', value: invite.expiresAt },
            ...(invite.maxUses ? [{ field: 'maxUses', value: invite.maxUses }] : []),
          ],
        };
      }
      case 'cast_vote': {
        const roomId = valueOf<string>(values, 'roomId')!;
        const placeId = valueOf<string>(values, 'placeId')!;
        const value = valueOf<'yes' | 'no' | 'star'>(values, 'value') ?? 'yes';
        const voted = await this.suggestions.vote(actor, roomId, placeId, value);
        return {
          resource: { type: 'vote', id: `${roomId}:${placeId}`, roomId },
          savedValues: [
            { field: 'roomId', value: roomId },
            { field: 'placeId', value: placeId },
            { field: 'value', value },
            { field: 'matched', value: voted.matched },
          ],
        };
      }
      case 'finalize_plan': {
        const roomId = valueOf<string>(values, 'roomId')!;
        const placeId = valueOf<string>(values, 'placeId');
        const finalized = await this.suggestions.finalize(actor, roomId, placeId);
        return {
          resource: { type: 'plan', id: finalized.planId, roomId },
          savedValues: [
            { field: 'roomId', value: roomId },
            { field: 'winnerPlaceId', value: finalized.winnerPlaceId },
            { field: 'tie', value: finalized.tie },
          ],
        };
      }
    }
  }
}

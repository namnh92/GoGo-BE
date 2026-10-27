import { describe, expect, it } from 'vitest';
import { AppError } from '../../shared/app-error';
import { AssistantProposalsService } from './assistant-proposals.service';
import type { ProposalRow } from '../infrastructure/assistant.repository';

/**
 * GoGo-BE#717 A-R-07 — a confirm whose target use case may already have
 * written must never be retried into a second write.
 */
const row: ProposalRow = {
  id: 'p1',
  conversation_id: 'c',
  message_id: 'm',
  user_id: 'u',
  kind: 'create_invite',
  status: 'pending',
  values: [
    {
      field: 'roomId',
      value: '33333333-3333-4333-8333-333333333333',
      origin: 'explicit',
      editable: false,
    },
  ],
  result: null,
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 600_000).toISOString(),
  confirmed_at: null,
};

function service(createInvite: () => Promise<unknown>) {
  let status: ProposalRow['status'] = 'pending';
  let writes = 0;
  const repo = {
    findProposal: async () => ({ ...row, status }),
    claimProposal: async () => {
      if (status !== 'pending') return null;
      status = 'confirming';
      return { ...row, status };
    },
    releaseProposal: async () => {
      if (status === 'confirming') status = 'pending';
    },
    confirmProposal: async () => ({ ...row, status: 'confirmed' }),
  };
  const rooms = {
    createInvite: async () => {
      writes += 1;
      return createInvite();
    },
  };
  const svc = new AssistantProposalsService(
    { execute: async () => ({ rows: [] }) } as never,
    repo as never,
    { killSwitchOn: async () => true } as never,
    rooms as never,
    {} as never,
  );
  return { svc, writes: () => writes, status: () => status };
}

const actor = { type: 'user' as const, id: 'u', sessionId: 's' };

describe('proposal confirm after an ambiguous failure (A-R-07)', () => {
  it('a failure after a possible write keeps the proposal claimed: a retry cannot write twice', async () => {
    const h = service(async () => {
      throw new Error('summary read failed after commit');
    });
    await expect(h.svc.confirm(actor, 'p1', undefined)).rejects.toThrow();
    expect(h.status()).toBe('confirming');
    await expect(h.svc.confirm(actor, 'p1', undefined)).rejects.toMatchObject({
      code: 'IDEMPOTENT_REQUEST_IN_FLIGHT',
    });
    expect(h.writes()).toBe(1);
  });

  it('a policy refusal before any write releases it for another try', async () => {
    const h = service(async () => {
      throw AppError.forbidden('HOST_ONLY', 'Only the host can invite');
    });
    await expect(h.svc.confirm(actor, 'p1', undefined)).rejects.toMatchObject({
      code: 'HOST_ONLY',
    });
    expect(h.status()).toBe('pending');
  });
});

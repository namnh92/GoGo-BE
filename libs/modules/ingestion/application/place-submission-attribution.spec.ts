import { getTableName } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import type { Actor } from '../../identity/domain/actor';
import { PlaceSubmissionService } from './place-submission.service';
import type { PlaceResolverService } from './place-resolver.service';
import type { PlaceDedupService } from './place-dedup.service';
import type { AdministrativeResolverService } from '../../administrative/application/administrative-resolver.service';
import type { PlatformConfig, ResolutionAttestationConfig } from '../../shared/config';

vi.mock('../../shared/feature-flags', () => ({
  flagEnvironmentOf: () => 'test',
  resolveBooleanFlag: async () => false,
}));

const actor: Actor = { type: 'user', id: 'user-b', sessionId: 'new-session' };
const proposal = {
  id: 'shared-proposal',
  submittedByUserId: 'user-a',
  googlePlaceId: 'shared-provider',
  submissionCount: 2,
  status: 'pending',
  createdAt: new Date(),
  note: 'A private note',
};

function fixture() {
  const contributions: Record<string, unknown>[] = [];
  const db = {
    execute: vi.fn().mockResolvedValue({ rows: [{ id: actor.id }] }),
    select: () => ({
      from: (table: Parameters<typeof getTableName>[0]) => ({
        where: () => ({
          limit: async () =>
            getTableName(table) === 'place_submissions' ? [proposal] : contributions,
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({ returning: async () => [proposal] }),
        onConflictDoNothing: async () => {
          if (getTableName(table) === 'place_submission_contributors') contributions.push(values);
        },
      }),
    }),
    transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
  };
  const service = new PlaceSubmissionService(
    db as unknown as Db,
    {
      resolveByProviderId: async () => ({
        status: 'RESOLVED',
        details: { businessStatus: 'OPERATIONAL' },
      }),
    } as unknown as PlaceResolverService,
    {
      check: async () => ({ kind: 'NEW' }),
      reportIdMismatch: vi.fn(),
    } as unknown as PlaceDedupService,
    {} as AdministrativeResolverService,
    {} as PlatformConfig & ResolutionAttestationConfig,
  );
  return { service, contributions, db };
}

describe('Shared proposal contribution attribution (#788 F-01)', () => {
  it('persists B when deduplication returns A’s proposal', async () => {
    const { service, contributions } = fixture();
    await expect(service.submit(actor, { googlePlaceId: proposal.googlePlaceId })).resolves.toEqual(
      {
        status: 'PENDING',
        submissionId: proposal.id,
        deduped: true,
      },
    );
    expect(contributions).toEqual([{ submissionId: proposal.id, userId: actor.id }]);
  });

  it('lets an attributed contributor poll without exposing the original contributor’s note', async () => {
    const { service } = fixture();
    await service.submit(actor, { googlePlaceId: proposal.googlePlaceId });
    await expect(service.getSubmission(actor, proposal.id)).resolves.toEqual({
      id: proposal.id,
      status: 'pending',
      googlePlaceId: proposal.googlePlaceId,
      placeId: undefined,
      submissionCount: 2,
      createdAt: proposal.createdAt.toISOString(),
      decidedAt: undefined,
    });
  });

  it('refuses polling for a user with no contribution', async () => {
    const { service } = fixture();
    await expect(service.getSubmission(actor, proposal.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('does not recreate attribution when erasure completed during provider verification', async () => {
    const { service, contributions, db } = fixture();
    db.execute.mockResolvedValue({ rows: [] });
    await expect(
      service.submit(actor, { googlePlaceId: proposal.googlePlaceId }),
    ).rejects.toMatchObject({
      code: 'CONTRIBUTOR_UNAVAILABLE',
    });
    expect(contributions).toEqual([]);
  });
});

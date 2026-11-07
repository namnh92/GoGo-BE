import { getTableName } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePlaceProvider } from '@gogo/providers';
import type { Db } from '@gogo/database';
import type { Actor } from '../../identity/domain/actor';
import { PlaceSubmissionService } from './place-submission.service';
import type { SubmissionPhotosService } from './submission-photos.service';
import type { PlaceResolverService } from './place-resolver.service';
import type { PlaceDedupService } from './place-dedup.service';
import type { AdministrativeResolverService } from '../../administrative/application/administrative-resolver.service';
import { signResolutionAttestation } from '../domain/resolution-attestation';
import type { PlatformConfig, ResolutionAttestationConfig } from '../../shared/config';

const flags = vi.hoisted(() => ({ attestation: false }));
beforeEach(() => {
  flags.attestation = false;
});

vi.mock('../../shared/feature-flags', () => ({
  flagEnvironmentOf: () => 'test',
  resolveBooleanFlag: async (_db: unknown, key: string) =>
    key === 'place_resolution_attestation.enabled' && flags.attestation,
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
  const submissions: Record<string, unknown>[] = [];
  const db = {
    execute: vi.fn().mockResolvedValue({ rows: [{ id: actor.id }] }),
    select: () => ({
      from: (table: Parameters<typeof getTableName>[0]) => ({
        where: () => ({
          for: () => ({ limit: async () => [proposal] }),
          limit: async () =>
            getTableName(table) === 'place_submissions' ? [proposal] : contributions,
        }),
      }),
    }),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (getTableName(table) === 'place_submissions') submissions.push(values);
        },
      }),
    }),
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: () => {
          submissions.push(values);
          return { returning: async () => [proposal] };
        },
        onConflictDoNothing: async () => {
          if (getTableName(table) === 'place_submission_contributors') contributions.push(values);
        },
      }),
    }),
    transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
  };
  const photos = {
    prepare: vi.fn<SubmissionPhotosService['prepare']>().mockResolvedValue({
      photos: [],
      reusedIds: [],
      verified: {} as never,
    }),
    attach: vi.fn<SubmissionPhotosService['attach']>().mockResolvedValue(undefined),
  };
  const provider = new FakePlaceProvider();
  provider.seed({ providerPlaceId: proposal.googlePlaceId });
  const resolveByProviderId = vi.fn(async () => ({
    status: 'RESOLVED',
    details: provider.registry.get(proposal.googlePlaceId)!,
  }));
  const service = new PlaceSubmissionService(
    db as unknown as Db,
    { resolveByProviderId } as unknown as PlaceResolverService,
    {
      check: async () => ({ kind: 'NEW' }),
      reportIdMismatch: vi.fn(),
      resolveGoogleIdentity: async () => ({ kind: 'UNLINKED' }),
    } as unknown as PlaceDedupService,
    {} as AdministrativeResolverService,
    { PLACE_RESOLUTION_ATTESTATION_SECRET: 'test-snapshot-secret' } as PlatformConfig &
      ResolutionAttestationConfig,
    photos as unknown as SubmissionPhotosService,
  );
  return { service, contributions, submissions, resolveByProviderId, db };
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

it('#801 persists the signed resolved candidate without another provider call on submit', async () => {
  flags.attestation = true;
  const { service, submissions, resolveByProviderId } = fixture();
  const displaySnapshot = {
    source: 'google_places' as const,
    fetchedAt: new Date().toISOString(),
    name: 'Resolved café',
    addressShort: 'Hà Nội',
    attributions: ['Google Maps'],
    googleMapsUri: null,
    googleRating: 4.6,
    googleRatingCount: 980,
    openingHours: [],
  };
  const resolutionToken = signResolutionAttestation({
    googlePlaceId: proposal.googlePlaceId,
    secret: 'test-snapshot-secret',
    ttlSeconds: 600,
    displaySnapshot,
  });
  await service.submit(actor, { googlePlaceId: proposal.googlePlaceId, resolutionToken });
  expect(submissions[0]?.displaySnapshot).toEqual(displaySnapshot);
  expect(resolveByProviderId).not.toHaveBeenCalled();
});

it('#801 captures the quality verification snapshot when no candidate token is provided', async () => {
  const { service, submissions, resolveByProviderId } = fixture();
  await service.submit(actor, { googlePlaceId: proposal.googlePlaceId });
  expect(resolveByProviderId).toHaveBeenCalledExactlyOnceWith(proposal.googlePlaceId, 'quality');
  expect(submissions[0]?.displaySnapshot).toMatchObject({
    source: 'google_places',
    googleRating: 4.4,
    googleRatingCount: 250,
  });
  expect(submissions[0]?.displaySnapshot).not.toHaveProperty('photo');
});

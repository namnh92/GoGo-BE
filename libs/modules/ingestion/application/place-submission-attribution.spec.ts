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
import { randomUUID } from 'node:crypto';
import { ResolutionSnapshotStore } from './resolution-snapshot.store';
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
    decision: { reasons: ['EXACT_PROVIDER_ID'] },
    details: provider.registry.get(proposal.googlePlaceId)!,
  }));
  const snapshots = new ResolutionSnapshotStore(null);
  const service = new PlaceSubmissionService(
    db as unknown as Db,
    { resolveByProviderId, scoreFor: async () => 0.8 } as unknown as PlaceResolverService,
    {
      check: async () => ({ kind: 'NEW' }),
      reportIdMismatch: vi.fn(),
      resolveGoogleIdentity: async () => ({ kind: 'UNLINKED' }),
    } as unknown as PlaceDedupService,
    {} as AdministrativeResolverService,
    {
      PLACE_RESOLUTION_ATTESTATION_SECRET: 'test-snapshot-secret',
      PLACE_RESOLUTION_TTL_S: 600,
    } as PlatformConfig & ResolutionAttestationConfig,
    photos as unknown as SubmissionPhotosService,
    undefined,
    undefined,
    undefined,
    snapshots,
  );
  return { service, contributions, submissions, resolveByProviderId, db, snapshots, provider };
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

it('#801 persists the server-side resolved snapshot without another provider call on submit', async () => {
  flags.attestation = true;
  const { service, submissions, resolveByProviderId, snapshots } = fixture();
  const displaySnapshot = {
    source: 'google_places' as const,
    fetchedAt: new Date().toISOString(),
    name: 'Đ'.repeat(1000),
    addressShort: 'Đ'.repeat(2000),
    attributions: Array.from({ length: 10 }, () => 'Đ'.repeat(500)),
    googleMapsUri: null,
    googleRating: 4.6,
    googleRatingCount: 980,
    openingHours: Array.from({ length: 100 }, () => ({
      dayOfWeek: 0,
      openMinute: 0,
      closeMinute: 1440,
      isOvernight: false,
    })),
  };
  const resolutionId = randomUUID();
  await snapshots.put(resolutionId, {
    googlePlaceId: proposal.googlePlaceId,
    expiresAt: new Date(Date.parse(displaySnapshot.fetchedAt) + 600_000).toISOString(),
    snapshot: displaySnapshot,
  });
  const resolutionToken = signResolutionAttestation({
    googlePlaceId: proposal.googlePlaceId,
    secret: 'test-snapshot-secret',
    ttlSeconds: 600,
    resolutionId,
    now: new Date(displaySnapshot.fetchedAt),
  });
  expect(resolutionToken.length).toBeLessThanOrEqual(1024);
  await service.submit(actor, { googlePlaceId: proposal.googlePlaceId, resolutionToken });
  expect(submissions[0]?.displaySnapshot).toEqual(displaySnapshot);
  expect(resolveByProviderId).not.toHaveBeenCalled();
  snapshots.onModuleDestroy();
});

it('#801 resolves and submits a large snapshot using only the original quality fetch', async () => {
  flags.attestation = true;
  const { service, provider, submissions, resolveByProviderId, snapshots } = fixture();
  const details = provider.registry.get(proposal.googlePlaceId)!;
  details.name = 'Đ'.repeat(1000);
  details.addressText = 'Đ'.repeat(2000);
  details.shortAddress = 'Hà Nội';
  details.hours = Array.from({ length: 100 }, () => ({
    dayOfWeek: 0,
    openMinute: 0,
    closeMinute: 1440,
    isOvernight: false,
  }));
  const preview = await service.resolveLink({ googlePlaceId: proposal.googlePlaceId });
  expect(preview.resolutionToken).toBeTruthy();
  expect(preview.resolutionToken!.length).toBeLessThanOrEqual(1024);
  await service.submit(actor, {
    googlePlaceId: proposal.googlePlaceId,
    resolutionToken: preview.resolutionToken,
  });
  expect(resolveByProviderId).toHaveBeenCalledExactlyOnceWith(proposal.googlePlaceId, 'quality');
  expect(submissions[0]?.displaySnapshot).toMatchObject({
    name: details.name,
    addressShort: 'Hà Nội',
    openingHours: details.hours,
    fetchedAt: preview.candidate!.fetchedAt,
  });
  snapshots.onModuleDestroy();
});

it.each(['missing', 'outage', 'mismatch'] as const)(
  '#801 rejects a %s resolution snapshot without a provider fetch or submission write',
  async (failure) => {
    flags.attestation = true;
    const { service, submissions, resolveByProviderId, snapshots } = fixture();
    const resolutionId = randomUUID();
    const now = new Date();
    if (failure === 'outage')
      vi.spyOn(snapshots, 'get').mockRejectedValue(new Error('Redis unavailable'));
    if (failure === 'mismatch')
      await snapshots.put(resolutionId, {
        googlePlaceId: 'another-place',
        expiresAt: new Date(now.getTime() + 600_000).toISOString(),
        snapshot: {
          source: 'google_places',
          fetchedAt: now.toISOString(),
          name: 'Other café',
          addressShort: '',
          attributions: [],
          googleMapsUri: null,
          googleRating: null,
          googleRatingCount: 0,
          openingHours: [],
        },
      });
    const resolutionToken = signResolutionAttestation({
      googlePlaceId: proposal.googlePlaceId,
      resolutionId,
      now,
      secret: 'test-snapshot-secret',
      ttlSeconds: 600,
    });
    await expect(
      service.submit(actor, { googlePlaceId: proposal.googlePlaceId, resolutionToken }),
    ).rejects.toMatchObject({ code: 'RESOLUTION_TOKEN_INVALID', options: { retryable: true } });
    expect(submissions).toEqual([]);
    expect(resolveByProviderId).not.toHaveBeenCalled();
    snapshots.onModuleDestroy();
  },
);

it('#801 keeps legacy identity-only tokens valid without buying display facts', async () => {
  flags.attestation = true;
  const { service, submissions, resolveByProviderId } = fixture();
  const resolutionToken = signResolutionAttestation({
    googlePlaceId: proposal.googlePlaceId,
    secret: 'test-snapshot-secret',
    ttlSeconds: 600,
  });
  await service.submit(actor, { googlePlaceId: proposal.googlePlaceId, resolutionToken });
  expect(submissions[0]).not.toHaveProperty('displaySnapshot');
  expect(resolveByProviderId).not.toHaveBeenCalled();
});

it('#801 refuses resolve when its snapshot cannot be stored', async () => {
  flags.attestation = true;
  const { service, snapshots } = fixture();
  vi.spyOn(snapshots, 'put').mockRejectedValue(new Error('Redis unavailable'));
  await expect(
    service.resolveLink({ googlePlaceId: proposal.googlePlaceId }),
  ).rejects.toMatchObject({
    code: 'PLACE_PROVIDER_UNAVAILABLE',
    httpStatus: 503,
    options: { retryable: true },
  });
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

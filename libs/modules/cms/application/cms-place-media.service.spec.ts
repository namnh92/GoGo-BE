import { readFileSync } from 'node:fs';
import { schema } from '@gogo/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { CmsPlaceMediaService } from './cms-place-media.service';
import { CmsCatalogService } from './cms-catalog.service';

const providerPhoto = {
  provider: 'google' as const,
  sourceReference: 'ChIJ-test',
  fetchedAt: '2026-11-07T00:00:00.000Z',
  authorAttributions: [
    { displayName: 'Lan', uri: 'https://maps.google.com/contrib/lan', photoUri: null },
  ],
  googleMapsUri: 'https://www.google.com/maps/photo/one',
};

function mediaRow() {
  return {
    id: 'media',
    placeId: 'place',
    storageKey: 'places/provider/test.jpg',
    sourceType: 'google_derived',
    attribution: 'Google Maps',
    providerPhoto,
    createdAt: new Date('2026-11-07T00:00:00Z'),
    moderatedAt: null,
  };
}

function mediaSetup(refs = 0, provider = true) {
  const row = {
    ...mediaRow(),
    sourceType: provider ? 'google_derived' : 'editorial',
    providerPhoto: provider ? providerPhoto : null,
  };
  const queueValues = vi.fn(() => ({ onConflictDoNothing: vi.fn(async () => undefined) }));
  const tx = {
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    execute: vi.fn(async () => ({ rows: [{ refs }] })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    insert: vi.fn(() => ({ values: queueValues })),
  };
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
    transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(tx)),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };
  return { row, tx, db, queueValues, service: new CmsPlaceMediaService(db as never, {} as never) };
}

// This guard runs before any mutation: an editor can reorder a provider photo,
// but cannot turn a required provider credit into an empty or editorial label.
describe('provider media credits (#786)', () => {
  it.each(['google_derived', 'provider'])(
    'refuses removing attribution on %s media',
    async (sourceType) => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [
                { sourceType, attribution: 'Google Maps', providerPhoto: { provider: 'google' } },
              ],
            }),
          }),
        }),
      };
      const service = new CmsPlaceMediaService(db as never, {} as never);
      await expect(
        service.update({ id: 'editor' } as never, 'place', 'media', { attribution: null }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ATTRIBUTION_IMMUTABLE' });
    },
  );
});

describe('provider media detach (#786 F-02)', () => {
  it('enqueues the last provider reference for public cleanup inside the detach transaction', async () => {
    const { service, tx, db, queueValues, row } = mediaSetup();
    await expect(service.detach({ id: 'editor' } as never, 'place', 'media')).resolves.toEqual({
      detached: true,
    });
    expect(tx.insert).toHaveBeenCalledWith(schema.mediaCleanupQueue);
    expect(queueValues).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'public',
        objectKey: row.storageKey,
        reason: 'submission_provider_photo_detached',
      }),
    );
    expect(db.insert).not.toHaveBeenCalledWith(schema.mediaCleanupQueue);
  });

  it('propagates cleanup enqueue failure so the transaction cannot commit the detach', async () => {
    const { service, queueValues, db } = mediaSetup();
    queueValues.mockImplementation(() => {
      throw new Error('queue unavailable');
    });
    await expect(service.detach({ id: 'editor' } as never, 'place', 'media')).rejects.toThrow(
      'queue unavailable',
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('preserves shared provider bytes until their last reference is detached', async () => {
    const { service, tx } = mediaSetup(1);
    await service.detach({ id: 'editor' } as never, 'place', 'media');
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('keeps editorial uploads on the existing pending-upload sweeper path', async () => {
    const { service, tx } = mediaSetup(0, false);
    await service.detach({ id: 'editor' } as never, 'place', 'media');
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).toHaveBeenCalledWith(schema.mediaUploads);
  });
});

describe('CMS provider photo attribution (#786 F-03)', () => {
  it('keeps the existing editorial DTO additive by omitting provider-only fields', async () => {
    const { service } = mediaSetup(0, false);
    const result = await service.update({ id: 'editor' } as never, 'place', 'media', {});
    expect(result).not.toHaveProperty('authorAttributions');
    expect(result).not.toHaveProperty('googleMapsUri');
  });

  it('preserves structured credits and Maps URI when returning an unchanged provider photo', async () => {
    const { service } = mediaSetup();
    const result = await service.update({ id: 'editor' } as never, 'place', 'media', {});
    expect(result).toMatchObject({
      authorAttributions: providerPhoto.authorAttributions,
      googleMapsUri: providerPhoto.googleMapsUri,
    });
    expect(result).not.toHaveProperty('providerPhoto');
  });

  it('loads and exposes credits in the catalogue detail mapping as well', async () => {
    const rawMedia = {
      id: 'media',
      storage_key: 'places/provider/test.jpg',
      provider_photo: providerPhoto,
      attribution: 'Google Maps',
      source_type: 'google_derived',
      created_at: providerPhoto.fetchedAt,
      moderated_at: null,
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'place', provenance: [], administrative_mapping_status: 'UNMAPPED' }],
      })
      .mockResolvedValueOnce({ rows: [] }) // taxonomies
      .mockResolvedValueOnce({ rows: [] }) // hours
      .mockResolvedValueOnce({ rows: [] }) // prices
      .mockResolvedValueOnce({ rows: [] }) // sources
      .mockResolvedValueOnce({ rows: [rawMedia] })
      .mockResolvedValueOnce({ rows: [] }) // reviews
      .mockResolvedValueOnce({
        rows: [{ identity_revision: 1, version: 0, status: 'unverified' }],
      });
    const db = {
      execute,
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    };
    const service = new CmsCatalogService(db as never, {} as never, {} as never);
    const result = await service.getPlace('place');
    expect(result.media[0]).toMatchObject({
      authorAttributions: providerPhoto.authorAttributions,
      googleMapsUri: providerPhoto.googleMapsUri,
    });
    const mediaQuery = new PgDialect().sqlToQuery(execute.mock.calls[5]![0]).sql;
    expect(mediaQuery).toContain('provider_photo');
    expect(result.media[0]).not.toHaveProperty('providerPhoto');
  });

  it('adds optional CMS credits to OpenAPI using the existing structured author schema', () => {
    const spec = parse(readFileSync('openapi/gogo.v1.yaml', 'utf8'));
    const media = spec.components.schemas.CmsPlaceMedia;
    expect(media.properties.authorAttributions).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/ProviderPhotoAuthor' },
    });
    expect(media.properties.googleMapsUri).toEqual(
      expect.objectContaining({ type: ['string', 'null'], format: 'uri' }),
    );
    expect(media.required).not.toContain('authorAttributions');
    expect(media.required).not.toContain('googleMapsUri');
  });
});

import type { components, operations } from '../../../../openapi/gogo.v1';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const doc = parse(
  readFileSync(path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml'), 'utf8'),
);
describe('#878 seed client contract', () => {
  it('exposes membership attribution and preserves position without account identifiers', () => {
    const seed = doc.components.schemas.RoomSeedPlace;
    expect(seed?.required).toEqual(['placeId', 'name', 'position', 'addedByMemberId']);
    expect(Object.keys(seed.properties).sort()).toEqual([
      'addedByMemberId',
      'name',
      'placeId',
      'position',
    ]);
    expect(doc.components.schemas.RoomSummary.properties.seedPlaces.items.$ref).toBe(
      '#/components/schemas/RoomSeedPlace',
    );
  });
  it.each([
    ['/rooms/{id}/seed-places', 'post'],
    ['/rooms/{id}/seed-places/{placeId}', 'delete'],
  ])('declares response, replay and refusal for %s', (route, method) => {
    const op = doc.paths[route!][method!];
    expect(op.responses['200'].content?.['application/json'].schema.$ref).toBe(
      '#/components/schemas/RoomSeedPlacesResponse',
    );
    expect(op.responses['201']).toBeUndefined();
    for (const status of ['400', '401', '403', '404', '409', '422', '503'])
      expect(op.responses[status]).toBeDefined();
    expect(
      op.parameters.some(
        (p: { $ref?: string }) => p.$ref === '#/components/parameters/IdempotencyKey',
      ),
    ).toBe(true);
  });
  it('compiles legacy bodies without a key and the new attributed mutation DTO using generated types', () => {
    const legacy: operations['addRoomSeedPlaces']['requestBody']['content']['application/json'] = {
      placeIds: ['00000000-0000-4000-8000-000000000001'],
    };
    const seed: components['schemas']['RoomSeedPlace'] = {
      placeId: legacy.placeIds[0]!,
      name: 'Catalog',
      position: 0,
      addedByMemberId: '00000000-0000-4000-8000-000000000002',
    };
    const added: operations['addRoomSeedPlaces']['responses'][200]['content']['application/json'] =
      { seedPlaces: [seed], constraintVersion: 2 };
    const removed: operations['removeRoomSeedPlace']['responses'][200]['content']['application/json'] =
      added;
    expect(removed.seedPlaces[0]).toEqual(seed);
  });
});

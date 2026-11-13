import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

it('#906 publishes additive settings API with required headers, lossless version and error envelopes', () => {
  const spec = parse(readFileSync(resolve(__dirname, '../../../../openapi/gogo.v1.yaml'), 'utf8'));
  expect(spec.info.version).toBe('12.3.0-alpha.1');
  const path = spec.paths['/cms/settings/room-invites'];
  expect(path.get.operationId).toBe('getCmsRoomInviteSettings');
  expect(path.put.operationId).toBe('updateCmsRoomInviteSettings');
  expect(path.put.parameters).toEqual(
    expect.arrayContaining(
      ['If-Match', 'Idempotency-Key'].map((name) =>
        expect.objectContaining({ name, in: 'header', required: true }),
      ),
    ),
  );
  for (const method of ['get', 'put']) {
    expect(path[method].responses['200'].headers).toHaveProperty('ETag');
    expect(path[method].responses['200'].headers['Cache-Control'].schema.const).toBe(
      'private, no-store, no-transform',
    );
  }
  for (const status of ['400', '409', '412', '422', '428', '503'])
    expect(path.put.responses[status].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/ErrorEnvelope',
    );
  expect(spec.components.schemas.CmsRoomInviteSettings.properties.version).toMatchObject({
    type: 'string',
    readOnly: true,
  });
  expect(spec.components.schemas.UpdateCmsRoomInviteSettings).toMatchObject({
    additionalProperties: false,
    required: ['ttlSeconds'],
    properties: { ttlSeconds: { type: 'integer', minimum: 1, maximum: 2147483647 } },
  });
  expect(spec.paths['/cms/audit'].get.description).toContain('before filters');
});

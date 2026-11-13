import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import {
  CmsRoomInviteSettingsController,
  requireStrongIfMatch,
} from './cms-room-invite-settings.controller';
import { updateRoomInviteSettingsSchema } from './room-invite-settings.dto';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { ACCESS_SSO_KEY, ADMIN_ROLES_KEY } from './admin.guard';
import { MANUAL_IDEMPOTENCY_KEY } from '../../shared/idempotency.interceptor';

const actor = { type: 'admin', id: 'admin', sessionId: 's', role: 'super_admin' } as const;
const body = {
  ttlSeconds: 300,
  version: '9007199254740993',
  etag: '"room-invite-ttl-v1-r9007199254740993"',
};
function harness() {
  const read = vi.fn().mockResolvedValue(body);
  const update = vi.fn().mockResolvedValue({ body, replayed: false });
  const controller = new CmsRoomInviteSettingsController({ read, update } as never);
  const reply = { header: vi.fn().mockReturnThis() };
  const request = () => ({
    method: 'PUT',
    url: '/v1/cms/settings/room-invites',
    body: { ttlSeconds: 300 },
  });
  const put = (tag: unknown = '"r1"', key: unknown = 'stable-key') =>
    controller.update(actor, request() as never, reply as never, tag, key, { ttlSeconds: 300 });
  return { controller, reply, put, read, update };
}

describe('#906 CMS invite TTL controller and DTO', () => {
  it.each([1, 300, 86400, 172800, 172801, 2147483647])('accepts %i seconds', (ttlSeconds) => {
    expect(updateRoomInviteSettingsSchema.parse({ ttlSeconds })).toEqual({ ttlSeconds });
  });
  it.each([0, -1, 0.5, 2147483648, '300', null, undefined, NaN, Infinity])(
    'rejects %s without coercion with field error',
    (ttlSeconds) => {
      expect(() =>
        new ZodValidationPipe(updateRoomInviteSettingsSchema).transform({ ttlSeconds }),
      ).toThrow(
        expect.objectContaining({
          code: 'VALIDATION_FAILED',
          options: {
            fieldErrors: expect.arrayContaining([expect.objectContaining({ field: 'ttlSeconds' })]),
          },
        }),
      );
    },
  );
  it('rejects metadata, actor and unknown fields', () => {
    for (const extra of ['version', 'updatedAt', 'updatedByAdminId', 'expiry', 'anything'])
      expect(
        updateRoomInviteSettingsSchema.safeParse({ ttlSeconds: 300, [extra]: 'injected' }).success,
      ).toBe(false);
  });
  it.each(['*', 'W/"r1"', '"r1", "r2"', 'r1', '', '"r1\nr2"', '\n"r1"', '\u00a0"r1"', ['"r1"']])(
    'rejects malformed If-Match %s',
    (tag) => {
      expect(() => requireStrongIfMatch(tag)).toThrow(
        expect.objectContaining({ code: 'INVALID_IF_MATCH', httpStatus: 400 }),
      );
    },
  );
  it('requires If-Match and normalizes surrounding whitespace only', () => {
    expect(() => requireStrongIfMatch(undefined)).toThrow(
      expect.objectContaining({ code: 'PRECONDITION_REQUIRED', httpStatus: 428 }),
    );
    expect(requireStrongIfMatch('  "r1"  ')).toBe('"r1"');
  });
  it('requires super_admin, SSO and manual idempotency metadata', () => {
    const reflector = new Reflector();
    expect(reflector.get(ADMIN_ROLES_KEY, CmsRoomInviteSettingsController)).toEqual([
      'super_admin',
    ]);
    expect(reflector.get(ACCESS_SSO_KEY, CmsRoomInviteSettingsController)).toBe(true);
    expect(
      reflector.get(MANUAL_IDEMPOTENCY_KEY, CmsRoomInviteSettingsController.prototype.update),
    ).toBe(true);
  });
  it('sets identical body/header ETag and private no-store/no-transform on reads', async () => {
    const h = harness();
    expect(await h.controller.read(h.reply as never)).toEqual(body);
    expect(h.reply.header.mock.calls).toEqual([
      ['ETag', body.etag],
      ['Cache-Control', 'private, no-store, no-transform'],
    ]);
  });
  it('requires a valid idempotency key before service mutation', async () => {
    const h = harness();
    await expect(
      h.controller.update(actor, {} as never, h.reply as never, '"r1"', undefined, {
        ttlSeconds: 300,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    for (const key of ['', 'short', 'bad key with spaces', ['two-keys']])
      await expect(h.put('"r1"', key)).rejects.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
    expect(h.update).not.toHaveBeenCalled();
  });
  it('binds normalized If-Match without changing the claim namespace and sets replay ETag', async () => {
    const h = harness();
    h.update.mockResolvedValue({ body, replayed: true });
    await h.put(' "r1" ');
    await h.put('"r1"');
    await h.put('"r2"');
    const scopes = h.update.mock.calls.map((call) => call[3]);
    expect(scopes[0]).toEqual(scopes[1]);
    expect(scopes[0].storedKey).toBe(scopes[2].storedKey);
    expect(scopes[0].requestHash).not.toBe(scopes[2].requestHash);
    expect(h.reply.header).toHaveBeenCalledWith('x-idempotent-replay', 'true');
    expect(h.reply.header).toHaveBeenCalledWith('ETag', body.etag);
  });
});

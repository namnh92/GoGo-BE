import { randomBytes, randomUUID } from 'node:crypto';
import { NoopMetrics, type MetricsPort } from '@gogo/observability';
import { describe, expect, it, vi } from 'vitest';
import { InviteCodeCrypto } from '../application/invite-code-crypto';
import { InviteCodeReservations, type InviteTransaction } from './invite-code-reservations';

vi.mock('./invite-foundation-readiness', () => ({ assertInviteFoundationReady: vi.fn() }));
function fixture(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  const room = {
    invitation_epoch: '0',
    automatic_invites_suppressed: false,
    code6_backfill_completed_at: null,
    expires_at: null,
    eligible: true,
    ...overrides,
  };
  // Drizzle raw execute() leaves PostgreSQL timestamptz values as text.
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ rows: [room] })
    .mockResolvedValueOnce({ rows: [{ now: now.toISOString() }] })
    .mockResolvedValueOnce({ rows: [{ id: randomUUID() }] })
    .mockResolvedValueOnce({ rows: [] });
  const values = vi
    .fn<
      (row: {
        codeLookup: string;
        codeCiphertext: string;
        encryptionKeyVersion: string;
      }) => Promise<void>
    >()
    .mockResolvedValue(undefined);
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ insert: () => ({ values }) }),
  );
  const tx = { execute, transaction } as unknown as InviteTransaction;
  const crypto = new InviteCodeCrypto({
    lookupKey: randomBytes(32).toString('hex'),
    replayKey: randomBytes(32).toString('hex'),
    bucketKey: randomBytes(32).toString('hex'),
    activeEncryptionVersion: 'v1',
    encryptionKeys: { v1: randomBytes(32).toString('hex') },
  });
  const metrics: MetricsPort = new NoopMetrics();
  const emit = vi.spyOn(metrics, 'increment');
  return {
    now,
    crypto,
    values,
    transaction,
    execute,
    tx,
    emit,
    service: new InviteCodeReservations(crypto, metrics),
    input: { roomId: randomUUID(), actorUserId: randomUUID(), expectedInvitationEpoch: 0n },
  };
}
describe('I03 internal allocation', () => {
  it('caps lifetime at room expiry and encrypts instead of persisting plaintext', async () => {
    const expiry = new Date(Date.now() + 60_000);
    const f = fixture({ expires_at: expiry.toISOString() });
    vi.spyOn(f.crypto, 'generateCode').mockReturnValue('000000');
    const result = await f.service.allocate(f.tx, f.input);
    expect(result).toMatchObject({ code: '000000', issuedAt: f.now, expiresAt: expiry });
    const row = f.values.mock.calls[0]![0];
    expect(row).not.toHaveProperty('code');
    expect(row.codeLookup).toBe(f.crypto.lookupCode('000000'));
    expect(f.crypto.decryptCode(row, { roomId: f.input.roomId, generationId: result.id })).toBe(
      '000000',
    );
  });
  it.each([null, '2099-01-01 07:00:00.000000+07'])(
    'caps lifetime at 48 hours from the post-lock clock when room expiry is %s',
    async (expires_at) => {
      const f = fixture({ expires_at });
      const result = await f.service.allocate(f.tx, f.input);
      expect(result.issuedAt).toEqual(f.now);
      expect(result.expiresAt.getTime()).toBe(f.now.getTime() + 48 * 60 * 60 * 1000);
    },
  );
  it('decodes PostgreSQL timestamp text with an offset and fractional seconds before comparing deadlines', async () => {
    const f = fixture({ expires_at: '2026-11-13 07:00:00.123456+07' });
    f.execute
      .mockReset()
      .mockResolvedValueOnce({
        rows: [
          { eligible: true, invitation_epoch: '0', expires_at: '2026-11-13 07:00:00.123456+07' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ now: '2026-11-12 07:00:00.123456+07' }] })
      .mockResolvedValueOnce({ rows: [{ id: randomUUID() }] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await f.service.allocate(f.tx, f.input);
    expect(result.issuedAt).toEqual(new Date('2026-11-12T00:00:00.123Z'));
    expect(result.expiresAt).toEqual(new Date('2026-11-13T00:00:00.123Z'));
  });
  it('bounds collisions at 20 savepoints and returns a safe temporary error', async () => {
    const f = fixture();
    f.values.mockRejectedValue({
      cause: { code: '23505', constraint: 'room_invite_codes_open_lookup_unique' },
    });
    await expect(f.service.allocate(f.tx, f.input)).rejects.toThrow('COLLISIONS_EXHAUSTED');
    expect(f.transaction).toHaveBeenCalledTimes(20);
    expect(f.values).toHaveBeenCalledTimes(20);
    expect(
      f.emit.mock.calls.filter(([name]) => name === 'room_invite_collision_total'),
    ).toHaveLength(20);
    // Only our room and grants are read; no attempt to clean up/lock another room.
    expect(f.execute).toHaveBeenCalledTimes(4);
  });
  it('retries a unique lookup collision in a savepoint, but never retries an unrelated unique failure', async () => {
    const f = fixture();
    f.values.mockRejectedValueOnce({
      code: '23505',
      constraint: 'room_invite_codes_open_lookup_unique',
    });
    await f.service.allocate(f.tx, f.input);
    expect(f.transaction).toHaveBeenCalledTimes(2);
    const bad = fixture();
    bad.values.mockRejectedValue({ code: '23505', constraint: 'other', detail: 'secret marker' });
    await expect(bad.service.allocate(bad.tx, bad.input)).rejects.toThrow('STORAGE_UNAVAILABLE');
    expect(bad.transaction).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ eligible: false }, {}, 'ROOM_NOT_ELIGIBLE'],
    [{ expires_at: new Date(0).toISOString() }, {}, 'ROOM_NOT_ELIGIBLE'],
    [{ invitation_epoch: '1' }, {}, 'INVITATION_STATE_CHANGED'],
    [{ automatic_invites_suppressed: true }, {}, 'INVITATIONS_REISSUE_REQUIRED'],
    [
      { automatic_invites_suppressed: true },
      { automatic: true, reissueAfterRevocation: true },
      'AUTOMATIC_ISSUANCE_SUPPRESSED',
    ],
    [
      { code6_backfill_completed_at: new Date().toISOString() },
      { automatic: true },
      'AUTOMATIC_ISSUANCE_SUPPRESSED',
    ],
  ])('rejects state %j before any insert', async (room, input, failure) => {
    const f = fixture(room);
    await expect(f.service.allocate(f.tx, { ...f.input, ...input })).rejects.toThrow(failure);
    expect(f.values).not.toHaveBeenCalled();
  });
  it('does not reissue over OPEN reservations, including expired ones pending cleanup', async () => {
    const f = fixture();
    f.execute
      .mockReset()
      .mockResolvedValueOnce({ rows: [{ eligible: true, invitation_epoch: '0' }] })
      .mockResolvedValueOnce({ rows: [{ now: f.now.toISOString() }] })
      .mockResolvedValueOnce({ rows: [{ id: randomUUID() }] })
      .mockResolvedValueOnce({ rows: [{ reservation_state: 'OPEN' }] });
    await expect(f.service.allocate(f.tx, f.input)).rejects.toThrow('OPEN_GENERATION_EXISTS');
    expect(f.values).not.toHaveBeenCalled();
  });
  it('requires a live host membership after room lock', async () => {
    const f = fixture();
    f.execute
      .mockReset()
      .mockResolvedValueOnce({ rows: [{ eligible: true, invitation_epoch: '0' }] })
      .mockResolvedValueOnce({ rows: [{ now: f.now.toISOString() }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(f.service.allocate(f.tx, f.input)).rejects.toThrow('HOST_REQUIRED');
  });
});

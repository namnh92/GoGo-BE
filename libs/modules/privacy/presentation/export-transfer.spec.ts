import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportClientGoneError, type RedeemedExport } from '../application/privacy-export.service';
import { transferExport, type TransferReply } from './export-transfer';

/**
 * PR #677 A-F-02 — every way a transfer can end finalizes exactly once, and a
 * disconnect during redemption is observed, not missed. Deterministic: the
 * socket is an emitter the test drives; no timers but the deadline (faked).
 */

class FakeRaw extends EventEmitter {
  destroyed = false;
  writableFinished = false;
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

function harness() {
  const raw = new FakeRaw();
  const outcomes: string[] = [];
  const sent: RedeemedExport[] = [];
  const redeemed: RedeemedExport = {
    artifactId: 'a',
    body: Buffer.from('{}'),
    filename: 'x.json',
    finalize: async (outcome) => {
      outcomes.push(outcome);
    },
  };
  const reply: TransferReply & { sendImpl: (r: RedeemedExport) => unknown } = {
    raw,
    sendImpl: (r) => {
      sent.push(r);
      raw.writableFinished = true;
      raw.emit('finish');
      raw.emit('close');
    },
    send(r) {
      return this.sendImpl(r);
    },
  };
  return { raw, reply, redeemed, outcomes, sent };
}

afterEach(() => vi.useRealTimers());

describe('transferExport (PR #677 A-F-02)', () => {
  it('a disconnect during redemption reaches the service as an aborted signal', async () => {
    const h = harness();
    let seen: AbortSignal | undefined;
    await transferExport(
      h.reply,
      (clientGone) =>
        new Promise((resolve) => {
          seen = clientGone;
          h.raw.destroy(); // the client leaves while storage is still being read
          resolve(h.redeemed);
        }),
      60_000,
    );
    expect(seen?.aborted).toBe(true);
  });

  it('an admitted transfer whose client already left is finalized aborted once, with no send', async () => {
    const h = harness();
    await transferExport(
      h.reply,
      (clientGone) =>
        new Promise((resolve) => {
          h.raw.destroy();
          expect(clientGone.aborted).toBe(true);
          resolve(h.redeemed); // the service consumed before it could look
        }),
      60_000,
    );
    expect(h.sent).toEqual([]);
    expect(h.outcomes).toEqual(['aborted']);
    h.raw.emit('close'); // a late close changes nothing
    expect(h.outcomes).toEqual(['aborted']);
  });

  it('a socket already destroyed before redemption starts is treated the same', async () => {
    const h = harness();
    h.raw.destroyed = true;
    await transferExport(h.reply, async () => h.redeemed, 60_000);
    expect(h.sent).toEqual([]);
    expect(h.outcomes).toEqual(['aborted']);
  });

  it('a service that refused to consume a gone client ends the transfer quietly', async () => {
    const h = harness();
    await expect(
      transferExport(
        h.reply,
        async () => {
          h.raw.destroy();
          throw new ExportClientGoneError();
        },
        60_000,
      ),
    ).resolves.toBeUndefined();
    expect(h.sent).toEqual([]);
    expect(h.outcomes).toEqual([]); // nothing was admitted, nothing to finalize
  });

  it('any other redemption error is rethrown and nothing is finalized', async () => {
    const h = harness();
    await expect(
      transferExport(
        h.reply,
        async () => {
          throw new Error('EXPORT_GONE');
        },
        60_000,
      ),
    ).rejects.toThrow('EXPORT_GONE');
    expect(h.outcomes).toEqual([]);
    expect(h.raw.listenerCount('close')).toBe(0);
  });

  it('a finished response finalizes completed exactly once', async () => {
    const h = harness();
    await transferExport(h.reply, async () => h.redeemed, 60_000);
    expect(h.sent).toEqual([h.redeemed]);
    expect(h.outcomes).toEqual(['completed']);
  });

  it('a close before finish finalizes aborted exactly once', async () => {
    const h = harness();
    h.reply.sendImpl = () => {
      h.raw.emit('close'); // the peer went away mid-body
    };
    await transferExport(h.reply, async () => h.redeemed, 60_000);
    expect(h.outcomes).toEqual(['aborted']);
    h.raw.emit('error');
    expect(h.outcomes).toEqual(['aborted']);
  });

  it('a send that throws destroys the socket and finalizes aborted once', async () => {
    const h = harness();
    h.reply.sendImpl = () => {
      throw new Error('setup failed');
    };
    await transferExport(h.reply, async () => h.redeemed, 60_000);
    expect(h.raw.destroyed).toBe(true);
    expect(h.outcomes).toEqual(['aborted']);
  });

  it('the deadline destroys an unfinished response and finalizes aborted once', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.reply.sendImpl = () => undefined; // bytes never finish leaving
    await transferExport(h.reply, async () => h.redeemed, 1_000);
    expect(h.outcomes).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(h.raw.destroyed).toBe(true);
    expect(h.outcomes).toEqual(['aborted']);
  });

  it('the deadline is cleared by completion', async () => {
    vi.useFakeTimers();
    const h = harness();
    await transferExport(h.reply, async () => h.redeemed, 1_000);
    vi.advanceTimersByTime(5_000);
    expect(h.raw.destroyed).toBe(false);
    expect(h.outcomes).toEqual(['completed']);
  });
});

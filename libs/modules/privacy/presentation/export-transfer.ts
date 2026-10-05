import { ExportClientGoneError, type RedeemedExport } from '../application/privacy-export.service';

/** What the transfer needs from the raw response: `http.ServerResponse` satisfies it. */
export type TransferSocket = {
  readonly destroyed: boolean;
  readonly writableFinished: boolean;
  destroy(): unknown;
  once(event: 'close' | 'finish' | 'error', listener: () => void): unknown;
  off(event: 'close' | 'finish' | 'error', listener: () => void): unknown;
};

/** What the transfer needs from the reply: a Fastify reply satisfies it. */
export type TransferReply = {
  readonly raw: TransferSocket;
  send(redeemed: RedeemedExport): unknown;
};

/**
 * GoGo-BE#256, PR #677 A-F-02 — the one admitted transfer of a redeemed export.
 *
 * The transport's whole job is to report, exactly once, whether the bytes left
 * the server; `finalize` zeroes the plaintext, releases the download slot and
 * records the outcome. Every way the transfer can end funnels through `settle`:
 *
 * - the client leaves while redemption is still being decided — observed by a
 *   listener attached *before* `redeem` is awaited, so a `close` that fires
 *   during the storage fetch is seen and not missed. The service is told via
 *   the signal and refuses to consume (`ExportClientGoneError`: nothing to
 *   finalize, nobody to answer). If it consumed before it could look, the
 *   transfer is finalized `aborted` here, immediately, without a send;
 * - the response finishes: `completed`;
 * - the response closes unfinished, errors, or the setup/send throws: `aborted`;
 * - the deadline passes: the socket is destroyed and the outcome is `aborted`.
 */
export async function transferExport(
  reply: TransferReply,
  redeem: (clientGone: AbortSignal) => Promise<RedeemedExport>,
  deadlineMs: number,
): Promise<void> {
  const raw = reply.raw;
  const gone = new AbortController();
  const onEarlyClose = () => gone.abort();
  raw.once('close', onEarlyClose);
  if (raw.destroyed) gone.abort();

  let redeemed: RedeemedExport;
  try {
    redeemed = await redeem(gone.signal);
  } catch (err) {
    raw.off('close', onEarlyClose);
    if (err instanceof ExportClientGoneError) return;
    throw err;
  }
  raw.off('close', onEarlyClose);

  let settled = false;
  // A transfer admitted before expiry or revocation gets this long, no more.
  const deadline = setTimeout(() => {
    if (!raw.writableFinished) raw.destroy();
    settle(raw.writableFinished ? 'completed' : 'aborted');
  }, deadlineMs);
  (deadline as { unref?: () => void }).unref?.();
  const settle = (outcome: 'completed' | 'aborted') => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    void redeemed.finalize(outcome).catch(() => undefined);
  };

  if (gone.signal.aborted || raw.destroyed) {
    settle('aborted');
    return;
  }

  raw.once('finish', () => settle('completed'));
  raw.once('close', () => settle(raw.writableFinished ? 'completed' : 'aborted'));
  raw.once('error', () => settle('aborted'));

  try {
    await reply.send(redeemed);
  } catch {
    raw.destroy();
    settle('aborted');
  }
}

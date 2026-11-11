import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
export type PlaceQaReadOptions = Readonly<{ signal?: AbortSignal; deadlineAt?: number }>;

export class PlaceQaReadError extends Error {
  constructor(readonly reason: 'timeout' | 'cancelled' | 'read_error') {
    super(`Place QA read ${reason}`);
  }
}

/** Never propagate Drizzle's SQL/parameter-bearing error into assistant logging. */
export function safePlaceQaReadError(error: unknown): PlaceQaReadError {
  if (error instanceof PlaceQaReadError) return error;
  const database = error as { code?: string; cause?: { code?: string } } | null;
  return new PlaceQaReadError(
    database?.code === '57014' || database?.cause?.code === '57014' ? 'timeout' : 'read_error',
  );
}

/**
 * Includes pool acquisition in the total budget. Abort/deadline destroys the
 * checked-out connection: an in-flight read cannot return to the pool with a
 * live transaction or altered thresholds. statement_timeout also bounds server
 * work. There is no retry and no error-to-empty conversion.
 */
export async function placeQaRead<T>(
  db: Db,
  budgetMs: number,
  options: PlaceQaReadOptions,
  work: (read: Pick<Db, 'execute'>) => Promise<T>,
): Promise<T> {
  const deadline = Math.min(Date.now() + budgetMs, options.deadlineAt ?? Infinity);
  if (options.signal?.aborted) throw new PlaceQaReadError('cancelled');
  if (deadline <= Date.now()) throw new PlaceQaReadError('timeout');
  let stop: (() => void) | undefined;
  let stopped: PlaceQaReadError | undefined;
  let rejectStop: (error: Error) => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectStop = reject;
  });
  const abort = (reason: 'timeout' | 'cancelled') => {
    stopped = new PlaceQaReadError(reason);
    stop?.();
    rejectStop(stopped);
  };
  const onAbort = () => abort('cancelled');
  const timer = setTimeout(() => abort('timeout'), Math.max(1, deadline - Date.now()));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const task = (async () => {
    const client = await db.$client.connect();
    let released = false;
    const release = (destroy: boolean) => {
      if (!released) {
        released = true;
        client.release(destroy);
      }
    };
    stop = () => release(true);
    if (stopped) {
      release(true);
      throw stopped;
    }
    const read = drizzle(client, { schema });
    try {
      await read.execute(sql`begin read only`);
      const remaining = Math.max(1, deadline - Date.now());
      await read.execute(sql`select set_config('statement_timeout', ${String(remaining)}, true)`);
      const result = await work(read);
      if (stopped) throw stopped;
      await read.execute(sql`commit`);
      return result;
    } catch (error) {
      if (!released) {
        try {
          await read.execute(sql`rollback`);
        } catch {
          release(true);
        }
      }
      throw error;
    } finally {
      release(false);
    }
  })();
  try {
    return await Promise.race([task, interrupted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

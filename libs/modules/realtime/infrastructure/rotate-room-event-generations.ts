import IORedis from 'ioredis';

/** Structural slice of ioredis the rotation needs. */
export type RotationClient = {
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<number>;
};

export type RotationResult = { matched: number; deleted: number; keys: string[] };

const META_PATTERN = 'room:{*}:v2:meta';
const metaKeyOf = (roomId: string) => `room:{${roomId}}:v2:meta`;

/**
 * ADR-0027 — rotate room event generations after a Redis restore or failover.
 *
 * A restored (or asynchronously replicated) Redis can bring back a metadata
 * hash whose `seq` is behind what clients already hold, so the same
 * `(generation, seq)` would name a different event. Deleting the metadata is
 * the rotation: the next publish or attach creates a fresh generation and
 * discards the orphaned buffer, and every client holding an old cursor gets
 * `resync` (`generation_changed`) instead of a silently wrong replay.
 *
 * Dry run unless `execute`. Touches only `room:{*}:v2:meta` keys.
 */
export async function rotateRoomEventGenerations(
  client: RotationClient,
  options: { roomId?: string; execute: boolean; batch?: number },
): Promise<RotationResult> {
  const keys: string[] = [];
  if (options.roomId) {
    keys.push(metaKeyOf(options.roomId));
  } else {
    let cursor = '0';
    do {
      const [next, found] = await client.scan(
        cursor,
        'MATCH',
        META_PATTERN,
        'COUNT',
        options.batch ?? 500,
      );
      cursor = next;
      keys.push(...found);
    } while (cursor !== '0');
  }
  const unique = [...new Set(keys)];
  let deleted = 0;
  if (options.execute) {
    for (let i = 0; i < unique.length; i += 500) {
      deleted += await client.del(...unique.slice(i, i + 500));
    }
  }
  return { matched: unique.length, deleted, keys: unique };
}

/** CLI entry: opens its own connection, rotates, closes. */
export async function runRoomEventGenerationRotation(options: {
  url: string;
  roomId?: string;
  execute: boolean;
}): Promise<RotationResult> {
  const client = new IORedis(options.url, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await client.connect();
    // ioredis types `scan` as overloads; the structural slice is what is used.
    return await rotateRoomEventGenerations(client as unknown as RotationClient, options);
  } finally {
    client.disconnect();
  }
}

/**
 * ADR-0027 — rotate room event generations after any Redis restore or
 * failover (runbook: docs/runbooks.md §4, "Redis restore / failover").
 *
 * Dry run is the default; deleting requires `--execute`.
 *
 *   REDIS_URL=… pnpm realtime:rotate-generations                 # count only
 *   REDIS_URL=… pnpm realtime:rotate-generations --execute       # every room
 *   REDIS_URL=… pnpm realtime:rotate-generations --execute --room <uuid>
 *
 * Prints counts only — never key contents.
 */
import { runRoomEventGenerationRotation } from '@gogo/modules';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required');
  const roomId = flag('room');
  if (roomId && !/^[0-9a-f-]{36}$/.test(roomId)) throw new Error('--room must be a room uuid');
  const execute = process.argv.includes('--execute');
  const result = await runRoomEventGenerationRotation({
    url,
    execute,
    ...(roomId ? { roomId } : {}),
  });
  process.stdout.write(
    `${JSON.stringify({ mode: execute ? 'execute' : 'dry-run', matched: result.matched, deleted: result.deleted })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

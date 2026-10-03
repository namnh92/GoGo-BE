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
import { parseRotationArgs } from './rotate-room-event-generations-args';

async function main(): Promise<void> {
  // Arguments first: a bad invocation never opens a connection.
  const args = parseRotationArgs(process.argv.slice(2));
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required');
  const result = await runRoomEventGenerationRotation({ url, ...args });
  process.stdout.write(
    `${JSON.stringify({ mode: args.execute ? 'execute' : 'dry-run', matched: result.matched, deleted: result.deleted })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

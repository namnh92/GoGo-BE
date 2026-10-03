/**
 * Arguments of `pnpm realtime:rotate-generations`. Strict on purpose: the
 * command deletes, and a `--room` whose value went missing (an empty shell
 * variable) must fail loudly, never widen to every room.
 */
export type RotationArgs = { execute: boolean; roomId?: string };

const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseRotationArgs(argv: string[]): RotationArgs {
  let execute = false;
  let roomId: string | undefined;
  let roomSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--execute') {
      execute = true;
    } else if (arg === '--room') {
      if (roomSeen) throw new Error('--room given twice');
      roomSeen = true;
      const value = argv[i + 1];
      if (value === undefined || !ROOM_ID.test(value)) {
        throw new Error('--room needs a room uuid (refusing to rotate every room)');
      }
      roomId = value;
      i++;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return roomId ? { execute, roomId } : { execute };
}

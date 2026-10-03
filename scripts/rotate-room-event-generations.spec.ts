import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRotationArgs } from './rotate-room-event-generations-args';

const ROOM = '0f8b2a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const repoRoot = path.resolve(__dirname, '..');

describe('realtime:rotate-generations arguments (PR #666 F-05)', () => {
  it('accepts dry run, execute, and one room', () => {
    expect(parseRotationArgs([])).toEqual({ execute: false });
    expect(parseRotationArgs(['--execute'])).toEqual({ execute: true });
    expect(parseRotationArgs(['--execute', '--room', ROOM])).toEqual({
      execute: true,
      roomId: ROOM,
    });
  });

  it.each([
    ['--room with no value', ['--execute', '--room']],
    ['--room with an empty value', ['--execute', '--room', '']],
    ['--room followed by another flag', ['--room', '--execute']],
    ['--room with a non-uuid', ['--execute', '--room', 'abc']],
    ['--room twice', ['--room', ROOM, '--room', ROOM]],
    ['an unknown flag', ['--execute', '--rooms', ROOM]],
    ['a stray positional', ['--execute', ROOM]],
  ])('refuses %s instead of rotating every room', (_label, argv) => {
    expect(() => parseRotationArgs(argv)).toThrow();
  });

  it('the CLI exits non-zero on an empty --room before touching Redis', () => {
    const run = spawnSync(
      'node',
      [
        '-r',
        '@swc-node/register',
        'scripts/rotate-room-event-generations.ts',
        '--execute',
        '--room',
        '',
      ],
      {
        cwd: repoRoot,
        // Unreachable on purpose: reaching it would mean the command tried to rotate.
        env: {
          ...process.env,
          REDIS_URL: 'redis://127.0.0.1:1',
          SWC_NODE_PROJECT: './tsconfig.base.json',
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('--room needs a room uuid');
  }, 90_000);
});

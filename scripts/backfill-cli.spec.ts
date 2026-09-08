import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #491 — the backfill CLI's cheap half.
 *
 * This runs `pnpm admin:backfill` — the command the runbook tells a person to
 * type — and checks that it loads and reaches its own guards. It costs a
 * process, not a container, so it runs in the unit project on every push.
 *
 * What it deliberately does **not** claim: it does not catch the missing-logger
 * defect this issue is about. That defect only shows up when a metric is
 * emitted, and no metric is emitted until the run has talked to the database —
 * a boot that stops at `DATABASE_URL is required` reaches the same guard with
 * the wiring broken or fixed. Measured, not assumed: with `new LogMetrics()`
 * restored, both assertions below still pass.
 *
 * The regression that actually fails on the defect is
 * `apps/api/test/administrative-backfill-cli.int.spec.ts`, which runs the CLI
 * against a real published dataset. The typecheck gate catches it too, and
 * earlier: `scripts/` is now in the graph, so `new LogMetrics()` is
 * `TS2554: Expected 1 arguments, but got 0` before anything runs.
 */
const ROOT = path.resolve(__dirname, '..');

/**
 * Through the pnpm script, not the file. The runner is part of the bootstrap:
 * `admin:backfill` ran under `tsx`, and tsx resolves a tsconfig per file by
 * walking up from that file — with no tsconfig.json at the repository root,
 * everything under libs/ compiled with `experimentalDecorators` off and the
 * command died on `Parameter decorators only work when experimental decorators
 * are enabled`, having reached no code of its own. Invoking the file directly
 * with a working runner would have hidden that.
 */
function boot(args: string[], env: Record<string, string | undefined>): string {
  try {
    return execFileSync('pnpm', ['--silent', 'admin:backfill', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

describe('the backfill CLI entry point', () => {
  it('loads and reaches its configuration guard', () => {
    // Reaching this message means the runner compiled the whole graph and every
    // import resolved in a real process: @gogo/database, @gogo/observability
    // and @gogo/modules.
    expect(boot([], { DATABASE_URL: undefined })).toContain('DATABASE_URL is required');
  }, 120_000);

  it('refuses --abandon without a reason, before it opens a connection', () => {
    // Argument validation past construction: the pool, the drizzle client, the
    // metrics port, the resolver and the service are all built before this
    // check, and the unreachable host proves none of them queried anything.
    const output = boot(['--abandon', '00000000-0000-4000-8000-000000000000'], {
      DATABASE_URL: 'postgres://user:pw@127.0.0.1:1/none',
    });
    expect(output).toContain('--abandon requires --reason');
  }, 120_000);
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #588 — the boundary in `libs/observability/src/sentry.ts` holds only while nothing else feeds Sentry.
 * A new import of the SDK, or a new call that attaches data (`setContext`,
 * `setExtra`, `setTag`, `setUser`, `addBreadcrumb`, `captureMessage`, …), must
 * come through a review of that boundary; this test is what makes it fail.
 */

const ROOT = path.resolve(__dirname, '../../..');
const ALLOWED: Record<string, RegExp[]> = {
  'libs/observability/src/sentry.ts': [
    /Sentry\.getDefaultIntegrations\(\{\}\)/,
    /Sentry\.httpIntegration\(\{ maxIncomingRequestBodySize: 'none' \}\)/,
    /Sentry\.onUnhandledRejectionIntegration\(\{ mode: 'strict' \}\)/,
  ],
  'apps/api/src/main.ts': [/Sentry\.init\(sentryInitOptions\(/],
  // BE#675 — the worker's init, its job-failure capture (job name only) and flush.
  'apps/worker/src/sentry.ts': [
    /Sentry\.init\(\s*sentryInitOptions\(\{ dsn, environment: env\.APP_ENV \?\? 'dev', unhandledRejection: 'strict' \}\),?\s*\)/,
    /Sentry\.captureException\(err, \{ tags: \{ periodic_job: job \} \}\)/,
    /else Sentry\.captureException\(err\);/,
    /Sentry\.flush\(2_000\)/,
  ],
  'apps/api/src/common/filters/app-exception.filter.ts': [
    /Sentry\.captureException\(exception, \{ extra: \{ request_id: requestId \} \}\)/,
  ],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (['node_modules', 'dist', 'test', 'coverage'].includes(name)) return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(name) && !/\.spec\.|\.int\.spec\./.test(name)
      ? [full]
      : [];
  });
}

describe('Sentry is used only through the #588 boundary', () => {
  const files = ['apps', 'libs'].flatMap((dir) => sourceFiles(path.join(ROOT, dir)));

  it('imports the SDK only in the allowed files', () => {
    const importers = files
      .filter((file) =>
        /from ['"]@sentry\/|require\(['"]@sentry\//.test(readFileSync(file, 'utf8')),
      )
      .map((file) => path.relative(ROOT, file))
      .sort();
    expect(importers).toEqual(Object.keys(ALLOWED).sort());
  });

  it('makes only the allowed calls, in the allowed shape', () => {
    for (const [file, shapes] of Object.entries(ALLOWED)) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      const calls = [...text.matchAll(/Sentry\.(\w+)\(/g)].map((match) => match[0]);
      expect(calls, file).toHaveLength(shapes.length);
      for (const shape of shapes) expect(text, file).toMatch(shape);
    }
  });
});

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC (not esbuild) so NestJS decorator metadata is emitted for DI.
const swcPlugin = swc.vite({
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: 'es2022',
  },
  module: { type: 'es6' },
});

const inlineWorkspaceDeps = { deps: { inline: [/@gogo\//] } };

export default defineConfig({
  plugins: [swcPlugin],
  test: {
    projects: [
      {
        plugins: [swcPlugin],
        test: {
          name: 'unit',
          include: ['apps/**/*.spec.ts', 'libs/**/*.spec.ts', 'scripts/**/*.spec.ts'],
          exclude: ['**/*.int.spec.ts', '**/node_modules/**', '**/dist/**'],
          environment: 'node',
          server: inlineWorkspaceDeps,
        },
      },
      {
        plugins: [swcPlugin],
        test: {
          name: 'integration',
          include: ['**/*.int.spec.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 180_000,
          // GoGo-BE#632: every integration spec stops its own Postgres container
          // in `afterAll`, and a pool that loses its server mid-teardown emits
          // `57P01`. With no listener that is an unhandled error, and vitest
          // fails the run even when every test passed. This attaches the handler
          // pg asks for, once, and it re-throws anything that is not teardown.
          setupFiles: ['./apps/api/test/support/pg-shutdown.ts'],
          // GoGo-BE#632: every integration spec stops its own Postgres container
          // in `afterAll`, and a pool that loses its server mid-teardown emits
          // `57P01`. With no listener that is an unhandled error, and vitest
          // fails the run even when every test passed. This attaches the handler
          // pg asks for, once, and it re-throws anything that is not teardown.
          server: inlineWorkspaceDeps,
        },
      },
    ],
  },
});

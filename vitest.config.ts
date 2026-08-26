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
          include: ['apps/**/*.spec.ts', 'libs/**/*.spec.ts'],
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
          server: inlineWorkspaceDeps,
        },
      },
    ],
  },
});

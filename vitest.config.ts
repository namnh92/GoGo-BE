import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['apps/**/*.spec.ts', 'libs/**/*.spec.ts'],
          exclude: ['**/*.int.spec.ts', '**/node_modules/**', '**/dist/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['**/*.int.spec.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});

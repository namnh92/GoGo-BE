import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.js',
      '**/*.mjs',
      'migrations/**',
      'openapi/gogo.v1.d.ts',
      // Built by `pnpm artifacts`, published by CI, never committed.
      'artifacts/**',
      // k6 scripts: a k6 runtime, not Node — see load/README.md.
      'load/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'vitest.config.ts',
            'drizzle.config.ts',
            'scripts/check-route-coverage.ts',
            'scripts/check-package-boundaries.ts',
            'scripts/build-artifacts.ts',
            'scripts/artifacts.spec.ts',
            'scripts/check-openapi-version.ts',
            'scripts/check-openapi-version.spec.ts',
          ],
        },
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.test.ts', '**/test/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // CLI checks: printing the result is the whole point.
    files: ['scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);

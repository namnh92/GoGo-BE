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
          // `scripts/` has its own tsconfig, so nothing under it needs the
          // default project. What is left is the two config files at the root,
          // which no tsconfig includes and which typescript-eslint caps at
          // eight before it starts costing lint time.
          allowDefaultProject: ['vitest.config.ts', 'drizzle.config.ts'],
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

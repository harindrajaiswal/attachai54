import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      'dist/**',
      'data/**',
      'test-results.json',
      'dashboard/e2e/**',
      'dashboard/playwright.config.ts',
      'dashboard/vite.config.ts',
      'public/admin/**',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: { parser, parserOptions: { project: './tsconfig.json' } },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];

import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['src/**/*.{ts,tsx}'],
  extends: [...tseslint.configs.recommended],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
});

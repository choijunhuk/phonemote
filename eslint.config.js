import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * `any` is banned project-wide. The rule that keeps game scenes off raw sensor
 * frames (ARCHITECTURE.md P4) is added in Phase 3, when scenes exist.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'certs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['apps/controller/**/*.ts', 'apps/game/**/*.ts'],
    ignores: ['**/vite.config.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['apps/server/**/*.ts', '**/vite.config.ts', 'scripts/**/*.js'],
    languageOptions: { globals: globals.node },
  },
);

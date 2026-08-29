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
  {
    // ARCHITECTURE.md P4: scenes consume GameAction and nothing upstream of it.
    // A scene that reaches for a SensorFrame has skipped the normaliser, which
    // is exactly the bug this whole layering exists to prevent.
    files: ['apps/game/src/scenes/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@phonemote/protocol',
              message:
                'Scenes must not touch the wire format. Consume GameAction from the input layer instead (ARCHITECTURE.md P4).',
            },
          ],
          patterns: [
            {
              group: ['**/SensorNormalizer*', '**/InputMapper*', '**/net/*'],
              message:
                'Scenes must not reach into the input or network plumbing (ARCHITECTURE.md P4).',
            },
          ],
        },
      ],
    },
  },
);

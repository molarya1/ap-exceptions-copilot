import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', '.local/', 'data/', 'cache/', 'recorded/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: { document: 'readonly', window: 'readonly', fetch: 'readonly', location: 'readonly', history: 'readonly' } },
  },
  {
    // The agent proposes; only the HTTP layer may approve. Enforced at import level.
    files: ['src/agent/**/*.ts', 'src/extract/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/work/approvals', '**/work/capability', '**/server/**'], message: 'Agent code must not reach approval or HTTP code.' }] }],
    },
  },
);

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', '.local/', 'data/', 'cache/', 'recorded/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: { document: 'readonly', window: 'readonly', fetch: 'readonly', location: 'readonly', Node: 'readonly', setTimeout: 'readonly' } },
  },
  {
    // Only the HTTP layer may mint a human capability.
    files: ['src/**/*.ts'],
    ignores: ['src/server/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/work/capability'], importNames: ['mintCapability'], message: 'Only src/server may mint a human capability.' }] }],
    },
  },
  {
    // The agent proposes; only the HTTP layer may approve. Enforced at import level.
    files: ['src/agent/**/*.ts', 'src/extract/**/*.ts', 'src/llm/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/work/approvals', '**/work/capability', '**/server/**'], message: 'Agent code must not reach approval or HTTP code.' }] }],
    },
  },
);

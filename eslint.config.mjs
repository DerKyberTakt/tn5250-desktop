import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '*.vsix'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'esbuild.mjs'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    // The protocol engine must stay portable: no VS Code, Node or DOM imports.
    files: ['src/engine/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['vscode', 'node:*', 'net', 'tls', 'fs', 'path'] }],
    },
  },
);

// ESLint flat config (ESLint 9). Lints server JS (CommonJS), browser JS, and tests.
// Prettier owns formatting; eslint-config-prettier disables stylistic rules here.
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'coverage/**',
      'PLAN/**',
      '**/*.min.js',
      // Mutation-testing output (#199): Stryker sandboxes hold instrumented copies
      // of the whole tree; a leftover sandbox must never fail lint.
      '.stryker-tmp/**',
      'reports/**',
    ],
  },
  js.configs.recommended,
  {
    // Server code + root config files: Node CommonJS.
    files: ['src/**/*.js', 'scripts/**/*.js', 'config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    // Browser code shipped to guests.
    files: ['src/public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Tests: Vitest globals (globals:true in vitest config).
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    // Pre-existing nits the refactor's lint-cleanup pass will resolve (tracked as
    // its own issue). Kept as warnings so CI stays green and the signal is visible
    // rather than suppressed.
    rules: {
      'no-useless-escape': 'warn',
    },
  },
  prettier,
];

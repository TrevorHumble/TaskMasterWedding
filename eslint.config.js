// ESLint flat config (ESLint 10). Lints server JS (CommonJS), browser JS, and tests.
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
      // Leftover build-session worktrees (#319): a nested worktree under
      // .claude/worktrees/ holds its own full source copy on its own branch;
      // linting it duplicates (and can misattribute) findings that belong to
      // that worktree's own `npm run lint`, not this checkout's.
      '.claude/worktrees/**',
      // Antigravity/Gemini agent session worktrees (#822): same rationale as
      // .claude/worktrees/** above — a nested worktree holds its own full
      // source copy on its own branch, so linting it here duplicates findings.
      '.agents/worktrees/**',
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
      // caughtErrors keeps its 'all' default here on purpose: server files use
      // the parameterless `catch {}` (Node >= 20), so no '^_' escape is offered
      // for caught errors. See DESIGN.md § "Lint is a ratchet (#973)".
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
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
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
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
  prettier,
];

import eslintGeneralConfig from '@limina/eslint-config';
import {
  baseTestFileRules,
  testFilePatterns,
} from '@limina/eslint-config/config';
import {
  createLoggerPlugin,
  portablePathPlugin,
} from '@limina/eslint-config/plugins';
import { rootFileConfigs } from '@limina/eslint-config/presets';
import { defineConfig } from 'eslint/config';

const liminaTestFilePatterns = [
  ...testFilePatterns,
  'packages/limina/integration/**/*.ts',
  'packages/migrate/integration/**/*.ts',
  'smoke/**/*.ts',
];

export default defineConfig([
  {
    ignores: ['packages/limina/fixtures/**'],
  },
  ...eslintGeneralConfig,
  ...rootFileConfigs,

  {
    files: [
      'packages/limina/src/**',
      'packages/migrate/src/**',
      'packages/migrate/integration/**',
      'packages/migrate/bin/**',
      'packages/migrate/*.{ts,mts,mjs}',
      'packages/limina/integration/**',
      'smoke/**',
      'packages/limina/bin/**',
      'packages/limina/*.{ts,mts,mjs}',
    ],
    rules: {
      '@typescript-eslint/no-inferrable-types': 'off',
      complexity: ['warn', { max: 40 }],
      'no-console': 'off',
      'no-restricted-syntax': 'off',
      'unicorn/consistent-destructuring': 'off',
      'unicorn/consistent-function-scoping': 'off',
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/no-array-sort': 'off',
      'unicorn/no-await-expression-member': 'off',
      'unicorn/no-object-as-default-parameter': 'off',
      'unicorn/prefer-spread': 'off',
    },
  },
  {
    files: liminaTestFilePatterns,
    plugins: {
      '@limina/portable-path': portablePathPlugin,
    },
    rules: {
      ...baseTestFileRules,
      '@limina/portable-path/portable-path-comparison': 'error',
      'max-params': 'off',
      'unicorn/better-regex': 'off',
    },
  },
  {
    name: 'Limina production readability budgets',
    files: ['packages/limina/src/**/*.ts', 'packages/migrate/src/**/*.ts'],
    ignores: testFilePatterns,
    rules: {
      complexity: ['error', 3],
      'max-depth': ['error', 3],
      'max-lines-per-function': ['error', 100],
      'max-lines': ['error', 300],
      'max-params': ['error', 3],
    },
  },
  {
    name: 'Limina cohesive worker and graph algorithm budgets',
    files: [
      'packages/limina/src/execution/pool.ts',
      'packages/limina/src/utils/strongly-connected-components.ts',
    ],
    rules: {
      complexity: ['error', 8],
    },
  },
  {
    name: 'Limina cohesive terminal state machine budget',
    files: ['packages/limina/src/flow/terminal-position.ts'],
    rules: {
      complexity: ['error', 20],
    },
  },
  {
    files: ['scripts/**/*.ts'],
    rules: {
      complexity: ['warn', { max: 40 }],
      'max-lines': [
        'warn',
        { max: 1200, skipBlankLines: true, skipComments: true },
      ],
      'max-lines-per-function': [
        'warn',
        { max: 240, skipBlankLines: true, skipComments: true },
      ],
      'n/no-unsupported-features/node-builtins': 'off',
      'no-restricted-syntax': 'off',
      'no-void': 'off',
      'prefer-template': 'off',
      'regexp/no-super-linear-backtracking': 'off',
      'regexp/prefer-character-class': 'off',
      'sort-imports': 'off',
      'unicorn/better-regex': 'off',
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/no-array-sort': 'off',
      'unicorn/no-await-expression-member': 'off',
      'unicorn/prefer-single-call': 'off',
      'unicorn/prefer-ternary': 'off',
      'unicorn/switch-case-braces': 'off',
    },
  },
  {
    files: ['packages/build-tools/src/{package-plugin,path,logger}.ts'],
    rules: { 'no-restricted-syntax': 'off', 'no-console': 'off' },
  },
  {
    files: ['packages/build-tools/src/license.ts'],
    plugins: { '@limina/license': createLoggerPlugin },
    rules: {
      '@limina/license/unified-log-entry': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },
  {
    // This local adapter takes over the old utils/env module's environment ownership.
    files: ['docs/.vitepress/build-metadata.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]);

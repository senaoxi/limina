import eslintGeneralConfig from '@docs-islands/eslint-config';
import {
  baseTestFileRules,
  testFilePatterns,
} from '@docs-islands/eslint-config/config';
import { portablePathPlugin } from '@docs-islands/eslint-config/plugins';
import { defineConfig } from 'eslint/config';

const liminaTestFilePatterns = [
  ...testFilePatterns,
  'integration/**/*.ts',
  'smoke/**/*.ts',
];

export default defineConfig([
  {
    ignores: ['fixtures/**'],
  },
  ...eslintGeneralConfig,

  {
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
      '@docs-islands/portable-path': portablePathPlugin,
    },
    rules: {
      ...baseTestFileRules,
      '@docs-islands/portable-path/portable-path-comparison': 'error',
      'max-params': 'off',
      'unicorn/better-regex': 'off',
    },
  },
  {
    name: 'Limina production readability budgets',
    files: ['src/**/*.ts'],
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
      'src/execution/pool.ts',
      'src/utils/strongly-connected-components.ts',
    ],
    rules: {
      complexity: ['error', 8],
    },
  },
  {
    name: 'Limina cohesive terminal state machine budget',
    files: ['src/flow/terminal-position.ts'],
    rules: {
      complexity: ['error', 20],
    },
  },
]);
